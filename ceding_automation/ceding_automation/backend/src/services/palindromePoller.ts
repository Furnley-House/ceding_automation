// backend/src/services/palindromePoller.ts
// Background worker that finishes Palindrome transcription jobs.
//
// Palindrome has no callback. We enqueue a row on a Zoho Creator form, poke a
// trigger, and the only way to learn the outcome is to re-read that row. When
// it flips to "Completed" the transcript document is sitting in the case's
// WorkDrive folder waiting to be collected.
//
// Modelled on aiBffPoller.ts, which has been running this shape in production
// — same cadence knobs, same per-tick cap, same "never let a tick crash the
// loop" discipline. Differences are only where the two vendors differ:
//   * there is no PUSH path here, so this is the ONLY way a job completes;
//   * completion is a status string on a Creator row, not a job API;
//   * the payload is a .docx in WorkDrive rather than a JSON body.

import { PrismaClient, Prisma } from '@prisma/client';
import { getPalindromeJobStatus, isPalindromeEnabled } from './palindrome';
import { findLatestArtefact, fetchAndParseArtefact } from './palindromeTranscript';

const prisma = new PrismaClient();

const POLL_INTERVAL_MS = 20_000; // tick every 20s
const POLL_FRESHNESS_MS = 30_000; // skip rows polled in the last 30s
const SUBMISSION_GRACE_MS = 30_000; // give Palindrome a head start
const JOB_TIMEOUT_MS = 30 * 60_000; // 30-min hard cap (observed runs: ~3 min)
const PER_TICK_CAP = 25;

// Attribution for audit rows — machine-initiated, not a human action.
const SYSTEM_USER_ID = 'system-ai-bff';

let intervalHandle: NodeJS.Timeout | null = null;

export function startPalindromePoller(): void {
  if (!isPalindromeEnabled()) {
    console.log('[palindrome-poller] TRANSCRIPT_VIA_PALINDROME is not "true" — poller disabled');
    return;
  }
  if (process.env.NODE_ENV === 'test') {
    console.log('[palindrome-poller] test env — poller disabled');
    return;
  }
  if (intervalHandle) return; // idempotent

  // .unref() so a pending tick never keeps the process alive on shutdown.
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
  intervalHandle.unref();
  console.log(`[palindrome-poller] started — tick every ${POLL_INTERVAL_MS}ms`);
}

export function stopPalindromePoller(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function tick(): Promise<void> {
  try {
    await timeOutStaleJobs();
    await pollCandidates();
  } catch (err) {
    // A thrown tick would kill the interval and silently stop all
    // transcription. Never let that happen.
    console.error('[palindrome-poller] tick error:', err);
  }
}

// Rows that never reached a terminal state. Bounded per tick so a backlog
// can't make one tick unbounded — the next tick catches the rest.
async function timeOutStaleJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - JOB_TIMEOUT_MS);
  const message = `Timed out waiting for Palindrome after ${Math.round(JOB_TIMEOUT_MS / 60_000)} minutes`;

  const stale = await prisma.transcript.findMany({
    where: {
      completedAt: null,
      palindromeRecordId: { not: null },
      requestedAt: { lt: cutoff },
    },
    select: { id: true, caseId: true, palindromeRecordId: true, requestedAt: true },
    take: PER_TICK_CAP,
  });

  for (const t of stale) {
    try {
      // completedAt:null guard so a concurrent settle isn't clobbered.
      const settled = await prisma.transcript.updateMany({
        where: { id: t.id, completedAt: null },
        data: {
          palindromeStatus: 'Timed Out',
          palindromeError: message,
          completedAt: new Date(),
          lastPolledAt: new Date(),
        },
      });
      if (settled.count === 0) continue; // someone else settled it

      await writeAudit(t.caseId, `Palindrome transcription timed out`, {
        transcriptId: t.id,
        creatorRecordId: t.palindromeRecordId,
        elapsedMs: t.requestedAt ? Date.now() - t.requestedAt.getTime() : null,
      });
      console.warn(`[palindrome-poller] timed out transcript ${t.id}`);
    } catch (err) {
      // Isolate per row — a transient DB error must not skip the others.
      console.error(`[palindrome-poller] timeout settle failed for ${t.id}:`, err);
    }
  }
}

async function pollCandidates(): Promise<void> {
  const now = Date.now();
  const cutoffSubmitted = new Date(now - SUBMISSION_GRACE_MS);
  const cutoffPolled = new Date(now - POLL_FRESHNESS_MS);

  const candidates = await prisma.transcript.findMany({
    where: {
      completedAt: null,
      palindromeRecordId: { not: null },
      requestedAt: { lt: cutoffSubmitted },
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: cutoffPolled } }],
    },
    take: PER_TICK_CAP,
  });

  for (const t of candidates) {
    await pollOne(t.id, t.palindromeRecordId!, t.caseId, t.workdriveTranscriptsFolder);
  }
}

