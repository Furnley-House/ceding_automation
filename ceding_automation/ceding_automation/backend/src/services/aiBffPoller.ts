// backend/src/services/aiBffPoller.ts
// Background poller — safety net for BFF write-backs that never land
// (network blip, BFF→backend unreachable, backend was redeploying).
// Write-back is the primary path; this is the secondary, idempotent path.
//
// Contract: docs/ai-integration-design.md §6.

import { PrismaClient, Prisma } from "@prisma/client";
import * as aiBff from "./aiBffClient";
import { applyExtractionResult, SYSTEM_USER_ID } from "./aiBffApply";

const prisma = new PrismaClient();

// Cadence — see §6 for rationale.
const POLL_INTERVAL_MS = 10_000; // tick every 10s
const POLL_FRESHNESS_MS = 30_000; // skip jobs polled in the last 30s
const SUBMISSION_GRACE_MS = 30_000; // let write-back win the first 30s
const JOB_TIMEOUT_MS = 10 * 60_000; // 10-min hard cap (BFF Service Bus lock duration)
const PER_TICK_CAP = 50; // safety cap on docs processed per tick

let intervalHandle: NodeJS.Timeout | null = null;

export function startPoller(): void {
  if (process.env.AI_VIA_BFF !== "true") {
    console.log("[ai-poller] AI_VIA_BFF is not 'true' — poller disabled");
    return;
  }
  if (process.env.NODE_ENV === "test") {
    console.log("[ai-poller] test env — poller disabled");
    return;
  }
  if (intervalHandle) return; // idempotent

  // .unref() so the event loop doesn't keep the process alive on shutdown.
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
  intervalHandle.unref();
  console.log(`[ai-poller] started — tick every ${POLL_INTERVAL_MS}ms`);
}

export function stopPoller(): void {
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
    // Never let a tick crash the loop.
    console.error("[ai-poller] tick error:", err);
  }
}

// Jobs older than JOB_TIMEOUT_MS with no terminal state — give up on them.
// Switched from a single bulk updateMany to a bounded per-doc loop so each
// timed-out run gets its own AI_EXTRACTION_RUN audit row (Gap 1b). Same
// selection criteria, same terminal values; PER_TICK_CAP bounds the loop so a
// deep backlog can't make one tick unbounded — the next tick 10s later
// catches leftovers. Wrapped by tick()'s outer try/catch.
async function timeOutStaleJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - JOB_TIMEOUT_MS);
  const timeoutMessage = "Timed out waiting for BFF after 10 minutes";

  const candidates = await prisma.document.findMany({
    where: {
      aiJobStatus: { in: ["queued", "processing"] },
      aiJobSubmittedAt: { lt: cutoff },
    },
    select: {
      id: true,
      caseId: true,
      aiJobId: true,
      aiJobSubmittedAt: true,
    },
    take: PER_TICK_CAP,
  });

  let settledCount = 0;

  for (const c of candidates) {
    // Outer try/catch isolates each candidate so a transient DB error on the
    // per-doc update (lock timeout, connection drop, etc.) doesn't skip the
    // remaining docs this tick — the failing doc stays unsettled and is
    // retried on the next tick via findMany's where-clause.
    try {
      // Per-doc update with the aiJobCompletedAt:null idempotency guard so a
      // concurrent PUSH-path settle doesn't get clobbered. count===0 here means
      // someone else already terminal-flipped this doc — skip the audit row to
      // avoid double-logging.
      const settled = await prisma.document.updateMany({
        where: { id: c.id, aiJobCompletedAt: null },
        data: {
          status: "ERROR",
          aiJobStatus: "failed",
          aiJobError: timeoutMessage,
          aiJobCompletedAt: new Date(),
        },
      });

      if (settled.count > 0) {
        settledCount += 1;
        try {
          const elapsedMs = c.aiJobSubmittedAt
            ? Date.now() - c.aiJobSubmittedAt.getTime()
            : null;
          await prisma.auditLog.create({
            data: {
              caseId: c.caseId,
              userId: SYSTEM_USER_ID,
              action: "AI_EXTRACTION_RUN",
              source: "AI",
              newValue: `Extraction failed: ${timeoutMessage}`,
              metadata: {
                jobId: c.aiJobId,
                documentId: c.id,
                bffStatus: "timeout",
                error: timeoutMessage,
                elapsedMs,
              } as Prisma.InputJsonValue,
            },
          });
        } catch (auditErr) {
          // Audit-write failure must NEVER fail the loop — settling the doc to
          // ERROR is more important than the audit row, and the other docs in
          // the loop must still get a chance to settle.
          console.error(
            `[ai-poller] timeout audit-log write failed for doc=${c.id} job=${c.aiJobId}:`,
            auditErr
          );
        }
      }
    } catch (settleErr) {
      console.error(
        `[ai-poller] timeout settle failed for doc=${c.id} job=${c.aiJobId}:`,
        settleErr
      );
      // Don't rethrow — continue the loop so other candidates still get a
      // chance to settle this tick. This doc remains unsettled and will be
      // re-picked next tick.
    }
  }

  if (settledCount > 0) {
    console.warn(`[ai-poller] timed out ${settledCount} stale BFF job(s)`);
  }
}

