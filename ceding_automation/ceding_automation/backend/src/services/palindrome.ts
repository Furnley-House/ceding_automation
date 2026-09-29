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


const apiUrl = () =>
  (process.env.PALINDROME_API_URL ?? 'https://client-service.prod.palindrome.co').replace(/\/+$/, '');
const triggerPath = () =>
  process.env.PALINDROME_TRIGGER_PATH ?? '/api/v1/trigger/post-meeting-workflow';
const apiKey = () => process.env.PALINDROME_API_KEY ?? '';
const accessEmail = () =>
  process.env.PALINDROME_ACCESS_EMAIL ?? 'palindrome.access@furnleyhouse.co.uk';

const formLinkName = () =>
  process.env.ZOHO_CREATOR_FORM ?? 'Meeting_Recordings';
const reportLinkName = () =>
  process.env.ZOHO_CREATOR_REPORT ?? 'All_Meeting_Recordings';

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

const RECORDINGS_FOLDER = 'Ceding Call Recordings';
const TRANSCRIPTS_FOLDER = 'Ceding Call Transcripts';

export interface CaseFolders {
  recordingsFolderId: string;
  transcriptsFolderId: string;
  clientFolderId: string;
}

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
