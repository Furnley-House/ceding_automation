// backend/src/services/workdrive.ts
// Upload files (call recordings, transcripts, generated PDFs) to Zoho WorkDrive.
import axios from 'axios';
import FormData from 'form-data';
import { getZohoAccessToken, getContactRecord, extractContactWorkDriveFolderId } from './zohoCrm';

// Read env at call-time, not module-load, so .env edits are picked up without rebuilding
const workdriveApiBase = () => process.env.ZOHO_WORKDRIVE_API_BASE ?? 'https://www.zohoapis.eu/workdrive/api/v1';

// Optional org-wide fallback for call-recording uploads when no per-case
// folder is supplied. Stage 9 exports do NOT use this — they resolve a
// per-client folder via resolveCaseFolderId() and hard-fail if it's missing.
// Returns the configured value or null; callers decide how to handle null.
const envFolderId = (): string | null => {
  const fromEnv = process.env.ZOHO_WORKDRIVE_FOLDER_ID;
  if (!fromEnv) return null;
  if (fromEnv.startsWith('your-') || fromEnv.startsWith('PLACEHOLDER')) return null;
  return fromEnv;
};

// Per-client WorkDrive folder resolution for Stage 9 exports. The folder
// lives on Contact.Client_Record_Folder_ID — each client gets a dedicated
// folder in WorkDrive, populated on the Contact by CRM workflows.
//
// Behaviour is gated by WORKDRIVE_REQUIRE_PER_CLIENT_FOLDER:
//   - "true"  (prod)              → hard-fail with a discriminated error if
//                                   the Contact has no Client_Record_Folder_ID.
//                                   Forces CAs to fix the data in Zoho rather
//                                   than dumping the export in a shared folder.
//   - "false" / unset (staging)   → fall back to ZOHO_WORKDRIVE_FOLDER_ID env
//                                   var, preserving the pre-existing behaviour
//                                   so test data without the Contact field
//                                   keeps working.
//
// Either way we *prefer* the per-client folder when it's populated; the flag
// only changes what happens when the field is empty / Contact is missing.
export interface ResolvedFolder {
  folderId: string;
  source: 'contact' | 'env-fallback';
  contactZohoId: string | null;
}
export class WorkDriveFolderResolutionError extends Error {
  readonly code: 'NO_CLIENT_ZOHO_ID' | 'CONTACT_NOT_FOUND' | 'FOLDER_FIELD_EMPTY';
  readonly contactZohoId: string | null;
  constructor(
    code: 'NO_CLIENT_ZOHO_ID' | 'CONTACT_NOT_FOUND' | 'FOLDER_FIELD_EMPTY',
    contactZohoId: string | null,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.contactZohoId = contactZohoId;
    this.name = 'WorkDriveFolderResolutionError';
  }
}

const perClientRequired = (): boolean =>
  String(process.env.WORKDRIVE_REQUIRE_PER_CLIENT_FOLDER).toLowerCase() === 'true';

