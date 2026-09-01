// backend/src/services/palindrome.ts
// Submit a ceding provider call to Palindrome for transcription.
//
// ── How Palindrome actually works ─────────────────────────────────────────
// It is NOT a request/response transcription API. The trigger endpoint takes
// no request body at all:
//
//   POST {PALINDROME_API_URL}/api/v1/trigger/post-meeting-workflow
//   X-API-Key: <key>
//
// That call means "wake up and sweep the Creator form you are bound to for
// rows marked Ready For Processing". It is a poke, not a job submission.
//
// Three consequences drive the design of this file:
//
//   1. We must write our row into the SAME Creator form the org's meeting
//      pipeline uses. The trigger is bound to that one form; rows on any
//      other form are invisible to Palindrome.
//   2. Palindrome reads the audio out of WorkDrive using its own service
//      account, so the folder must be shared with that account BEFORE the
//      row is enqueued — otherwise the sweep finds a row it cannot read.
//   3. There is no callback. Completion is discovered by re-reading the
//      Creator row (Processing Status / Palindrome Code) and by watching the
//      summary folder for a new document.
//
// Ordering therefore matters and is enforced below: share → enqueue → poke.
//
// Reference: the org's Deluge function UploadMeetingInfoToCreator2, which
// does the same four steps for Zoho Meeting recordings.

import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import {
  shareWorkDriveResource,
  resolveCaseFolderId,
  ensureWorkDriveFolder,
} from './workdrive';
import {
  createCreatorRecord,
  getCreatorRecordById,
  updateCreatorRecord,
} from './zohoCreator';
import { createRecordingLink, recordingLinkConfigError } from './recordingLinks';

const prisma = new PrismaClient();

// ── Config ────────────────────────────────────────────────────────────────
// Read at call-time, not module-load, so .env edits apply without a rebuild.
const apiUrl = () =>
  (process.env.PALINDROME_API_URL ?? 'https://client-service.prod.palindrome.co').replace(/\/+$/, '');
const triggerPath = () =>
  process.env.PALINDROME_TRIGGER_PATH ?? '/api/v1/trigger/post-meeting-workflow';
const apiKey = () => process.env.PALINDROME_API_KEY ?? '';
const accessEmail = () =>
  process.env.PALINDROME_ACCESS_EMAIL ?? 'palindrome.access@furnleyhouse.co.uk';

// The Creator form + report the meeting pipeline already uses. Overridable in
// case the org ever gives ceding its own form AND Palindrome binds a workflow
// to it — but the default is deliberately the shared one.
const formLinkName = () =>
  process.env.ZOHO_CREATOR_FORM ?? 'Meeting_Recordings';
const reportLinkName = () =>
  process.env.ZOHO_CREATOR_REPORT ?? 'All_Meeting_Recordings';

// How long Palindrome's access to a case's recordings folder survives. The
// meeting pipeline leaves its equivalent permanent (the expiration_date line
// is commented out in the Deluge). Ceding sets one so client audio does not
// stay reachable by an external processor indefinitely if cleanup is missed.
const shareTtlDays = () => Number(process.env.PALINDROME_SHARE_TTL_DAYS ?? 7);

export function isPalindromeConfigured(): boolean {
  return apiKey().length > 0 && !apiKey().startsWith('your-');
}

export function isPalindromeEnabled(): boolean {
  return String(process.env.TRANSCRIPT_VIA_PALINDROME).toLowerCase() === 'true';
}

// ── Errors ────────────────────────────────────────────────────────────────

export class PalindromeNotConfiguredError extends Error {
  constructor() {
    super(
      'Palindrome is not configured. Set PALINDROME_API_KEY (and optionally ' +
        'PALINDROME_API_URL / PALINDROME_TRIGGER_PATH) in .env.',
    );
    this.name = 'PalindromeNotConfiguredError';
  }
}

export class PalindromeTriggerError extends Error {
  constructor(readonly status: number | undefined, message: string) {
    super(message);
    this.name = 'PalindromeTriggerError';
  }
}

