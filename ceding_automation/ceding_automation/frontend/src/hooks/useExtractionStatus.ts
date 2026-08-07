import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * Live state for an AI extraction job on a specific document.
 * Shape matches GET /api/cases/:caseId/documents/:documentId/ai-status.
 */
export interface ExtractionStatus {
  jobId: string | null;
  status: "queued" | "processing" | "completed" | "failed" | null;
  /**
   * The BACKEND document row's status (doc.status) — distinct from `status`
   * above which mirrors doc.aiJobStatus (the BFF pipeline's job state).
   * Wire key `documentStatus` from GET /ai-status (documents.ts:680). This
   * is the load-bearing signal for "scalars are committed" — see the
   * H17 comment at the terminal-guard below.
   */
  documentStatus: "UPLOADED" | "PROCESSING" | "EXTRACTED" | "ERROR" | null;
  stage: string | null;
  progressPct: number | null;
  error: string | null;
  elapsedMs: number | null;
  submittedAt: string | null;
  // Set when the hook stops due to a timeout backstop rather than a
  // real document-level completion. "finalising" = BFF stalled at
  // stage=done for FINALISING_BACKSTOP_MS; "total" = MAX_TOTAL_MS hard
  // cap tripped. onComplete is NOT fired in either case — the UI can
  // render "still finalising, refresh to check" instead.
  timedOut: "finalising" | "total" | null;
}

const EMPTY_STATUS: ExtractionStatus = {
  jobId: null,
  status: null,
  documentStatus: null,
  stage: null,
  progressPct: null,
  error: null,
  elapsedMs: null,
  submittedAt: null,
  timedOut: null,
};

const BASE_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 30000;
const STOP_AFTER_429_COUNT = 3;
// Backstop for the "Finalising · 100%" stall: stop after this much
// continuous stage=done/pct>=100 without documents.status flipping to
// EXTRACTED/ERROR. 90s covers the observed 35s poller-apply gap on
// job bff-cbaa1d9c2423 plus headroom. Signals timedOut="finalising",
// does NOT fire onComplete.
const FINALISING_BACKSTOP_MS = 90_000;
// Total-elapsed hard cap. Matches backend aiBffPoller JOB_TIMEOUT_MS
// so a doc that never settles server-side can't spin the client
// forever. Signals timedOut="total", does NOT fire onComplete.
const MAX_TOTAL_MS = 15 * 60_000;

/**
 * Poll the backend for AI extraction progress on a specific document.
 *
 * Polls every 3s until the job reaches a terminal state ("completed" or
 * "failed"). Cleans up on unmount and on documentId change. If documentId
 * is null the hook returns the empty status and does no polling.
 *
 * `onComplete` fires exactly once when status transitions to "completed".
 * The latest callback closure is captured via a ref so passing a fresh
 * arrow function on every render doesn't tear down the polling cycle.
 *
 * S2 (Stage 3/4 redesign, Decision 5): the poll loop uses self-rescheduling
 * setTimeout (not setInterval) so it can grow the delay between ticks on
 * error. Exponential backoff to a 30s cap on any error; reset to 3s on the
 * next 200. Stop polling entirely after 3 consecutive 429s — preventing
 * the click-spam-into-a-429-wall pattern that bit UAT before /ai-status was
 * exempted from the limiter. The hook only resumes after a caseId or
 * documentId change re-mounts the effect.
 */