export async function resolveCaseFolderId(clientZohoId: string | null): Promise<ResolvedFolder> {
  // Try the per-client folder first — always preferred when available.
  if (clientZohoId) {
    const contact = await getContactRecord(clientZohoId).catch(() => null);
    if (contact) {
      const folderId = extractContactWorkDriveFolderId(contact);
      if (folderId) {
        return { folderId, source: 'contact', contactZohoId: clientZohoId };
      }
    } else if (perClientRequired()) {
      // Strict mode: missing Contact is a fail-stop, no silent fallback.
      throw new WorkDriveFolderResolutionError(
        'CONTACT_NOT_FOUND',
        clientZohoId,
        `Zoho Contact ${clientZohoId} not found. Check the case's clientZohoId or refresh from Zoho.`,
      );
    }
  }

  if (perClientRequired()) {
    if (!clientZohoId) {
      throw new WorkDriveFolderResolutionError(
        'NO_CLIENT_ZOHO_ID',
        null,
        "Case has no linked Zoho Contact (clientZohoId is null). Link the case to a Contact in Zoho before exporting.",
      );
    }
    throw new WorkDriveFolderResolutionError(
      'FOLDER_FIELD_EMPTY',
      clientZohoId,
      `Zoho Contact ${clientZohoId} has no Client_Record_Folder_ID set. Populate that field on the Contact in Zoho and retry.`,
    );
  }

  // Lenient mode (staging / local) — fall back to the org-wide env folder.
  const envFallback = envFolderId();
  if (!envFallback) {
    // Lenient mode but no env fallback either — surface the same
    // FOLDER_FIELD_EMPTY error so the caller's 422 handler kicks in cleanly.
    throw new WorkDriveFolderResolutionError(
      'FOLDER_FIELD_EMPTY',
      clientZohoId,
      `No WorkDrive folder available: Contact.Client_Record_Folder_ID is empty and ZOHO_WORKDRIVE_FOLDER_ID env fallback is not set.`,
    );
  }
  return { folderId: envFallback, source: 'env-fallback', contactZohoId: clientZohoId };
}

export interface WorkDriveUploadResult {
  id: string;
  name: string;
  permalink?: string;
  resourceId?: string;
}

export interface WorkDriveFile {
  id: string;
  name: string;
  extension?: string;
  sizeBytes?: number;
  /**
   * Display string only — WorkDrive returns "Aug 17, 11:09 AM", which
   * `new Date()` misparses as the year 2001. NEVER compare these. Use
   * createdTimeMs / modifiedTimeMs for anything time-based.
   */
  createdTime?: string;
  modifiedTime?: string;
  /** Epoch milliseconds, from created_time_in_millisecond. Safe to compare. */
  createdTimeMs?: number;
  modifiedTimeMs?: number;
  permalink?: string;
  downloadUrl?: string;
}

// List files in a WorkDrive folder. Folder ID must be supplied explicitly,
// either by the caller or via the ZOHO_WORKDRIVE_FOLDER_ID env fallback.
//
// The extension filter defaults to ['mp3'] so every pre-existing caller (the
// Stage 5 recordings panel) keeps its original behaviour untouched. The
// Palindrome poller passes its own list because the transcript artefact comes
// back as a document, not audio — see services/palindrome.ts.
// Pass an empty array to disable filtering entirely.
/** First argument that is a usable number, else undefined. */
function firstNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string') {
      const n = Number(c);
      if (Number.isFinite(n) && c.trim() !== '') return n;
    }
  }
  return undefined;
}

export interface ListWorkDriveFilesOptions {
  /** Lower-case extensions without the dot, e.g. ['txt','docx']. Default ['mp3']. */
  extensions?: string[];
}

