import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * Live state for an AI extraction job on a specific document.
 * Shape matches GET /api/cases/:caseId/documents/:documentId/ai-status.
 */
export interface ExtractionStatus {
  jobId: string | null;
  status: "queued" | "processing" | "completed" | "failed" | null;
  stage: string | null;
  progressPct: number | null;
  error: string | null;
  elapsedMs: number | null;
}

const EMPTY_STATUS: ExtractionStatus = {
  jobId: null,
  status: null,
  stage: null,
  progressPct: null,
  error: null,
  elapsedMs: null,
};

const BASE_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 30000;
const STOP_AFTER_429_COUNT = 3;

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

    const schedule = () => {
      if (stopped) return;
      timeoutId = setTimeout(tick, currentDelay);
    };

    const tick = async () => {
      if (stopped) return;
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
          stage: typeof data.stage === "string" ? data.stage : null,
          progressPct:
            typeof data.progressPct === "number" ? data.progressPct : null,
          error: typeof data.error === "string" ? data.error : null,
          elapsedMs:
            typeof data.elapsedMs === "number" ? data.elapsedMs : null,
        };
        setState(next);

        if (next.status === "completed" || next.status === "failed") {
          stopped = true;
          if (next.status === "completed" && !completeFiredRef.current) {
            completeFiredRef.current = true;
            onCompleteRef.current?.();
          }
          return; // terminal — do not reschedule
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