export function useExtractionStatus(
  caseId: string,
  documentId: string | null,
  onComplete?: () => void
): ExtractionStatus {
  const [state, setState] = useState<ExtractionStatus>(EMPTY_STATUS);
  const onCompleteRef = useRef(onComplete);
  const completeFiredRef = useRef(false);

  // Keep the latest onComplete in a ref so the effect below can stay scoped
  // to caseId / documentId without re-mounting the poller each render.
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    setState(EMPTY_STATUS);
    completeFiredRef.current = false;

    if (!documentId) return;

    let stopped = false;
    let currentDelay = BASE_INTERVAL_MS;
    let consecutive429s = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // Measured from the FIRST tick, not from effect mount, so the cap
    // doesn't start burning down before we've made a single request.
    let firstTickAt: number | null = null;
    // Timestamp of the first tick where reachedFinalising was true.
    // Never reset once set, so a bouncing stage=done state can't push
    // the backstop out repeatedly.
    let finalisingSince: number | null = null;

    const schedule = () => {
      if (stopped) return;
      timeoutId = setTimeout(tick, currentDelay);
    };

    const tick = async () => {
      if (stopped) return;
      if (firstTickAt === null) firstTickAt = Date.now();
      try {
        const res = await api.get(
          `/cases/${caseId}/documents/${documentId}/ai-status`
        );
        // Success: reset backoff and 429 counter.
        consecutive429s = 0;
        currentDelay = BASE_INTERVAL_MS;

        const data = (res.data ?? {}) as Record<string, unknown>;
        const next: ExtractionStatus = {
          jobId: typeof data.jobId === "string" ? data.jobId : null,
          status:
            data.status === "queued" ||
            data.status === "processing" ||
            data.status === "completed" ||
            data.status === "failed"
              ? data.status
              : null,
          documentStatus:
            data.documentStatus === "UPLOADED" ||
            data.documentStatus === "PROCESSING" ||
            data.documentStatus === "EXTRACTED" ||
            data.documentStatus === "ERROR"
              ? data.documentStatus
              : null,
          stage: typeof data.stage === "string" ? data.stage : null,
          progressPct:
            typeof data.progressPct === "number" ? data.progressPct : null,
          error: typeof data.error === "string" ? data.error : null,
          elapsedMs:
            typeof data.elapsedMs === "number" ? data.elapsedMs : null,
          submittedAt:
            typeof data.submittedAt === "string" ? data.submittedAt : null,
          timedOut: null,
        };
        setState(next);

        // Track when we first entered the "Finalising · 100%" plateau.
        // Once set, never reset — a bouncing stage=done state must not
        // be able to keep pushing the backstop out.
        const reachedFinalising =
          next.stage === "done" && (next.progressPct ?? 0) >= 100;
        if (reachedFinalising && finalisingSince === null) {
          finalisingSince = Date.now();
        }

        // H17 fix — the stop condition and the onComplete condition must
        // both key off documents.status so they can't race. Previously
        // stopped=true fired on aiJobStatus="completed" while onComplete
        // waited for documentStatus="EXTRACTED"; those flip ~1s apart on
        // the poll path (observed 35s on job bff-cbaa1d9c2423, since the
        // BFF poller writes aiJobStatus first, then applies ~65 fields,
        // then finally writes doc.status inside applyExtractionResult's
        // single UPDATE). The loop would stop mid-race, onComplete never
        // fire, and no refetch happen — leaving the panel empty.
        //
        // Both success paths (PUSH via documents.ts:815; PULL via
        // aiBffApply.ts:341) set doc.status="EXTRACTED" in the SAME
        // UPDATE as aiJobCompletedAt, always after the field writes. So
        // documentStatus="EXTRACTED" is the single load-bearing signal
        // that scalars are committed. Symmetric on the failure side:
        // both paths write doc.status="ERROR" (documents.ts:766-775 →
        // :815; aiBffPoller.ts:246-253 + timeOutStaleJobs :96-100).
        const docTerminal =
          next.documentStatus === "EXTRACTED" ||
          next.documentStatus === "ERROR";
        const backstopFired =
          finalisingSince !== null &&
          Date.now() - finalisingSince >= FINALISING_BACKSTOP_MS;
        const totalCapFired =
          firstTickAt !== null && Date.now() - firstTickAt >= MAX_TOTAL_MS;

        if (docTerminal) {
          stopped = true;
          if (!completeFiredRef.current) {
            completeFiredRef.current = true;
            onCompleteRef.current?.();
          }
          return; // real terminal — no more polling
        }
        if (backstopFired || totalCapFired) {
          // A timeout is NOT a completion. Firing onComplete here would
          // refetch a checklist that may not be populated yet and mark
          // the job "done" in the UI. Instead, stop the loop and set
          // timedOut so the caller can render a "still finalising,
          // refresh to check" hint.
          stopped = true;
          setState((s) => ({
            ...s,
            timedOut: backstopFired ? "finalising" : "total",
          }));
          return;
        }
      } catch (err) {
        const httpStatus = (err as { response?: { status?: number } })?.response
          ?.status;
        if (httpStatus === 429) {
          consecutive429s++;
          if (consecutive429s >= STOP_AFTER_429_COUNT) {
            console.error(
              "[useExtractionStatus] 3 consecutive 429s — stopping poller",
            );
            stopped = true;
            return; // bail — won't resume until the effect re-mounts
          }
        } else {
          consecutive429s = 0;
        }
        // Exponential backoff up to MAX. Recovers to BASE on next 200.
        currentDelay = Math.min(currentDelay * 2, MAX_INTERVAL_MS);
        console.error("[useExtractionStatus]", err);
      }
      schedule();
    };

    void tick(); // fire immediately on mount, then self-reschedule

    return () => {
      stopped = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [caseId, documentId]);

  return state;
}