export async function listWorkDriveFiles(
  folderId?: string,
  options: ListWorkDriveFilesOptions = {},
): Promise<WorkDriveFile[]> {
  const parentId = folderId ?? envFolderId();
  if (!parentId) {
    throw new Error('No WorkDrive folder ID supplied and ZOHO_WORKDRIVE_FOLDER_ID env fallback not configured');
  }
  const extensions = (options.extensions ?? ['mp3']).map((e) => e.toLowerCase().replace(/^\./, ''));

  const token = await getZohoAccessToken();
  const { data } = await axios.get(
    `${workdriveApiBase()}/files/${parentId}/files`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const items = ((data as { data?: Array<Record<string, unknown>> }).data ?? []);
  const mapped = items.map((it) => {
    const attrs = (it.attributes as Record<string, unknown>) ?? {};
    return {
      id: it.id as string,
      name: (attrs.name as string) ?? '',
      extension: attrs.extn as string | undefined,
      // WorkDrive reports size in several shapes depending on the endpoint:
      // storage_info.size (a formatted string like "5.6 MB" on some responses),
      // storage_info.size_in_bytes, or a bare size_in_bytes attribute. Take
      // the first that is actually a number so the UI never renders "NaN KB".
      sizeBytes: firstNumber(
        (attrs.storage_info as Record<string, unknown> | undefined)?.size_in_bytes,
        (attrs.storage_info as Record<string, unknown> | undefined)?.size,
        attrs.size_in_bytes,
        attrs.size,
      ),
      createdTime: attrs.created_time as string | undefined,
      modifiedTime: attrs.modified_time as string | undefined,
      createdTimeMs: attrs.created_time_in_millisecond as number | undefined,
      modifiedTimeMs: attrs.modified_time_in_millisecond as number | undefined,
      permalink: attrs.permalink as string | undefined,
      downloadUrl: attrs.download_url as string | undefined,
    };
  });

  if (extensions.length === 0) return mapped;
  return mapped.filter((f) => {
    const ext = (f.extension ?? '').toLowerCase();
    const name = f.name.toLowerCase();
    return extensions.some((want) => ext === want || name.endsWith(`.${want}`));
  });
}

// ── Folder creation ───────────────────────────────────────────────────────
// Ceding keeps call recordings and Palindrome's returned transcripts in their
// own per-case subfolders rather than dumping them into the client record
// folder alongside Stage 9 exports. That matters for more than tidiness: the
// recordings subfolder is what gets shared with Palindrome's account, so the
// narrower it is, the less client data we expose to an external processor.
export async function createWorkDriveFolder(
  parentFolderId: string,
  folderName: string,
): Promise<{ id: string; name: string }> {
  const token = await getZohoAccessToken();
  const body = {
    data: {
      attributes: { name: folderName, parent_id: parentFolderId },
      type: 'files',
    },
  };
  const { data } = await axios.post(`${workdriveApiBase()}/files`, body, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/json',
    },
  });
  // WorkDrive is inconsistent about the create response: sometimes
  // { data: [ { id, attributes } ] }, sometimes { data: { id, attributes } }.
  // Handle both, and fall back to resource_id inside attributes.
  const payload = (data as { data?: unknown })?.data;
  const first = (Array.isArray(payload) ? payload[0] : payload) as
    | Record<string, unknown>
    | undefined;
  const attrs = (first?.attributes as Record<string, unknown>) ?? {};

  return {
    id: (first?.id as string) ?? (attrs.resource_id as string) ?? '',
    name: (attrs.name as string) ?? folderName,
  };
}

// Find an existing child folder by name, or create it. Idempotent so the
// submit path can be re-run for a case without piling up duplicates.
export async function ensureWorkDriveFolder(
  parentFolderId: string,
  folderName: string,
): Promise<{ id: string; name: string; created: boolean }> {
  const token = await getZohoAccessToken();
  const { data } = await axios.get(
    `${workdriveApiBase()}/files/${parentFolderId}/files`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  );
  const items = ((data as { data?: Array<Record<string, unknown>> }).data ?? []);
  for (const it of items) {
    const attrs = (it.attributes as Record<string, unknown>) ?? {};
    const isFolder = attrs.is_folder === true || attrs.type === 'folder';
    if (isFolder && String(attrs.name ?? '') === folderName) {
      return { id: it.id as string, name: folderName, created: false };
    }
  }
  const made = await createWorkDriveFolder(parentFolderId, folderName);
  if (made.id) return { ...made, created: true };

  // Belt-and-braces: WorkDrive has been observed returning 201 for a folder
  // create without an id we can read. Re-list the parent to find what we just
  // made rather than handing back an empty id.
  //
  // This is not cosmetic. The id ends up on the Creator record as
  // Meeting_Recordings_Folder_ID / Meeting_Summary_Folder_ID, so an empty one
  // means Palindrome cannot write the transcript back — and it would only
  // ever bite on the FIRST submission for a client, because every later call
  // finds the folder by listing above and works fine.
  const recheck = await axios.get(
    `${workdriveApiBase()}/files/${parentFolderId}/files`,
    { headers: { Authorization: `Zoho-oauthtoken ${await getZohoAccessToken()}` } },
  );
  const recheckItems = ((recheck.data as { data?: Array<Record<string, unknown>> }).data ?? []);
  for (const it of recheckItems) {
    const attrs = (it.attributes as Record<string, unknown>) ?? {};
    if (String(attrs.name ?? '') === folderName) {
      return { id: it.id as string, name: folderName, created: true };
    }
  }

  throw new Error(
    `Created WorkDrive folder "${folderName}" under ${parentFolderId} but could not resolve its id`,
  );
}

