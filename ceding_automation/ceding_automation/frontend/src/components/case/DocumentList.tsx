import { useState } from "react";
import {
  FileText,
  FileSpreadsheet,
  FileType,
  File as FileIcon,
  Loader2,
  Sparkles,
  Trash2,
  CheckCircle2,
  CircleAlert,
  Eye,
  StopCircle,
} from "lucide-react";
import type { DocumentRow } from "@/hooks/useDocuments";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useExtractionDisplay } from "@/hooks/useExtractionDisplay";

interface Props {
  documents: DocumentRow[];
  caseId: string;
  planType: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (doc: DocumentRow) => void;
  onExtractionDone?: () => void;
  // S1 (Stage 3/4 redesign, Decision 1): let upload-only callers (Stage 3)
  // suppress the per-row extract (✨) and view (👁) buttons. Stage 4 leaves
  // these undefined and inherits the true defaults so its UX is unchanged.
  showExtractButton?: boolean;
  showViewButton?: boolean;
  // Stage 3 only: collapse the badge to a two-state Uploaded / Extracted
  // pair. Skips ExtractingStatusBadge entirely — no crawl, no timer, no %.
  // Stage 4 omits this and keeps the live extraction-progress badge.
  simplifiedBadge?: boolean;
}

// Maps Prisma DocumentStatus enum values to display labels/styles
const STATUS_META: Record<string, { label: string; cls: string }> = {
  UPLOADED:   { label: "Pending",      cls: "bg-muted text-muted-foreground" },
  PROCESSING: { label: "Extracting…",  cls: "bg-blue-500/15 text-blue-600" },
  EXTRACTED:  { label: "Extracted",    cls: "bg-success/15 text-success" },
  ERROR:      { label: "Error",        cls: "bg-destructive/15 text-destructive" },
};

/** Return the human-readable filename from either schema version */
function getFileName(d: DocumentRow): string {
  return (
    (d as any).original_name ??
    (d as any).originalName ??
    (d as any).file_name ??
    "Unnamed document"
  );
}

/**
 * Format the extraction duration for a completed doc as M:SS (e.g. "0:38",
 * "1:24"). Prefers the cached extraction_ms; falls back to subtracting the
 * two timestamps when the cache is null (cancel/timeout paths). Returns null
 * when neither is available — caller renders just "Extracted" with no time.
 */
