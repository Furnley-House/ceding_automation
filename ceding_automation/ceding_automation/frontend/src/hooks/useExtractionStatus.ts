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

const POLL_INTERVAL_MS = 3000;

/**
 * Poll the backend for AI extraction progress on a specific document.
 *
 * Polls every 3s until the job reaches a terminal state ("completed" or
 * "failed"). Cleans up on unmount and on documentId change. If documentId
 * is null the hook returns the empty status and does no polling.
 *
 * `onComplete` fires exactly once when status transitions to "completed".
 * The latest callback closure is captured via a ref so passing a fresh
 * arrow function on every render doesn't tear down the interval.
 *
 * Mirrors the pollRef pattern in CallWorkspace.tsx (ring-out status).
 */
export function useExtractionStatus(
  caseId: string,
  documentId: string | null,
  onComplete?: () => void
): ExtractionStatus {
  const [state, setState] = useState<ExtractionStatus>(EMPTY_STATUS);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompleteRef = useRef(onComplete);
  const completeFiredRef = useRef(false);

  // Keep the latest onComplete in a ref so the effect below can stay scoped
  // to caseId / documentId without re-mounting the interval each render.
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    setState(EMPTY_STATUS);
    completeFiredRef.current = false;

    if (!documentId) return;

    const tick = async () => {
      try {
        const res = await api.get(
          `/cases/${caseId}/documents/${documentId}/ai-status`
        );
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
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          if (next.status === "completed" && !completeFiredRef.current) {
            completeFiredRef.current = true;
            onCompleteRef.current?.();
          }
        }
      } catch (err) {
        // A single failed poll shouldn't crash the parent. Log and let the
        // next tick retry — the interval keeps running.
        console.error("[useExtractionStatus]", err);
      }
    };

    void tick();
    pollRef.current = setInterval(tick, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [caseId, documentId]);

  return state;
}
