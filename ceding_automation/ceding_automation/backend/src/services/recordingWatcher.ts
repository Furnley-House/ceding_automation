// backend/src/services/recordingWatcher.ts
// Watches each active case's "Ceding Call Recordings" folder and submits any
// new audio to Palindrome — so a CA can drop a recording straight into
// WorkDrive and get a transcript without touching the app.
//
// ── Why polling rather than a Zoho Flow ───────────────────────────────────
// A Flow with a "new file in folder" trigger would be more immediate, but it
// needs building and owning on the Zoho side, and it needs to reach this
// backend over the internet. Polling needs neither: it works on localhost, it
// survives restarts because the state lives in the database, and it reuses
// the WorkDrive access we already have.
//
// ── Which case does a dropped file belong to? ─────────────────────────────
// The recordings folder hangs off the CLIENT record folder, and one client
// can have several ceding cases (one per plan). So a file appearing there is
// not automatically attributable. Resolution order:
//
//   1. filename starts with a case ref  ->  that case. Every upload the app
//      makes is prefixed this way, so app-uploaded files are unambiguous.
//   2. the client has exactly one active case  ->  that case.
//   3. otherwise  ->  skip and log.
//
// Rule 3 matters: attaching a provider call to the wrong plan would put wrong
// values on a checklist a human then approves. Skipping is recoverable;
// mis-filing is not.

import { PrismaClient, CaseStatus } from '@prisma/client';
import { ensureCaseCallFolders, submitCallForTranscription, isPalindromeEnabled } from './palindrome';
import { listWorkDriveFiles } from './workdrive';
import {
  FailureTracker,
  TickBreaker,
  classifyFailure,
  dominantKind,
  type FailureKind,
} from './watcherBackoff';

const prisma = new PrismaClient();

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'mp4'];
const POLL_INTERVAL_MS = Number(process.env.RECORDING_WATCH_INTERVAL_MS ?? 120_000);
const PER_TICK_CASE_CAP = 20;

// Exclude finished and abandoned cases rather than listing the stages a call
// might happen in.
//
// The UI's step numbers do NOT line up with this enum — the call workspace is
// "step 5" on screen while the enum's STAGE_5 is CHASING — so an allow-list
// keyed on stage silently misses cases. A deny-list of terminal states is
// correct regardless of how the stepper is numbered, and PER_TICK_CASE_CAP
// keeps the WorkDrive load bounded (it rate-limits hard: F7008).
const TERMINAL_STATUSES: CaseStatus[] = ['STAGE_10_COMPLETE', 'APPROVED', 'CANCELLED'];

const SYSTEM_USER_ID = 'system-ai-bff';

// Gap between per-case WorkDrive calls. The loop is sequential, so this is
// not about concurrency — it is about not firing twenty calls inside a second
// against a service that rate-limits hard. Zero under test.
const REQUEST_STAGGER_MS =
  process.env.NODE_ENV === 'test' ? 0 : Number(process.env.RECORDING_WATCH_STAGGER_MS ?? 150);

const pause = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

let handle: NodeJS.Timeout | null = null;

// Failure memory, the thing KI-08 was actually about. Module-level so it
// survives between ticks; reset() exists for tests and for the restart case.
const failures = new FailureTracker();
const breaker = new TickBreaker();

// Where the last tick stopped. PER_TICK_CASE_CAP bounds a tick, so without a
// cursor `take` returns the same arbitrary page for ever and every case past
// the cap is never scanned at all — their recordings would sit in WorkDrive
// unnoticed. Ordering by id and walking forward gives every case a turn.
let scanCursor: string | null = null;

/** Test seam: forget every backoff and start the rotation again. */
export function resetWatcherState(): void {
  failures.reset();
  breaker.reset();
  scanCursor = null;
}

/**
 * One page of cases to try this tick, oldest id first, wrapping at the end.
 *
 * Wrapping matters when the tail of the list is shorter than the cap: without
 * it the last page would be short and the cursor would reset, so the cases at
 * the start of the alphabet would be scanned twice as often as those at the
 * end.
 */