function formatExtractionDuration(d: DocumentRow): string | null {
  let ms: number | null = null;
  if (typeof d.extraction_ms === "number" && d.extraction_ms > 0) {
    ms = d.extraction_ms;
  } else if (
    typeof d.ai_job_submitted_at === "string" &&
    typeof d.ai_job_completed_at === "string"
  ) {
    const submitted = new Date(d.ai_job_submitted_at).getTime();
    const completed = new Date(d.ai_job_completed_at).getTime();
    if (Number.isFinite(submitted) && Number.isFinite(completed)) {
      const delta = completed - submitted;
      if (delta > 0) ms = delta;
    }
  }
  if (ms === null) return null;
  const seconds = Math.floor(ms / 1000);
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Pick a file-type icon + tint based on extension or MIME. Keeps the doc list
 * scannable when a case has a mix of provider PDFs, Excel illustrations and
 * Word notes.
 */
function getFileTypeIcon(d: DocumentRow): { Icon: typeof FileText; cls: string } {
  const name = getFileName(d).toLowerCase();
  const mime = ((d as any).mime_type ?? (d as any).mimeType ?? "").toLowerCase();

  if (name.endsWith(".pdf") || mime === "application/pdf") {
    return { Icon: FileText, cls: "text-overdue" };
  }
  if (
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    mime.includes("spreadsheet") ||
    mime === "application/vnd.ms-excel"
  ) {
    return { Icon: FileSpreadsheet, cls: "text-success" };
  }
  if (
    name.endsWith(".docx") ||
    name.endsWith(".doc") ||
    mime.includes("wordprocessingml") ||
    mime === "application/msword"
  ) {
    return { Icon: FileType, cls: "text-info" };
  }
  if (name.endsWith(".txt") || mime === "text/plain") {
    return { Icon: FileText, cls: "text-muted-foreground" };
  }
  return { Icon: FileIcon, cls: "text-muted-foreground" };
}

export function DocumentList({
  documents,
  caseId,
  selectedId,
  onSelect,
  onRemove,
  onExtractionDone,
  showExtractButton = true,
  showViewButton = true,
  simplifiedBadge = false,
}: Props) {
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const runExtraction = async (doc: DocumentRow) => {
    setExtractingId(doc.id);
    try {
      await api.post(`/cases/${caseId}/documents/${doc.id}/extract`);
      toast.success("Extraction started", {
        description:
          "AI is reading your document. Results will appear in the checklist once complete.",
      });
      onExtractionDone?.();
    } catch (e: any) {
      console.error("extraction error", e);
      toast.error("Extraction failed", {
        description:
          e?.response?.data?.error ?? e?.message ?? "Please retry",
      });
    } finally {
      setExtractingId(null);
    }
  };

  const cancelExtraction = async (doc: DocumentRow) => {
    setCancellingId(doc.id);
    try {
      await api.post(`/cases/${caseId}/documents/${doc.id}/cancel`);
      toast.success("Extraction stopped", {
        description:
          "The document is now marked as Error. You can retry, remove it, or upload a new document.",
      });
      // Refresh the list so the badge flips from "Extracting…" to "Error".
      onExtractionDone?.();
    } catch (e: any) {
      console.error("cancel extraction error", e);
      toast.error("Couldn't stop extraction", {
        description:
          e?.response?.data?.error ?? e?.message ?? "Please retry",
      });
    } finally {
      setCancellingId(null);
    }
  };

  if (documents.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic text-center py-8">
        No documents yet — upload provider packs above to start extraction.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {documents.map((d) => {
        const rawStatus = ((d as any).status ?? "UPLOADED") as string;
        const meta = STATUS_META[rawStatus] ?? STATUS_META.UPLOADED;
        const isSelected = d.id === selectedId;
        const isExtracting = extractingId === d.id || rawStatus === "PROCESSING";
        const fileName = getFileName(d);
        const errorMsg = (d as any).error_message ?? (d as any).extraction_error;
        const { Icon: TypeIcon, cls: typeIconCls } = getFileTypeIcon(d);
        // Display "Extracted · 0:38" once a doc completes — null on non-
        // EXTRACTED rows or when neither the cached number nor both
        // timestamps are usable (graceful fallback to just "Extracted").
        const extractedDuration =
          rawStatus === "EXTRACTED" ? formatExtractionDuration(d) : null;

        return (
          <li
            key={d.id}
            className={`flex items-center gap-3 rounded-md border p-2.5 transition-colors ${
              isSelected
                ? "border-primary bg-primary/5"
                : "border-border bg-card hover:bg-muted/30"
            }`}
          >
            {/* Clickable area — name + status */}
            <button
              onClick={() => onSelect(d.id)}
              className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
            >
              <div className="h-9 w-9 rounded bg-muted flex items-center justify-center shrink-0">
                <TypeIcon className={`h-4 w-4 ${typeIconCls}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground truncate">
                  {fileName}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  {simplifiedBadge ? (
                    rawStatus === "EXTRACTED" ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-success/15 text-success">
                        <CheckCircle2 className="h-2.5 w-2.5" />
                        Extracted{extractedDuration ? ` · ${extractedDuration}` : ""}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-muted text-muted-foreground">
                        Uploaded
                      </span>
                    )
                  ) : rawStatus === "PROCESSING" ? (
                    <ExtractingStatusBadge row={d} />
                  ) : (
                    <span
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${meta.cls}`}
                    >
                      {rawStatus === "EXTRACTED" && (
                        <CheckCircle2 className="h-2.5 w-2.5" />
                      )}
                      {rawStatus === "ERROR" && (
                        <CircleAlert className="h-2.5 w-2.5" />
                      )}
                      {meta.label}
                      {extractedDuration ? ` · ${extractedDuration}` : ""}
                    </span>
                  )}
                </div>
                {errorMsg && (
                  <p className="text-[10px] text-destructive mt-0.5 truncate">
                    {errorMsg}
                  </p>
                )}
              </div>
            </button>

            {/* Action buttons */}
            <div className="flex items-center gap-1 shrink-0">
              {showViewButton && (
                <Button
                  size="sm"
                  variant={isSelected ? "default" : "outline"}
                  className="h-8 px-2"
                  onClick={() => onSelect(d.id)}
                  title="View PDF"
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              )}
              {/* Stop button — only when extraction is in flight. Lets the
                  user unblock themselves from a stale "Extracting…" badge
                  so they can retry, remove, or upload a different document. */}
              {rawStatus === "PROCESSING" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => cancelExtraction(d)}
                  disabled={cancellingId === d.id}
                  className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/40"
                  title="Stop extraction"
                >
                  {cancellingId === d.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <StopCircle className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
              {showExtractButton && (
                <Button
                  size="sm"
                  onClick={() => runExtraction(d)}
                  disabled={isExtracting}
                  className="h-8 px-2"
                  title={isExtracting ? "Extraction in progress" : "Run AI extraction"}
                >
                  {isExtracting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRemove(d)}
                // Allow remove even mid-extraction — the cancel endpoint
                // would have handled it, but if the user wants to skip the
                // intermediate step and just delete, that's still fine
                // because document delete cascades to the BFF job row.
                className="h-8 px-2 text-muted-foreground hover:text-destructive"
                title="Remove document"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Per-row badge for PROCESSING documents. Reads BFF progress straight from
 * the list row (already refreshed every 5s by useDocuments) and runs it
 * through the shared crawl/timer/label hook — same display logic as the
 * banner in ExtractionWorkspace. Zero per-row polling, so N concurrent
 * extractions cost one list refresh instead of N × /ai-status calls.
 */
function ExtractingStatusBadge({ row }: { row: DocumentRow }) {
  const display = useExtractionDisplay({
    progressPct: typeof row.ai_job_progress === "number" ? row.ai_job_progress : null,
    stage: typeof row.ai_job_stage === "string" ? row.ai_job_stage : null,
    status: typeof row.ai_job_status === "string" ? row.ai_job_status : null,
    submittedAt:
      typeof row.ai_job_submitted_at === "string" ? row.ai_job_submitted_at : null,
    resetKey: row.id,
  });

  const isQueued = row.ai_job_status === "queued";
  const text = isQueued
    ? "Waiting in queue…"
    : display.displayedLabel
      ? display.displayedStageNum
        ? `${display.displayedLabel} (${display.displayedStageNum}/4)`
        : display.displayedLabel
      : "Extracting…";

  const mm = Math.floor(display.displayedSeconds / 60);
  const ss = String(display.displayedSeconds % 60).padStart(2, "0");
  const timer = `${mm}:${ss}`;

  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-600">
      <Loader2 className="h-2.5 w-2.5 animate-spin" />
      {text}
      <span className="ml-0.5 opacity-70">· {timer}</span>
      {typeof display.displayedPct === "number" && display.displayedPct > 0 && (
        <span className="ml-0.5 opacity-80">· {Math.round(display.displayedPct)}%</span>
      )}
    </span>
  );
}
