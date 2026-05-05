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
import { supabase } from "@/integrations/supabase/client";
import { useChecklistFields } from "@/hooks/useChecklistFields";
import { mergeExtractedFields, type ExtractedField } from "@/lib/checklistMerge";
import { getTemplate } from "@/lib/checklistTemplates";

interface Props {
  documents: DocumentRow[];
  caseId: string;
  planType: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (doc: DocumentRow) => void;
  onExtractionDone?: () => void;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-muted text-muted-foreground" },
  extracting: { label: "Extracting…", cls: "bg-info/15 text-info" },
  extracted: { label: "Extracted", cls: "bg-success/15 text-success" },
  error: { label: "Error", cls: "bg-overdue/15 text-overdue" },
};

export function DocumentList({
  documents,
  caseId,
  planType,
  selectedId,
  onSelect,
  onRemove,
  onExtractionDone,
}: Props) {
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const template = getTemplate(planType);
  const { rows, refresh } = useChecklistFields({ caseId, template });

  const runExtraction = async (doc: DocumentRow) => {
    setExtractingId(doc.id);
    try {
      const { data, error } = await supabase.functions.invoke("extract-checklist", {
        body: {
          documentId: doc.id,
          planType,
          fields: template.map((t) => ({
            key: t.key,
            label: t.label,
            type: t.type,
            section: t.section,
            options: t.options,
          })),
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const extracted = (data?.extracted ?? []) as ExtractedField[];

      // Merge into checklist_fields with the never-overwrite-human rule
      const existingByKey = new Map(
        rows.filter((r) => r.field_key).map((r) => [r.field_key!, r]),
      );
      const templateLookup = new Map(
        template.map((t) => [t.key, { label: t.label, section: t.section }]),
      );
      const { upserts, skipped } = mergeExtractedFields(extracted, {
        caseId,
        documentName: doc.file_name,
        templateLookup,
        existingByKey,
      });

      if (upserts.length > 0) {
        // Update each row individually using the existing row id
        for (const u of upserts) {
          const existing = existingByKey.get(u.field_key);
          if (existing) {
            await supabase
              .from("checklist_fields")
              .update({
                value: u.value,
                confidence: u.confidence,
                status: u.status,
                source_page: u.source_page,
                evidence_source: u.evidence_source,
                evidence_ref: u.evidence_ref,
                extracted_at: u.extracted_at,
                manually_edited: false,
                notes: u.notes,
              })
              .eq("id", existing.id);
          } else {
            await supabase.from("checklist_fields").insert({
              case_id: u.case_id,
              field_key: u.field_key,
              label: u.label,
              section: u.section,
              value: u.value,
              confidence: u.confidence,
              status: u.status,
              source_page: u.source_page,
              evidence_source: u.evidence_source,
              evidence_ref: u.evidence_ref,
              extracted_at: u.extracted_at,
              manually_edited: false,
              notes: u.notes,
            });
          }
        }

        // Audit log entries
        await supabase.from("field_audit").insert(
          upserts.map((u) => ({
            case_id: caseId,
            field_key: u.field_key,
            field_label: u.label,
            action: "ai_extract",
            source: "ai",
            old_value: existingByKey.get(u.field_key)?.value ?? null,
            new_value: u.value,
            confidence: u.confidence,
            actor_role: "system",
            actor_name: `AI · ${doc.file_name}`,
            notes: u.notes ?? null,
          })),
        );
      }

      toast.success(`Extracted ${upserts.length} field${upserts.length === 1 ? "" : "s"}`, {
        description:
          skipped.length > 0
            ? `${skipped.length} kept as human edits / approvals`
            : "All fields updated from this document",
      });

      await refresh();
      onExtractionDone?.();
    } catch (e: any) {
      console.error("extraction error", e);
      const msg = e?.message ?? "Extraction failed";
      if (msg.includes("Rate limit")) {
        toast.error("AI rate-limited", { description: "Please wait a moment and try again." });
      } else if (msg.includes("credits")) {
        toast.error("AI credits exhausted", {
          description: "Add credits in Settings → Workspace → Usage.",
        });
      } else {
        toast.error("Extraction failed", { description: msg });
      }
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
        const status = d.extraction_status ?? d.status ?? "pending";
        const meta = STATUS_META[status] ?? STATUS_META.pending;
        const isSelected = d.id === selectedId;
        const isExtracting = extractingId === d.id || status === "extracting";
        return (
          <li
            key={d.id}
            className={`flex items-center gap-3 rounded-md border p-2.5 transition-colors ${
              isSelected ? "border-teal bg-teal/5" : "border-border bg-card hover:bg-muted/30"
            }`}
          >
            <button
              onClick={() => onSelect(d.id)}
              className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
            >
              <div className="h-9 w-9 rounded bg-muted flex items-center justify-center shrink-0">
                <FileText className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground truncate">{d.file_name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${meta.cls}`}
                  >
                    {status === "extracted" && <CheckCircle2 className="h-2.5 w-2.5" />}
                    {status === "error" && <CircleAlert className="h-2.5 w-2.5" />}
                    {meta.label}
                  </span>
                  {d.fields_extracted ? (
                    <span className="text-[10px] text-muted-foreground">
                      {d.fields_extracted} fields · {d.avg_confidence ?? 0}% conf
                    </span>
                  ) : null}
                </div>
                {d.extraction_error && (
                  <p className="text-[10px] text-overdue mt-0.5 truncate">{d.extraction_error}</p>
                )}
              </div>
            </button>

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
                title="Extract checklist with AI"
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
                className="h-8 px-2 text-muted-foreground hover:text-overdue"
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