// ── Folders ───────────────────────────────────────────────────────────────
// Two subfolders inside the client's own WorkDrive folder
// (Contact.Client_Record_Folder_ID — the same folder the Stage 9 checklist
// export writes to):
//
//   <client record folder>/
//     Ceding Call Recordings/     ← the MP3 the CA uploads
//     Ceding Call Transcripts/    ← where Palindrome writes transcript_*.docx
//
// Keeping call audio and transcripts out of the client folder root matters
// for two reasons: that root also holds checklist exports and client
// documents, and the poller identifies Palindrome's output by filename — a
// dedicated folder means far less to sift through and no chance of colliding
// with an unrelated document.
const RECORDINGS_FOLDER = 'Ceding Call Recordings';
const TRANSCRIPTS_FOLDER = 'Ceding Call Transcripts';

export interface CaseFolders {
  recordingsFolderId: string;
  transcriptsFolderId: string;
  clientFolderId: string;
}

/**
 * Resolve the client's WorkDrive folder and make sure both call subfolders
 * exist inside it. Idempotent — reuses the folders if they are already there,
 * so it is safe to call on every submission.
 */
export async function ensureCaseCallFolders(
  clientZohoId: string | null,
  _caseRef: string,
): Promise<CaseFolders> {
  const { folderId: clientFolderId } = await resolveCaseFolderId(clientZohoId);

  const recordings = await ensureWorkDriveFolder(clientFolderId, RECORDINGS_FOLDER);
  const transcripts = await ensureWorkDriveFolder(clientFolderId, TRANSCRIPTS_FOLDER);

  return {
    recordingsFolderId: recordings.id,
    transcriptsFolderId: transcripts.id,
    clientFolderId,
  };
}

// ── Trigger ───────────────────────────────────────────────────────────────

/**
 * Poke Palindrome to sweep the Creator form.
 *
 * Carries no body by design — see the header comment. Returns the raw
 * response so callers can log what came back; Palindrome's reply shape is not
 * contractually documented to us.
 */
export async function triggerPalindromeWorkflow(): Promise<unknown> {
  if (!isPalindromeConfigured()) throw new PalindromeNotConfiguredError();

  const url = `${apiUrl()}${triggerPath()}`;
  try {
    const { data } = await axios.post(
      url,
      undefined,
      {
        headers: {
          'X-API-Key': apiKey(),
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      },
    );
    console.log(`[palindrome] triggered ${url}`);
    return data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const body = err.response?.data;
      const asText = typeof body === 'string' ? body : JSON.stringify(body ?? {});
      throw new PalindromeTriggerError(
        status,
        `Palindrome trigger failed (${status ?? 'no status'}): ${asText.slice(0, 300)}`,
      );
    }
    throw err;
  }
}

// ── Submit ────────────────────────────────────────────────────────────────

export interface SubmitCallArgs {
  caseId: string;
  /** WorkDrive file ID of the MP3 already uploaded to the recordings folder. */
  recordingFileId: string;
  recordingFileName: string;
  /** WorkDrive permalink or download URL for the MP3, if we have one. */
  recordingUrl?: string;
  recordingsFolderId: string;
  transcriptsFolderId: string;
  /**
   * Who made the call. Palindrome labels the adviser's turns in the
   * transcript with this value, so it should be the person who was actually
   * on the phone — normally the signed-in user submitting the recording,
   * NOT the case's assigned owner. Those differ whenever one CA covers a
   * colleague's case, and using the owner mislabels every line they speak.
   *
   * Falls back to the case's assigned user when no acting user is known
   * (the folder watcher runs unattended).
   */
  adviserEmail?: string;
}

export interface SubmitCallResult {
  creatorRecordId: string | null;
  recordingsFolderId: string;
  transcriptsFolderId: string;
  triggerResponse: unknown;
  sharedWith: string;
  shareExpiresOnUtc: string | null;
}