// ── Sharing ───────────────────────────────────────────────────────────────
// Mirrors the org's existing Deluge (UploadMeetingInfoToCreator2): a personal
// share to Palindrome's service account. role_id 5 is what the meeting
// pipeline uses and is the level Palindrome expects.
//
// expiresOnUtc is deliberately exposed and used by callers: the meeting
// pipeline leaves the equivalent line commented out, so those shares never
// lapse. Ceding sets one so an external processor's access to client audio
// expires on its own if anything downstream fails to clean up.
export interface ShareWorkDriveResourceArgs {
  resourceId: string;
  emailId: string;
  roleId?: string;
  sendNotificationMail?: boolean;
  /** "YYYY-MM-DD HH:mm:ss" — omit for a permanent share. */
  expiresOnUtc?: string;
}

export async function shareWorkDriveResource(
  args: ShareWorkDriveResourceArgs,
): Promise<Record<string, unknown>> {
  const token = await getZohoAccessToken();
  const attributes: Record<string, unknown> = {
    resource_id: args.resourceId,
    shared_type: 'personal',
    email_id: args.emailId,
    role_id: args.roleId ?? '5',
    send_notification_mail: String(args.sendNotificationMail ?? false),
  };
  if (args.expiresOnUtc) attributes.expiration_date = args.expiresOnUtc;

  const body = { data: { attributes, type: 'permissions' } };

  const { data } = await axios.post(`${workdriveApiBase()}/permissions`, body, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/json',
    },
  });
  return data as Record<string, unknown>;
}

// Download a WorkDrive file's binary content (used for streaming or transcription).
export async function downloadWorkDriveFile(fileId: string): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
  const token = await getZohoAccessToken();
  const resp = await axios.get(
    `${workdriveApiBase()}/download/${fileId}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` }, responseType: 'arraybuffer' }
  );
  const headers = resp.headers as Record<string, string>;
  return {
    buffer: Buffer.from(resp.data as ArrayBuffer),
    contentType: headers['content-type'] ?? 'audio/mpeg',
    filename: headers['content-disposition'],
  };
}

export async function uploadToWorkDrive(
  buffer: Buffer,
  fileName: string,
  folderId?: string,
  contentType: string = 'application/octet-stream'
): Promise<WorkDriveUploadResult> {
  const parentId = folderId ?? envFolderId();
  if (!parentId) {
    throw new Error('No WorkDrive folder ID supplied and ZOHO_WORKDRIVE_FOLDER_ID env fallback not configured');
  }

  const token = await getZohoAccessToken();

  const form = new FormData();
  form.append('content', buffer, { filename: fileName, contentType });
  form.append('parent_id', parentId);
  form.append('filename', fileName);
  form.append('override-name-exist', 'true');

  const { data } = await axios.post(
    `${workdriveApiBase()}/upload`,
    form,
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );

  // WorkDrive returns {data: [{attributes: {resource_id, name, permalink, ...}}]}
  const first = (data as { data?: Array<Record<string, unknown>> })?.data?.[0];
  const attrs = (first?.attributes as Record<string, unknown>) ?? {};
  return {
    id: (first?.id as string) ?? (attrs.resource_id as string),
    name: (attrs.name as string) ?? fileName,
    permalink: attrs.permalink as string | undefined,
    resourceId: attrs.resource_id as string | undefined,
  };
}
