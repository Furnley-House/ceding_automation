import { useCallback, useEffect, useMemo, useState } from "react";
import { useDocuments, getSignedUrl } from "@/hooks/useDocuments";
import { useExtractionStatus, type ExtractionStatus } from "@/hooks/useExtractionStatus";
import { DocumentList } from "./DocumentList";
import { PdfViewer } from "./PdfViewer";
import { ChecklistPanel } from "./ChecklistPanel";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, CircleAlert, RotateCcw } from "lucide-react";
import { api, documentsApi } from "@/lib/api";
import { toast } from "sonner";

interface Props {
  caseId: string;
  planType: string;
}

const STAGE_LABEL: Record<string, string> = {
  stage1: "Reading PDF",
  stage2: "Detecting provider",
  stage3: "Mapping fields",
  stage4: "Extracting values",
  done: "Finalising",
};

/**
 * Stage 3 — side-by-side workspace.
 * Left: document list + PDF viewer.
 * Right: live checklist with field-to-page jump.
 */
export function ExtractionWorkspace({ caseId, planType }: Props) {
  const {
    documents,
    loading,
    refresh: refreshDocuments,
    removeDocument,
  } = useDocuments(caseId, { refreshInterval: 5000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [jumpRequest, setJumpRequest] = useState<{ page: number; banner: string; nonce: number } | null>(
    null,
  );
  // Counter bumped when extraction completes — passed to ChecklistPanel to
  // trigger a refetch so newly-extracted fields show up without a manual reload.
  const [checklistRefreshSignal, setChecklistRefreshSignal] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  // Pure UPLOADED-count: behaves correctly both pre-S3c (auto-fire on → most
  // docs already PROCESSING → 0 pending) and post-S3c (uploads stay UPLOADED).
  // Strict equality — null/undefined status must NOT count as pending.
  const pendingCount = documents.filter((d) => d.status === "UPLOADED").length;

  const handleExtractAll = async () => {
    setBatchSubmitting(true);
    try {
      const { data } = await documentsApi.extractPending(caseId);
      toast.success(
        `Extraction started for ${data.count} document${data.count === 1 ? "" : "s"}`,
      );
      refreshDocuments();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      toast.error("Couldn't start batch extraction", {
        description: err.response?.data?.error ?? err.message ?? "Please try again",
      });
    } finally {
      setBatchSubmitting(false);
    }
  };

  // Auto-select the first document
  useEffect(() => {
    if (!selectedId && documents.length > 0) setSelectedId(documents[0].id);
  }, [documents, selectedId]);

  // Load signed URL for the selected document.
  //
  // getSignedUrl now returns a blob:// object URL (the PDF is streamed
  // through the backend to dodge Azure Blob CORS). We have to revoke the
  // previous URL when the selection changes or the component unmounts —
  // otherwise the underlying Blob is pinned in memory for the page lifetime.
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
      const doc = documents.find((d) => d.id === selectedId);
      if (!doc) {
        setPdfUrl((prev) => {
          if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
          return null;
        });
        return;
      }
      const url = await getSignedUrl(caseId, doc.id);
      if (cancelled) {
        if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
        return;
      }
      createdUrl = url;
      setPdfUrl((prev) => {
        if (prev && prev !== url && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
        return url;
      });
    })();
    return () => {
      cancelled = true;
      if (createdUrl && createdUrl.startsWith("blob:")) URL.revokeObjectURL(createdUrl);
    };
  }, [selectedId, documents, caseId]);

  const selectedDoc = useMemo(
    () => documents.find((d) => d.id === selectedId) ?? null,
    [documents, selectedId],
  );

  const handleExtractionComplete = useCallback(() => {
    // Tell the checklist panel to refetch (new field values), and refresh the
    // document list so its row status flips from PROCESSING → EXTRACTED.
    setChecklistRefreshSignal((n) => n + 1);
    refreshDocuments();
  }, [refreshDocuments]);

  // Only poll for the selected document. If the selected doc isn't actively
  // being processed, the hook returns the empty status and skips polling.
  const selectedStatus = ((selectedDoc as { status?: string } | null)?.status) ?? null;
  const extractionStatus: ExtractionStatus = useExtractionStatus(
    caseId,
    selectedStatus === "PROCESSING" ? selectedId : null,
    handleExtractionComplete,
  );

  // ── Stage 4 wait detection + smooth progress crawl + 1Hz elapsed timer ──
  // The BFF pipeline emits stage1→25, stage2→50, stage3→75 pings and a
  // terminal done→100. Stage 4 runs a ~20s GPT call with NO ping, so the
  // DB sits at stage3/75 until completion. Without these effects the bar
  // would freeze at 75% for ~20s, then snap straight to 100%.
  const [displayedPct, setDisplayedPct] = useState<number | null>(null);
  const [displayedSeconds, setDisplayedSeconds] = useState(0);

  const inStage4Wait =
    extractionStatus.status === "processing" &&
    extractionStatus.progressPct === 75 &&
    (extractionStatus.stage === "stage3" || extractionStatus.stage === "stage4");
  const rawStageMatch = extractionStatus.stage?.match(/^stage(\d)$/);
  const rawStageNum = rawStageMatch ? rawStageMatch[1] : null;
  const rawLabel = extractionStatus.stage
    ? STAGE_LABEL[extractionStatus.stage] ?? extractionStatus.stage
    : null;
  // During Stage 4 the DB still reads stage3 (Stage 4 emits no ping), but
  // Stage 3 is done — show the truthful "Extracting values" label.
  const displayedLabel = inStage4Wait ? STAGE_LABEL.stage4 : rawLabel;
  const displayedStageNum = inStage4Wait ? "4" : rawStageNum;

  // Reset crawl + timer cleanly when the selected document changes.
  useEffect(() => {
    setDisplayedPct(null);
    setDisplayedSeconds(0);
  }, [selectedId]);

  // Crawl: outside the Stage 4 wait, mirror the real anchor 1:1 (CSS
  // transition-all eases the small 25→50→75 hops). Inside the wait, ease
  // from 75 toward a 95% cap — each 500ms tick closes 10% of the remaining
  // gap (asymptotic; ~94.7% after 20s). The effect tears down on any
  // anchor change, so a fresh real value (e.g. 100 on done) wins
  // immediately and the bar can never undershoot truth with stale crawl.
  useEffect(() => {
    if (!inStage4Wait) {
      setDisplayedPct(extractionStatus.progressPct);
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
  }, [inStage4Wait, extractionStatus.progressPct]);

  // 1Hz local timer anchored to server elapsedMs. The hook only polls
  // every 3s so the local interval drives the display between polls; the
  // re-sync on each fresh elapsedMs corrects drift.
  useEffect(() => {
    if (typeof extractionStatus.elapsedMs !== "number") {
      setDisplayedSeconds(0);
      return;
    }
    setDisplayedSeconds(Math.floor(extractionStatus.elapsedMs / 1000));
    if (
      extractionStatus.status !== "processing" &&
      extractionStatus.status !== "queued"
    ) {
      return;
    }
    const intervalId = setInterval(() => {
      setDisplayedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(intervalId);
  }, [extractionStatus.elapsedMs, extractionStatus.status]);

  const handleJumpToSource = (sourcePage: number | null, fieldLabel: string, evidenceSource: string | null) => {
    if (!sourcePage) return;
    // If the field cites a different document, switch to it
    if (evidenceSource) {
      const match = documents.find(
        (d) => ((d as any).original_name ?? (d as any).file_name) === evidenceSource
      );
      if (match && match.id !== selectedId) {
        setSelectedId(match.id);
      }
    }
    setJumpRequest({ page: sourcePage, banner: fieldLabel, nonce: Date.now() });
  };

  const handleRetry = async () => {
    if (!selectedId) return;
    setRetrying(true);
    try {
      await api.post(`/cases/${caseId}/documents/${selectedId}/extract`);
      toast.success("Extraction restarted", {
        description: "AI is reading your document again. Watch the progress bar.",
      });
      refreshDocuments();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      toast.error("Retry failed", {
        description: err.response?.data?.error ?? err.message ?? "Please try again",
      });
    } finally {
      setRetrying(false);
    }
  };

  // ── Banner content for the selected document's extraction state ─────────
  // We render a banner when the selected doc is mid-extraction or in a
  // terminal state we still want to call out (failed / just-completed).
  const banner = renderExtractionBanner(
    selectedStatus,
    extractionStatus,
    retrying,
    handleRetry,
    displayedPct,
    displayedLabel,
    displayedStageNum,
    displayedSeconds,
  );

  return (
    <div className="space-y-3">
      {/* <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {/* <Sparkles className="h-3.5 w-3.5 text-teal" /> */}
        {/* Click 📄 next to any field on the right to jump the PDF to its source page. 
      </div> */}

      {banner}

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Left: documents + viewer */}
        <div className="flex flex-col gap-3 lg:h-[700px]">
          <div className="flex items-center justify-end">
            <Button
              size="sm"
              onClick={handleExtractAll}
              disabled={batchSubmitting || pendingCount === 0}
              className="h-8 gap-1.5"
              title={
                pendingCount === 0
                  ? "No documents pending extraction"
                  : `Run extraction on ${pendingCount} pending document${pendingCount === 1 ? "" : "s"}`
              }
            >
              {batchSubmitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {pendingCount === 0 ? "Extract" : `Extract (${pendingCount})`}
            </Button>
          </div>
          <div className="rounded-md border border-border bg-card p-2.5 max-h-[200px] overflow-auto">
            <DocumentList
              documents={documents}
              caseId={caseId}
              planType={planType}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRemove={async (d) => {
                await removeDocument(d);
                if (d.id === selectedId) setSelectedId(null);
              }}
              // Refresh the doc list whenever an inline action (retry,
              // cancel) settles — without this the "Extracting…" badge
              // wouldn't flip to "Error" until the next ai-status poll
              // tick (3s) or a manual refresh.
              onExtractionDone={refreshDocuments}
            />
            {loading && (
              <p className="text-[10px] text-muted-foreground text-center py-2">Loading documents…</p>
            )}
          </div>

          <div className="flex-1 rounded-md border border-border bg-card overflow-hidden min-h-[400px]">
            <PdfViewer
              url={pdfUrl}
              fileName={(selectedDoc as any)?.original_name ?? (selectedDoc as any)?.file_name}
              jumpToPage={jumpRequest?.page ?? null}
              jumpBanner={jumpRequest?.banner ?? null}
            />
          </div>
        </div>

        {/* Right: checklist (DB-backed) */}
        <div className="lg:h-[700px] overflow-auto">
          <ChecklistPanel
            planType={planType}
            caseId={caseId}
            onJumpToSource={handleJumpToSource}
            refreshSignal={checklistRefreshSignal}
          />
        </div>
      </div>
    </div>
  );
}

function renderExtractionBanner(
  documentStatus: string | null,
  extraction: ExtractionStatus,
  retrying: boolean,
  onRetry: () => void,
  displayedPct: number | null,
  displayedLabel: string | null,
  displayedStageNum: string | null,
  displayedSeconds: number,
) {
  // No selection → nothing.
  if (!documentStatus) return null;

  // Failed → red banner with retry. Trust the live status if available,
  // otherwise fall back to the row-level ERROR state.
  if (extraction.status === "failed" || documentStatus === "ERROR") {
    return (
      <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3">
        <CircleAlert className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-destructive">Extraction failed</p>
          {extraction.error && (
            <p className="text-[11px] text-destructive/90 mt-0.5 break-words">
              {extraction.error}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={retrying}
          className="h-7 gap-1"
        >
          {retrying ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          Retry
        </Button>
      </div>
    );
  }

  // Active extraction (live BFF status) → progress bar + stage text + timer.
  // Label, stage number, and pct are pre-computed in the parent so the
  // Stage 4 override + smooth crawl + 1Hz timer all flow in here ready to
  // render. The bar's CSS transition-all eases small hops (25→50→75) and
  // the parent's interval feeds incremental values during the Stage 4 wait.
  if (documentStatus === "PROCESSING") {
    const text =
      extraction.status === "queued"
        ? "Submitted to AI — waiting for pickup…"
        : displayedLabel
          ? displayedStageNum
            ? `${displayedLabel} (stage ${displayedStageNum}/4)`
            : displayedLabel
          : "Extracting…";

    const mm = Math.floor(displayedSeconds / 60);
    const ss = String(displayedSeconds % 60).padStart(2, "0");
    const timer = `${mm}:${ss}`;

    const pct = typeof displayedPct === "number" ? displayedPct : null;

    return (
      <div className="rounded-md border border-info/30 bg-info/10 p-3">
        <div className="flex items-center gap-3">
          <Loader2 className="h-4 w-4 text-info animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground">
              {text}
              <span className="text-muted-foreground font-normal"> · {timer}</span>
            </p>
            {pct !== null && (
              <div className="mt-1.5 h-1 bg-background rounded overflow-hidden">
                <div
                  className="h-full bg-info transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
          {pct !== null && (
            <span className="text-[11px] font-semibold text-info shrink-0">{Math.round(pct)}%</span>
          )}
        </div>
      </div>
    );
  }

  return null;
}
