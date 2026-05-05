import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Use the worker bundled with pdfjs-dist via Vite. Falls back to CDN if needed.
pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;

interface Props {
  url: string | null;
  fileName?: string;
  /** Page to scroll to (1-indexed). Updates trigger jump. */
  jumpToPage?: number | null;
  /** Optional banner text shown above the active page when jumping */
  jumpBanner?: string | null;
}

export function PdfViewer({ url, fileName, jumpToPage, jumpBanner }: Props) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [showBanner, setShowBanner] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // React to external jump
  useEffect(() => {
    if (!jumpToPage) return;
    if (jumpToPage < 1 || jumpToPage > numPages) return;
    setPage(jumpToPage);
    setShowBanner(true);
    const el = pageRefs.current[jumpToPage];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const t = setTimeout(() => setShowBanner(false), 3500);
    return () => clearTimeout(t);
  }, [jumpToPage, numPages]);

  if (!url) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
        <FileText className="h-10 w-10 mb-2 opacity-50" />
        <p className="text-xs">Select a document to preview</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-muted/20">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-card">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground truncate">{fileName ?? "Document"}</p>
          <p className="text-[10px] text-muted-foreground">
            Page {page} of {numPages || "—"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setScale((s) => Math.max(0.5, s - 0.15))}>
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-[10px] text-muted-foreground w-8 text-center">{Math.round(scale * 100)}%</span>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setScale((s) => Math.min(2, s + 0.15))}>
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <div className="w-px h-5 bg-border mx-1" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={page <= 1}
            onClick={() => {
              const next = Math.max(1, page - 1);
              setPage(next);
              pageRefs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={page >= numPages}
            onClick={() => {
              const next = Math.min(numPages, page + 1);
              setPage(next);
              pageRefs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Document */}
      <div ref={wrapperRef} className="flex-1 overflow-auto">
        <Document
          file={url}
          onLoadSuccess={({ numPages }) => setNumPages(numPages)}
          loading={
            <div className="h-full flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mb-2" />
              <p className="text-xs">Loading PDF…</p>
            </div>
          }
          error={
            <div className="h-full flex flex-col items-center justify-center py-16 text-overdue">
              <FileText className="h-10 w-10 mb-2 opacity-50" />
              <p className="text-xs">Could not load the PDF.</p>
            </div>
          }
        >
          {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
            <div
              key={p}
              ref={(el) => (pageRefs.current[p] = el)}
              className="relative flex flex-col items-center py-3"
            >
              {showBanner && p === jumpToPage && jumpBanner && (
                <div className="sticky top-0 z-10 mb-2 px-3 py-1.5 rounded bg-teal text-teal-foreground text-xs font-semibold shadow-md">
                  📄 Source for {jumpBanner}
                </div>
              )}
              <Page
                pageNumber={p}
                scale={scale}
                renderTextLayer
                renderAnnotationLayer={false}
                className="shadow-md border border-border"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Page {p}</p>
            </div>
          ))}
        </Document>
      </div>
    </div>
  );
}