async function pollOne(
  transcriptId: string,
  creatorRecordId: string,
  caseId: string,
  transcriptsFolderId: string | null,
): Promise<void> {
  try {
    // ── Status: for progress display and failure detection only ─────────
    //
    // Deliberately NOT the completion signal. Palindrome does not reliably
    // flip processing_status to "Completed" — observed on 18 Aug 2026, where
    // transcript_20260818_112354.docx was written to the folder while both
    // Creator rows stayed on "Ready For Processing" indefinitely. Earlier
    // runs did update it. Palindrome_Code and Processing_Complete_Time are
    // empty even on runs that DO report Completed.
    //
    // The document in the folder is the actual deliverable, so that is what
    // we wait for. Status still earns its keep for surfacing "Error (Retry)"
    // and for showing the CA that something is happening.
    const status = await getPalindromeJobStatus(creatorRecordId);
    const raw = (status.processingStatus ?? '').trim();
    const isFailed = /^error/i.test(raw) || Boolean(status.palindromeError);

    await prisma.transcript.update({
      where: { id: transcriptId },
      data: {
        palindromeStatus: status.processingStatus ?? undefined,
        palindromeCode: status.palindromeCode ?? undefined,
        palindromeError: status.palindromeError ?? status.errorMessage ?? undefined,
        lastPolledAt: new Date(),
      },
    });

    if (!transcriptsFolderId) {
      console.error(
        `[palindrome-poller] transcript ${transcriptId} has no folder recorded — cannot collect`,
      );
      return;
    }

    const row = await prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: { requestedAt: true },
    });

    // Documents already claimed by another transcript row for this case —
    // several calls per client share one folder, so a job must not collect
    // its neighbour's output.
    const claimed = await prisma.transcript.findMany({
      where: {
        caseId,
        id: { not: transcriptId },
        workdriveTranscriptFileId: { not: null },
      },
      select: { workdriveTranscriptFileId: true },
    });

    const artefact = await findLatestArtefact(
      transcriptsFolderId,
      row?.requestedAt ?? undefined,
      claimed.map((c) => c.workdriveTranscriptFileId!).filter(Boolean),
    );

    if (!artefact) {
      // Nothing yet. If Palindrome has reported a failure there will never be
      // one, so settle now rather than waiting out the 30-minute timeout.
      if (isFailed) {
        const settled = await prisma.transcript.updateMany({
          where: { id: transcriptId, completedAt: null },
          data: { completedAt: new Date() },
        });
        if (settled.count > 0) {
          await writeAudit(caseId, 'Palindrome transcription failed', {
            transcriptId,
            creatorRecordId,
            error: status.palindromeError ?? status.errorMessage ?? raw,
          });
          console.warn(`[palindrome-poller] job failed for transcript ${transcriptId}: ${raw}`);
        }
      }
      return;
    }

    const parsed = await fetchAndParseArtefact(artefact);

    // Guard against writing an empty transcript over nothing useful.
    if (!parsed.text || parsed.text.length < 20) {
      console.warn(
        `[palindrome-poller] ${transcriptId}: artefact ${artefact.file.name} parsed to ${parsed.text.length} chars — not settling yet`,
      );
      return;
    }

    const settled = await prisma.transcript.updateMany({
      where: { id: transcriptId, completedAt: null },
      data: {
        rawText: parsed.text,
        workdriveTranscriptFileId: artefact.file.id,
        completedAt: new Date(),
        palindromeStatus: 'Completed',
      },
    });

    if (settled.count > 0) {
      // NOTE: we deliberately do NOT write processing_status back to the
      // Creator row, even though Palindrome often leaves it on "Ready For
      // Processing" after the transcript exists.
      //
      // Patching that row fires the org's FactfindMeetingGeneration workflow
      // on the shared Meeting_Recordings form. Zoho answers HTTP 200 with
      // {"code":9750} — the update is refused because that workflow needs a
      // connection our token does not hold. So the write never persisted, and
      // even if it did we would be triggering someone else's meeting
      // automation as a side effect of a cosmetic status change.
      //
      // Completion is authoritative in OUR data (Transcript.completedAt and
      // rawText) and surfaced in the case UI. The Creator column staying
      // stale is a Palindrome-side defect to raise with them.

      await writeAudit(caseId, `Transcript received from Palindrome`, {
        transcriptId,
        creatorRecordId,
        file: artefact.file.name,
        workdriveFileId: artefact.file.id,
        kind: parsed.kind,
        turnCount: parsed.turnCount,
        participants: parsed.participants,
        chars: parsed.text.length,
      });
      console.log(
        `[palindrome-poller] ingested ${artefact.file.name} (${parsed.kind}, ${parsed.turnCount} turns) for transcript ${transcriptId}`,
      );
    }
  } catch (err) {
    // Back off after a transient failure rather than hammering Zoho every
    // tick — WorkDrive rate-limits hard (F7008) and Creator is shared with
    // the meeting pipeline.
    await prisma.transcript
      .update({ where: { id: transcriptId }, data: { lastPolledAt: new Date() } })
      .catch(() => {});
    console.error(`[palindrome-poller] poll failed for transcript ${transcriptId}:`, err);
  }
}

// Audit writes must never fail the poller — settling the row matters more
// than the audit trail, and the other candidates still need their turn.
async function writeAudit(
  caseId: string,
  message: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        caseId,
        userId: SYSTEM_USER_ID,
        action: 'TRANSCRIPT_UPLOADED',
        source: 'AI',
        newValue: message,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error('[palindrome-poller] audit write failed:', err);
  }
}