function formatCreatorDate(d: Date): string {
  // Creator date fields on this form are dd-MMM-yyyy (see the All Meeting
  // Recordings report, e.g. "11-Aug-2026").
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function formatUtcStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function splitName(full: string): { first_name: string; last_name: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: 'Unknown', last_name: 'Client' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '-' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

/**
 * Share → enqueue → poke, in that order.
 *
 * The order is load-bearing. Palindrome's sweep can fire the moment the row
 * exists, so the folder share has to be in place first or the worker picks up
 * a row whose audio it cannot read and fails it.
 */
export async function submitCallForTranscription(
  args: SubmitCallArgs,
): Promise<SubmitCallResult> {
  if (!isPalindromeConfigured()) throw new PalindromeNotConfiguredError();

  const caseRecord = await prisma.case.findUnique({
    where: { id: args.caseId },
    select: {
      caseRef: true,
      clientName: true,
      clientZohoId: true,
      policyRef: true,
      zohoPlanName: true,
      provider: { select: { name: true } },
      assignedTo: { select: { email: true, name: true } },
    },
  });
  if (!caseRecord) throw new Error(`Case ${args.caseId} not found`);

  const now = new Date();
  const expiresOn =
    shareTtlDays() > 0
      ? formatUtcStamp(new Date(now.getTime() + shareTtlDays() * 86_400_000))
      : null;

  // ── 1. Share both folders with Palindrome's service account ────────────
  // Recordings so it can read the audio; transcripts so it can write back.
  for (const resourceId of [args.recordingsFolderId, args.transcriptsFolderId]) {
    try {
      await shareWorkDriveResource({
        resourceId,
        emailId: accessEmail(),
        roleId: '5',
        sendNotificationMail: false,
        ...(expiresOn ? { expiresOnUtc: expiresOn } : {}),
      });
    } catch (err) {
      // Best-effort, deliberately non-fatal. Two reasons:
      //
      //   1. Palindrome does NOT read the audio from this folder — it fetches
      //      Meeting_Download_URL2 over HTTP. The share only matters so it can
      //      WRITE its transcript back, and that grant is normally already in
      //      place on the client folder.
      //   2. The API user (itsupport@superbiagroup.co.uk) is Editor, not
      //      Organizer, on these team folders, so POST /permissions answers
      //      F7007 every time. Treating that as fatal would block every
      //      submission for a grant we cannot make and usually do not need.
      //
      // If Palindrome later reports it cannot write output, this warning is
      // the first place to look.
      const msg = (err as Error).message ?? '';
      const already =
        msg.includes('already') || msg.includes('ALREADY') || msg.includes('R016');
      console.warn(
        already
          ? `[palindrome] folder ${resourceId} already shared — continuing`
          : `[palindrome] could not share folder ${resourceId} (continuing anyway): ${msg.slice(0, 200)}`,
      );
    }
  }

  // ── 1b. The URL Palindrome will fetch ──────────────────────────────────
  // Palindrome GETs this URL. It does NOT read the shared folder — proven
  // when a run failed with "Failed to download file after 3 attempts:
  // Redirect response '302'" after following a WorkDrive permalink to a
  // login page.
  //
  // We cannot hand it a WorkDrive external link: the API user is Editor, not
  // Organizer, so POST /links answers R008 under every payload and endpoint
  // variant — and org policy disables public download links anyway. So the
  // backend serves the audio itself, behind a signed expiring token.
  //
  // args.recordingUrl overrides this, which is how the manual-link test path
  // works while the backend has no public address.
  let downloadUrl = args.recordingUrl ?? '';
  if (!downloadUrl) {
    const linkConfigError = recordingLinkConfigError();
    if (linkConfigError) {
      // Fail now rather than enqueue a row Palindrome retries 3× before
      // giving up — a bad URL costs ~10 minutes to discover downstream.
      throw new Error(`Cannot build a download URL for Palindrome: ${linkConfigError}`);
    }
    const link = createRecordingLink({
      workdriveFileId: args.recordingFileId,
      filename: args.recordingFileName,
      caseId: args.caseId,
    });
    downloadUrl = link.url;
    console.log(
      `[palindrome] signed recording link for ${caseRecord.caseRef}, expires ${link.expiresAt.toISOString()}`,
    );
  }

  // ── 2. Enqueue the row on the Creator form ─────────────────────────────
  // Field link names match the org's existing Meeting_Recordings form, since
  // that is the form the Palindrome trigger sweeps.
  const clientName = splitName(caseRecord.clientName);
  const label = [
    caseRecord.caseRef,
    caseRecord.provider?.name ?? 'Provider',
    caseRecord.policyRef ?? caseRecord.zohoPlanName ?? '',
  ]
    .filter(Boolean)
    .join(' - ');

  const data: Record<string, unknown> = {
    Deal_Name: label,
    Meeting_Recordings_Folder_ID: args.recordingsFolderId,
    Meeting_Summary_Folder_ID: args.transcriptsFolderId,
    Client_1_Name: clientName,
    Adviser_Email: args.adviserEmail ?? caseRecord.assignedTo?.email ?? '',
    Meeting_Filename: args.recordingFileName,
    Meeting_Download_URL2: downloadUrl,
    Meeting_Type: process.env.PALINDROME_MEETING_TYPE ?? 'ceding',
    Date_Added: formatCreatorDate(now),
    Time_Added: formatUtcStamp(now).slice(11),
    // Set last conceptually — this is the flag Palindrome sweeps for.
    processing_status: 'Ready For Processing',
  };

  const created = await createCreatorRecord(formLinkName(), data);
  console.log(
    `[palindrome] enqueued Creator record ${created.recordId ?? '(no id returned)'} for case ${caseRecord.caseRef}`,
  );

  // ── 3. Poke Palindrome ─────────────────────────────────────────────────
  const triggerResponse = await triggerPalindromeWorkflow();

  return {
    creatorRecordId: created.recordId,
    recordingsFolderId: args.recordingsFolderId,
    transcriptsFolderId: args.transcriptsFolderId,
    triggerResponse,
    sharedWith: accessEmail(),
    shareExpiresOnUtc: expiresOn,
  };
}

/**
 * Stamp one of OUR Creator rows as finished.
 *
 * Palindrome does not reliably set processing_status — transcripts have been
 * written to WorkDrive while the row stayed on "Ready For Processing"
 * indefinitely. Since the shared report is what the org watches, a growing
 * column of apparently-stuck ceding jobs is misleading, so once the poller
 * has the transcript in hand it closes the row itself.
 *
 * Best-effort by design: the transcript is already safely in the database, so
 * a failure here is cosmetic and must never fail the ingestion.
 */
export async function markCreatorRecordComplete(
  creatorRecordId: string,
  note?: string,
): Promise<boolean> {
  try {
    await updateCreatorRecord(reportLinkName(), creatorRecordId, {
      processing_status: 'Completed',
      Processing_Complete_Time: formatUtcStamp(new Date()).slice(11),
      ...(note ? { Error_Message: note } : {}),
    });
    console.log(`[palindrome] marked Creator record ${creatorRecordId} Completed`);
    return true;
  } catch (err) {
    console.warn(
      `[palindrome] could not mark Creator record ${creatorRecordId} complete: ${(err as Error).message.slice(0, 160)}`,
    );
    return false;
  }
}

// ── Status ────────────────────────────────────────────────────────────────

export interface PalindromeJobStatus {
  found: boolean;
  processingStatus: string | null;
  palindromeCode: string | null;
  palindromeError: string | null;
  errorMessage: string | null;
  completedAt: string | null;
  raw: unknown;
}

/**
 * Re-read the Creator row to see whether Palindrome has finished.
 *
 * Field names mirror the All Meeting Recordings report. We read defensively —
 * Creator returns display labels or link names depending on how the report is
 * configured, so each value is looked up under both spellings.
 */
export async function getPalindromeJobStatus(
  creatorRecordId: string,
): Promise<PalindromeJobStatus> {
  const row = await getCreatorRecordById(reportLinkName(), creatorRecordId);
  if (!row) {
    return {
      found: false,
      processingStatus: null,
      palindromeCode: null,
      palindromeError: null,
      errorMessage: null,
      completedAt: null,
      raw: null,
    };
  }

  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return null;
  };

  return {
    found: true,
    processingStatus: pick('processing_status', 'Processing_Status'),
    palindromeCode: pick('Palindrome_Code', 'palindrome_code'),
    palindromeError: pick('Palindrome_Error_Response', 'palindrome_error_response'),
    errorMessage: pick('Error_Message', 'error_message'),
    completedAt: pick('Processing_Complete_Time', 'processing_complete_time'),
    raw: row,
  };
}