async function nextCasePage() {
  const select = { id: true, caseRef: true, clientZohoId: true } as const;
  const where = { status: { notIn: TERMINAL_STATUSES } };

  const page = await prisma.case.findMany({
    where: scanCursor ? { ...where, id: { gt: scanCursor } } : where,
    select,
    orderBy: { id: 'asc' as const },
    take: PER_TICK_CASE_CAP,
  });

  if (page.length === PER_TICK_CASE_CAP) {
    scanCursor = page[page.length - 1].id;
    return page;
  }

  // Ran off the end — wrap and top up from the beginning.
  const seen = new Set(page.map((c) => c.id));
  const wrapped = await prisma.case.findMany({
    where,
    select,
    orderBy: { id: 'asc' as const },
    take: PER_TICK_CASE_CAP,
  });

  const combined = [...page, ...wrapped.filter((c) => !seen.has(c.id))].slice(0, PER_TICK_CASE_CAP);
  scanCursor = combined.length > 0 ? combined[combined.length - 1].id : null;
  return combined;
}

export function startRecordingWatcher(): void {
  if (String(process.env.WATCH_RECORDING_FOLDER).toLowerCase() !== 'true') {
    console.log('[recording-watcher] WATCH_RECORDING_FOLDER is not "true" — watcher disabled');
    return;
  }
  if (!isPalindromeEnabled()) {
    console.log('[recording-watcher] TRANSCRIPT_VIA_PALINDROME is not "true" — watcher disabled');
    return;
  }
  if (process.env.NODE_ENV === 'test') return;
  if (handle) return;

  handle = setInterval(tick, POLL_INTERVAL_MS);
  handle.unref();
  console.log(`[recording-watcher] started — scanning every ${POLL_INTERVAL_MS}ms`);
}