// Find in-flight docs that:
//   - have been submitted at least SUBMISSION_GRACE_MS ago (let write-back win first), and
//   - haven't been polled in POLL_FRESHNESS_MS (or have never been polled).
async function pollCandidates(): Promise<void> {
  const now = Date.now();
  const cutoffSubmitted = new Date(now - SUBMISSION_GRACE_MS);
  const cutoffPolled = new Date(now - POLL_FRESHNESS_MS);

  const candidates = await prisma.document.findMany({
    where: {
      aiJobStatus: { in: ["queued", "processing"] },
      aiJobSubmittedAt: { lt: cutoffSubmitted },
      aiJobId: { not: null },
      OR: [
        { aiJobLastPolledAt: null },
        { aiJobLastPolledAt: { lt: cutoffPolled } },
      ],
    },
    take: PER_TICK_CAP,
  });

  for (const doc of candidates) {
    if (!doc.aiJobId) continue;
    await pollOne(doc.id, doc.aiJobId);
  }
}

async function pollOne(documentId: string, jobId: string): Promise<void> {
  try {
    const status = await aiBff.getJobStatus(jobId);
    await prisma.document.update({
      where: { id: documentId },
      data: {
        aiJobStatus: status.status,
        aiJobStage: status.stage,
        aiJobProgress: status.progressPct,
        aiJobLastPolledAt: new Date(),
      },
    });

    if (status.status === "completed") {
      // Two paths can deliver the field data:
      //   1. BFF write-back PATCH /api/documents/:id  (push, primary)
      //   2. This poller pulling GET /result          (pull, fallback)
      //
      // In production both paths are reachable and write-back usually wins.
      // In localhost dev the BFF on Azure can't reach localhost:3001, so
      // write-back never lands — we MUST pull the result here, otherwise
      // the doc would settle to EXTRACTED with no checklist fields.
      //
      // applyExtractionResult is idempotent (aiJobCompletedAt guard inside)
      // so calling it after a successful write-back is safe.
      try {
        const result = await aiBff.getJobResult(jobId);
        const outcome = await applyExtractionResult(documentId, result);
        if (outcome.outcome === "applied") {
          console.log(
            `[ai-poller] applied result for doc=${documentId} job=${jobId}`
          );
        }
      } catch (resultErr) {
        console.error(
          `[ai-poller] getJobResult/applyExtractionResult failed for doc=${documentId} job=${jobId}:`,
          resultErr
        );
        // Still settle the doc status so the UI doesn't spin forever — the
        // field data can be re-pulled by a manual retry. We don't mark it
        // complete though, so the next tick will try again.
      }

      // Belt-and-braces: if applyExtractionResult was already run by the
      // write-back path it set aiJobCompletedAt, so this updateMany is a
      // no-op. If applyExtractionResult failed above, this still flips the
      // surface status so the spinner stops — the retry button in the UI
      // can re-trigger extraction.
      await prisma.document.updateMany({
        where: { id: documentId, aiJobCompletedAt: null },
        data: {
          status: "EXTRACTED",
          aiJobCompletedAt: new Date(),
        },
      });
    } else if (status.status === "failed") {
      // BFF says failed — settle the document here. The write-back path may
      // have already done this; the idempotency guard in PATCH covers that.
      const errorMessage = "BFF reported failed (no details)";
      // Fetch caseId + aiJobSubmittedAt BEFORE the update so we can build a
      // matching audit row (Gap 1a). aiJobSubmittedAt isn't touched by the
      // update below, but caseId is required and we want elapsedMs derived
      // from the pre-update timestamp.
      const docForAudit = await prisma.document.findUnique({
        where: { id: documentId },
        select: { caseId: true, aiJobSubmittedAt: true },
      });

      const settled = await prisma.document.updateMany({
        where: { id: documentId, aiJobCompletedAt: null },
        data: {
          status: "ERROR",
          aiJobCompletedAt: new Date(),
          aiJobError: errorMessage,
        },
      });

      // Only audit if WE settled this run (count>0). count===0 means a
      // concurrent PUSH path already terminal-flipped it and wrote its own
      // audit row — double-logging would be noise.
      if (settled.count > 0 && docForAudit) {
        try {
          const elapsedMs = docForAudit.aiJobSubmittedAt
            ? Date.now() - docForAudit.aiJobSubmittedAt.getTime()
            : null;
          await prisma.auditLog.create({
            data: {
              caseId: docForAudit.caseId,
              userId: SYSTEM_USER_ID,
              action: "AI_EXTRACTION_RUN",
              source: "AI",
              newValue: `Extraction failed: ${errorMessage}`,
              metadata: {
                jobId,
                documentId,
                bffStatus: "failed",
                stage: status.stage ?? null,
                error: errorMessage,
                elapsedMs,
              } as Prisma.InputJsonValue,
            },
          });
        } catch (auditErr) {
          // Audit-write failure must NEVER fail the poller's core job —
          // settling the doc to ERROR is more important than the audit row.
          console.error(
            `[ai-poller] audit-log write failed for doc=${documentId} job=${jobId}:`,
            auditErr
          );
        }
      }
    }
  } catch (err) {
    // Bump aiJobLastPolledAt so we back off after a transient failure rather
    // than hammering the BFF every tick.
    await prisma.document.update({
      where: { id: documentId },
      data: { aiJobLastPolledAt: new Date() },
    });
    console.error(`[ai-poller] poll failed for doc=${documentId} job=${jobId}:`, err);
  }
}
