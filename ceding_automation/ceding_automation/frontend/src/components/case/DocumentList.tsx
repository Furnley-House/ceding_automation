import { useState } from "react";
import {
  FileText,
  Loader2,
  Sparkles,
  Trash2,
  CheckCircle2,
  CircleAlert,
  Eye,
} from "lucide-react";
import type { DocumentRow } from "@/hooks/useDocuments";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface Props {
  documents: DocumentRow[];
  caseId: string;
  planType: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (doc: DocumentRow) => void;
  onExtractionDone?: () => void;
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

export function DocumentList({
  documents,
  caseId,
  selectedId,
  onSelect,
  onRemove,
  onExtractionDone,
}: Props) {
  const [extractingId, setExtractingId] = useState<string | null>(null);

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
                <FileText className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground truncate">
                  {fileName}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${meta.cls}`}
                  >
                    {rawStatus === "EXTRACTED" && (
                      <CheckCircle2 className="h-2.5 w-2.5" />
                    )}
                    {rawStatus === "ERROR" && (
                      <CircleAlert className="h-2.5 w-2.5" />
                    )}
                    {rawStatus === "PROCESSING" && (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    )}
                    {meta.label}
                  </span>
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
              <Button
                size="sm"
                variant={isSelected ? "default" : "outline"}
                className="h-8 px-2"
                onClick={() => onSelect(d.id)}
                title="View PDF"
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                onClick={() => runExtraction(d)}
                disabled={isExtracting}
                className="h-8 px-2"
                title="Run AI extraction"
              >
                {isExtracting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRemove(d)}
                disabled={isExtracting}
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