export function stopRecordingWatcher(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

async function tick(): Promise<void> {
  try {
    await scanOnce();
  } catch (err) {
    // Never let a tick kill the interval.
    console.error('[recording-watcher] tick error:', err);
  }
}

/** Exported so a script can run one pass without waiting for the timer. */
export async function scanOnce(): Promise<{
  scanned: number;
  submitted: number;
  skipped: number;
  deferred: number;
}> {
  if (breaker.shouldSkipTick()) {
    return { scanned: 0, submitted: 0, skipped: 0, deferred: 0 };
  }

  const cases = await nextCasePage();

  let submitted = 0;
  let skipped = 0;
  let deferred = 0;
  let attempted = 0;
  const tickFailures: FailureKind[] = [];

  // One client folder can serve several cases, so scanning per-case would
  // list the same folder repeatedly. Group by folder and resolve ownership
  // once per file instead.
  const byFolder = new Map<string, { folderId: string; transcriptsFolderId: string; cases: typeof cases }>();

  for (const c of cases) {
    if (failures.shouldSkip(c.id)) {
      deferred++;
      continue;
    }

    attempted++;
    if (attempted > 1) await pause(REQUEST_STAGGER_MS);
    try {
      const folders = await ensureCaseCallFolders(c.clientZohoId, c.caseRef);
      if (failures.recordSuccess(c.id)) {
        console.log(`[recording-watcher] ${c.caseRef}: folder resolved again, backoff cleared`);
      }
      const key = folders.recordingsFolderId;
      const existing = byFolder.get(key);
      if (existing) existing.cases.push(c);
      else
        byFolder.set(key, {
          folderId: folders.recordingsFolderId,
          transcriptsFolderId: folders.transcriptsFolderId,
          cases: [c],
        });
    } catch (err) {
      // A case with no resolvable client folder isn't watchable right now.
      // How long we wait before asking again depends on why it failed: a 429
      // clears on its own, a missing folder needs a human.
      const kind = classifyFailure(err);
      tickFailures.push(kind);
      const state = failures.recordFailure(c.id, kind);
      if (state.shouldLog) {
        console.warn(
          `[recording-watcher] ${c.caseRef}: cannot resolve folder (${kind}) — ` +
            `${(err as Error).message.slice(0, 120)}; ` +
            `retrying in ${Math.round(state.delayMs / 60_000)}m`,
        );
      }
    }
  }

  const tripped = breaker.record(attempted, tickFailures.length, dominantKind(tickFailures));
  if (tripped) console.error(`[recording-watcher] ${tripped}`);
  if (deferred > 0) {
    console.log(`[recording-watcher] ${deferred} case(s) in backoff, not retried this tick`);
  }

  for (const [, group] of byFolder) {
    // Folder listings get their own backoff, keyed on the folder rather than
    // the case: one folder can serve several cases, and it is the folder the
    // call is against.
    if (failures.shouldSkip(group.folderId)) {
      deferred++;
      continue;
    }

    let files;
    try {
      files = await listWorkDriveFiles(group.folderId, { extensions: AUDIO_EXTENSIONS });
      failures.recordSuccess(group.folderId);
    } catch (err) {
      const kind = classifyFailure(err);
      const state = failures.recordFailure(group.folderId, kind);
      if (state.shouldLog) {
        console.error(
          `[recording-watcher] listing ${group.folderId} failed (${kind}): ` +
            `${(err as Error).message.slice(0, 160)}; ` +
            `retrying in ${Math.round(state.delayMs / 60_000)}m`,
        );
      }
      continue;
    }

    for (const file of files) {
      // Already submitted? The file id is the durable handle — a transcript
      // row carrying it means this recording has been through the pipeline,
      // so we never double-submit even across restarts.
      const seen = await prisma.transcript.findFirst({
        where: { workdriveRecordingFileId: file.id },
        select: { id: true },
      });
      if (seen) continue;

      const owner = resolveOwningCase(file.name, group.cases);
      if (!owner) {
        skipped++;
        console.warn(
          `[recording-watcher] "${file.name}" in ${group.folderId}: cannot tell which case it belongs to ` +
            `(${group.cases.length} active cases for this client, no case-ref prefix) — skipping`,
        );
        continue;
      }

      try {
        const result = await submitCallForTranscription({
          caseId: owner.id,
          recordingFileId: file.id,
          recordingFileName: file.name,
          recordingsFolderId: group.folderId,
          transcriptsFolderId: group.transcriptsFolderId,
        });

        await prisma.transcript.create({
          data: {
            caseId: owner.id,
            source: 'PALINDROME',
            rawText: '',
            palindromeRecordId: result.creatorRecordId,
            palindromeStatus: 'Ready For Processing',
            requestedAt: new Date(),
            workdriveRecordingFileId: file.id,
            workdriveTranscriptsFolder: group.transcriptsFolderId,
          },
        });

        await prisma.auditLog.create({
          data: {
            caseId: owner.id,
            userId: SYSTEM_USER_ID,
            action: 'TRANSCRIPT_UPLOADED',
            source: 'SYSTEM',
            newValue: `Auto-detected recording "${file.name}" and sent for transcription`,
            metadata: {
              workdriveFileId: file.id,
              creatorRecordId: result.creatorRecordId,
              detectedBy: 'recording-watcher',
            },
          },
        });

        submitted++;
        console.log(
          `[recording-watcher] submitted "${file.name}" for ${owner.caseRef} (creator ${result.creatorRecordId})`,
        );
      } catch (err) {
        console.error(
          `[recording-watcher] submit failed for "${file.name}":`,
          (err as Error).message.slice(0, 200),
        );
      }
    }
  }

  return { scanned: byFolder.size, submitted, skipped, deferred };
}

/**
 * Decide which case a recording belongs to. Returns null when it cannot be
 * determined — deliberately, because guessing would attach a provider call to
 * the wrong plan.
 */
export function resolveOwningCase<T extends { id: string; caseRef: string }>(
  fileName: string,
  candidates: T[],
): T | null {
  if (candidates.length === 0) return null;

  // 1. Explicit case-ref prefix wins. The app names uploads this way.
  const prefixed = candidates.find((c) =>
    fileName.toLowerCase().startsWith(c.caseRef.toLowerCase()),
  );
  if (prefixed) return prefixed;

  // 2. Case ref anywhere in the name — a human may have renamed the file.
  const mentioned = candidates.filter((c) =>
    fileName.toLowerCase().includes(c.caseRef.toLowerCase()),
  );
  if (mentioned.length === 1) return mentioned[0];

  // 3. Unambiguous because there is only one active case for this client.
  if (candidates.length === 1) return candidates[0];

  return null;
}
