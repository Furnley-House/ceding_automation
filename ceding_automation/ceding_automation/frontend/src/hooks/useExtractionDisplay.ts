// frontend/src/hooks/useExtractionDisplay.ts
//
// Shared display layer for AI extraction progress. Takes the real backend
// anchors (progressPct, stage, status, submittedAt) and computes the
// displayed values: smoothly-crawling pct, decoded stage label/number, and
// a 1Hz wall-clock timer.
//
// Used by both the per-row badge in DocumentList (driven by the 5s
// useDocuments list refresh) and the banner in ExtractionWorkspace (driven
// by useExtractionStatus's 3s /ai-status poll). Same math, two sources.
//
// The Stage-4 crawl: between stage3→75 (pipeline's last ping before the
// long GPT call) and done→100 (terminal write), no pings land. Without
// help the bar freezes at 75% for ~20s. This hook smooths it — while in
// the wait, eases toward a 95% cap with a decelerating curve that closes
// 10% of the remaining gap each 500ms tick (asymptotic, never exceeds 95).
// Snaps to truth instantly when the real anchor advances (e.g. done/100).

import { useEffect, useState } from "react";

export const STAGE_LABEL: Record<string, string> = {
  stage1: "Reading PDF",
  stage2: "Detecting provider",
  stage3: "Mapping fields",
  stage4: "Extracting values",
  done: "Finalising",
};

export interface ExtractionAnchors {
  progressPct: number | null;
  stage: string | null;
  status: string | null;
  submittedAt: Date | string | null;
  /**
   * Identity key. When it changes, internal crawl + timer state resets.
   * For per-row use: pass documentId. For the banner: pass selectedId.
   */
  resetKey?: string | null;
}

export interface ExtractionDisplay {
  displayedPct: number | null;
  displayedSeconds: number;
  displayedLabel: string | null;
  displayedStageNum: string | null;
  /**
   * True once raw elapsed exceeds MAX_DISPLAY_SECONDS — by which point the
   * BFF should have failed the job. displayedSeconds freezes at the cap;
   * callers can show "Taking longer than expected" alongside the frozen
   * timer instead of an ever-growing absurd number (1333:36 observed on
   * a stalled multi-doc run before this cap existed).
   */
  isOverdue: boolean;
}

// Mirrors backend JOB_TIMEOUT_MS (10 min). Past this the BFF's own poller
// should have settled the job as failed; if it hasn't, the row is stuck
// and we'd rather freeze the timer than count toward infinity.
const MAX_DISPLAY_SECONDS = 600;

export function useExtractionDisplay({
  progressPct,
  stage,
  status,
  submittedAt,
  resetKey,
}: ExtractionAnchors): ExtractionDisplay {
  const [displayedPct, setDisplayedPct] = useState<number | null>(null);
  const [displayedSeconds, setDisplayedSeconds] = useState(0);
  const [isOverdue, setIsOverdue] = useState(false);

  // Stage 4 wait detection — resilient form: status processing + pct at
  // the 75% anchor + stage label still on stage3 (last ping) or stage4
  // (in case the BFF later changes the label at the 75% mark).
  const inStage4Wait =
    status === "processing" &&
    progressPct === 75 &&
    (stage === "stage3" || stage === "stage4");

  const rawStageMatch = stage?.match(/^stage(\d)$/);
  const rawStageNum = rawStageMatch ? rawStageMatch[1] : null;
  const rawLabel = stage ? STAGE_LABEL[stage] ?? stage : null;
  // Override the stale "stage3" label during the Stage 4 wait — Stage 3
  // is done and Stage 4 is what's actually running, even though the DB
  // still reads stage3 until done/100 lands.
  const displayedLabel = inStage4Wait ? STAGE_LABEL.stage4 : rawLabel;
  const displayedStageNum = inStage4Wait ? "4" : rawStageNum;

  // Reset on identity change (different doc, or extraction restart on
  // the same doc when the caller varies resetKey).
  useEffect(() => {
    setDisplayedPct(null);
    setDisplayedSeconds(0);
    setIsOverdue(false);
  }, [resetKey]);

  // Crawl: outside the Stage 4 wait → mirror the real anchor 1:1.
  // Inside the wait → ease from 75 toward 95 with a 500ms tick that
  // closes 10% of the remaining gap (asymptotic; ~94.7% after 20s).
  // Effect tears down on any anchor change so a fresh real value
  // (e.g. 100 on done) wins immediately — never undershoots truth.
  useEffect(() => {
    if (!inStage4Wait) {
      // Monotonic mirror: a raw anchor of 75 arriving after the crawl
      // has eased to ~90 (the brief window when stage flips from
      // "stage3" to "done" before pct is updated to 100) would otherwise
      // snap the bar backwards 90→75→100. Math.max holds the higher
      // value until truth (100) catches up. Reset between runs is
      // handled by the resetKey effect above (clears prev to null), so
      // a stale high value can never carry into a new extraction.
      setDisplayedPct((prev) =>
        prev !== null && progressPct !== null
          ? Math.max(prev, progressPct)
          : progressPct,
      );
      return;
    }
    setDisplayedPct((prev) => (prev !== null && prev > 75 ? prev : 75));
    const intervalId = setInterval(() => {
      setDisplayedPct((prev) => {
        const base = prev ?? 75;
        const remaining = 95 - base;
        if (remaining <= 0.05) return 95;
        return base + remaining * 0.1;
      });
    }, 500);
    return () => clearInterval(intervalId);
  }, [inStage4Wait, progressPct]);

  // 1Hz timer driven by wall-clock vs submittedAt. Source-agnostic — works
  // identically whether the anchor refreshes every 3s (/ai-status poll) or
  // every 5s (list refresh) because elapsed is recomputed locally from a
  // stable timestamp.
  useEffect(() => {
    if (!submittedAt) {
      setDisplayedSeconds(0);
      setIsOverdue(false);
      return;
    }
    const submittedTs =
      typeof submittedAt === "string"
        ? new Date(submittedAt).getTime()
        : submittedAt.getTime();
    if (!Number.isFinite(submittedTs)) {
      setDisplayedSeconds(0);
      setIsOverdue(false);
      return;
    }
    const tick = () => {
      const raw = Math.max(0, Math.floor((Date.now() - submittedTs) / 1000));
      setIsOverdue(raw > MAX_DISPLAY_SECONDS);
      setDisplayedSeconds(Math.min(raw, MAX_DISPLAY_SECONDS));
    };
    tick();
    if (status !== "processing" && status !== "queued") {
      return;
    }
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [submittedAt, status]);

  return {
    displayedPct,
    displayedSeconds,
    displayedLabel,
    displayedStageNum,
    isOverdue,
  };
}
