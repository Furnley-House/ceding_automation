import { useEffect, useMemo, useState } from "react";
import { useDocuments, getSignedUrl, type DocumentRow } from "@/hooks/useDocuments";
import { DocumentList } from "./DocumentList";
import { PdfViewer } from "./PdfViewer";
import { ChecklistPanel } from "./ChecklistPanel";
import { Sparkles } from "lucide-react";

interface Props {
  caseId: string;
  planType: string;
}

/**
 * Stage 3 — side-by-side workspace.
 * Left: document list + PDF viewer.
 * Right: live checklist with field-to-page jump.
 */
export function ExtractionWorkspace({ caseId, planType }: Props) {
  const { documents, loading, removeDocument } = useDocuments(caseId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [jumpRequest, setJumpRequest] = useState<{ page: number; banner: string; nonce: number } | null>(
    null,
  );

  // Auto-select the first document
  useEffect(() => {
    if (!selectedId && documents.length > 0) setSelectedId(documents[0].id);
  }, [documents, selectedId]);

  // Load signed URL for the selected document
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const doc = documents.find((d) => d.id === selectedId);
      if (!doc) {
        setPdfUrl(null);
        return;
      }
      const url = await getSignedUrl(caseId, doc.id);
      if (!cancelled) setPdfUrl(url);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, documents, caseId]);

  const selectedDoc = useMemo(
    () => documents.find((d) => d.id === selectedId) ?? null,
    [documents, selectedId],
  );

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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 text-teal" />
        Click 📄 next to any field on the right to jump the PDF to its source page.
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Left: documents + viewer */}
        <div className="flex flex-col gap-3 lg:h-[700px]">
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
          <ChecklistPanel planType={planType} caseId={caseId} onJumpToSource={handleJumpToSource} />
        </div>
      </div>
    </div>
  );
}
