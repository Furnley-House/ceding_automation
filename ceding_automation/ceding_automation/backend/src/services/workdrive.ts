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
  createdTime?: string;
  modifiedTime?: string;
  permalink?: string;
  downloadUrl?: string;
}

// List files in a WorkDrive folder. Folder ID must be supplied explicitly,
// either by the caller or via the ZOHO_WORKDRIVE_FOLDER_ID env fallback.
export async function listWorkDriveFiles(folderId?: string): Promise<WorkDriveFile[]> {
  const parentId = folderId ?? envFolderId();
  if (!parentId) {
    throw new Error('No WorkDrive folder ID supplied and ZOHO_WORKDRIVE_FOLDER_ID env fallback not configured');
  }
  const token = await getZohoAccessToken();
  const { data } = await axios.get(
    `${workdriveApiBase()}/files/${parentId}/files`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const items = ((data as { data?: Array<Record<string, unknown>> }).data ?? []);
  return items
    .map((it) => {
      const attrs = (it.attributes as Record<string, unknown>) ?? {};
      return {
        id: it.id as string,
        name: (attrs.name as string) ?? '',
        extension: attrs.extn as string | undefined,
        sizeBytes: attrs.storage_info ? ((attrs.storage_info as Record<string, unknown>).size as number | undefined) : undefined,
        createdTime: attrs.created_time as string | undefined,
        modifiedTime: attrs.modified_time as string | undefined,
        permalink: attrs.permalink as string | undefined,
        downloadUrl: attrs.download_url as string | undefined,
      };
    })
    .filter((f) => (f.extension ?? '').toLowerCase() === 'mp3' || f.name.toLowerCase().endsWith('.mp3'));
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
