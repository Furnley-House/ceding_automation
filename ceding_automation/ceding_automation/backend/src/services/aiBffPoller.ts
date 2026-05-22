// backend/src/services/aiBffPoller.ts
// Background poller — safety net for BFF write-backs that never land
// (network blip, BFF→backend unreachable, backend was redeploying).
// Write-back is the primary path; this is the secondary, idempotent path.
//
// Contract: docs/ai-integration-design.md §6.

import { PrismaClient } from "@prisma/client";
import * as aiBff from "./aiBffClient";
import { applyExtractionResult } from "./aiBffApply";

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
// Single bulk updateMany is cheap and atomic per row.
async function timeOutStaleJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - JOB_TIMEOUT_MS);
  const result = await prisma.document.updateMany({
    where: {
      aiJobStatus: { in: ["queued", "processing"] },
      aiJobSubmittedAt: { lt: cutoff },
    },
    data: {
      status: "ERROR",
      aiJobStatus: "failed",
      aiJobError: "Timed out waiting for BFF after 10 minutes",
      aiJobCompletedAt: new Date(),
    },
  });
  if (result.count > 0) {
    console.warn(`[ai-poller] timed out ${result.count} stale BFF job(s)`);
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
      // Fetch full result and run through the shared apply path. Idempotent
      // via aiJobCompletedAt check inside applyExtractionResult.
      const result = await aiBff.getJobResult(jobId);
      await applyExtractionResult(documentId, result);
    } else if (status.status === "failed") {
      // BFF says failed — settle the document here. The write-back path may
      // have already done this; the idempotency guard in PATCH covers that.
      await prisma.document.updateMany({
        where: { id: documentId, aiJobCompletedAt: null },
        data: {
          status: "ERROR",
          aiJobCompletedAt: new Date(),
          aiJobError: "BFF reported failed (no details)",
        },
      });
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
