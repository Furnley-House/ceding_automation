import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Verbatim PDF excerpt to highlight on the jumped-to page. Null disables
   *  highlight (page scroll still happens). Match is best-effort: if the
   *  text-layer search fails the user simply lands on the right page with
   *  no overlay — strictly never worse than the page-only jump. */
  highlightQuote?: string | null;
  /** Bumped per Source click. Lets the viewer clear & re-run the highlight
   *  even when the same field is clicked twice (page + quote unchanged). */
  jumpNonce?: number | null;
}

// Highlight overlay state — one active highlight at a time, scoped to a
// specific page. Coordinates are relative to that page's wrapper div, so
// the overlay tracks with scroll automatically.
interface HighlightRect {
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

// Normalise text for matching: lowercase, collapse all whitespace
// (including NBSP   and SOFT HYPHEN ­ which pdf.js can emit
// inside text-runs), trim. Both haystack and needle go through the same
// pipeline so equal inputs always compare equal.
function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ ­]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Anchor the search on the first ~70 chars of the first non-elided segment
// of the quote. Real samples often contain "..." or "…" elisions that join
// non-contiguous PDF text; matching the FULL quote then fails. The first
// pre-elision segment is reliably present on the page, so we use that.
const QUOTE_ANCHOR_MAX = 70;
const QUOTE_ANCHOR_MIN = 8;
function buildNeedle(quote: string): string | null {
  const firstSegment = quote.split(/\.{3,}|…/)[0] ?? "";
  const needle = normaliseForMatch(firstSegment).slice(0, QUOTE_ANCHOR_MAX);
  return needle.length >= QUOTE_ANCHOR_MIN ? needle : null;
}

export function PdfViewer({
  url,
  fileName,
  jumpToPage,
  jumpBanner,
  highlightQuote,
  jumpNonce,
}: Props) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [showBanner, setShowBanner] = useState(false);
  const [highlightRect, setHighlightRect] = useState<HighlightRect | null>(null);
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

  // Clear the highlight whenever the jump command changes (new field clicked,
  // even same page/quote), the doc switches, or zoom changes (bounding rects
  // computed at the old scale would render misaligned). Highlight is then
  // re-established by maybeHighlight() when the text layer for the new
  // jumped-to page reports render success.
  useEffect(() => {
    setHighlightRect(null);
  }, [jumpNonce, url, scale]);

  // Attempt to highlight the source quote on the given page. Wrapped in
  // try/catch end-to-end — any failure (no spans, weird DOM, missing
  // bounding rects, malformed quote) silently falls back to "no overlay,
  // page jump still happened" so the user never sees a broken state.
  const maybeHighlight = useCallback(
    (pageNum: number) => {
      try {
        if (!highlightQuote) return;
        if (pageNum !== jumpToPage) return;

        const needle = buildNeedle(highlightQuote);
        if (!needle) return;

        const wrapper = pageRefs.current[pageNum];
        if (!wrapper) return;
        const spans = Array.from(
          wrapper.querySelectorAll<HTMLElement>(
            ".react-pdf__Page__textContent span",
          ),
        );
        if (spans.length === 0) return;

        // Concatenate span text into one haystack while tracking which
        // character index range each span occupies. Each non-empty span is
        // separated by a single space — the normaliser already collapses
        // arbitrary whitespace, so this keeps span boundaries findable
        // without distorting the match.
        type SpanRange = { start: number; end: number; el: HTMLElement };
        const ranges: SpanRange[] = [];
        const parts: string[] = [];
        let pos = 0;
        for (const el of spans) {
          const text = normaliseForMatch(el.textContent ?? "");
          if (text.length === 0) continue;
          if (parts.length > 0) {
            parts.push(" ");
            pos += 1;
          }
          parts.push(text);
          ranges.push({ start: pos, end: pos + text.length, el });
          pos += text.length;
        }
        const haystack = parts.join("");
        if (haystack.length === 0) return;

        const matchStart = haystack.indexOf(needle);
        if (matchStart < 0) return;
        const matchEnd = matchStart + needle.length;

        // Pick spans whose [start,end) overlaps [matchStart,matchEnd) — the
        // physical contiguous run that covers the matched substring.
        const hits = ranges.filter((r) => r.start < matchEnd && r.end > matchStart);
        if (hits.length === 0) return;

        // Union the bounding rects, expressing the result in coordinates
        // relative to the page wrapper (which is position: relative). Zero-
        // dimension rects (off-screen / display:none spans) are ignored.
        const wrapperRect = wrapper.getBoundingClientRect();
        let minLeft = Infinity;
        let minTop = Infinity;
        let maxRight = -Infinity;
        let maxBottom = -Infinity;
        for (const r of hits) {
          const rect = r.el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          minLeft = Math.min(minLeft, rect.left - wrapperRect.left);
          minTop = Math.min(minTop, rect.top - wrapperRect.top);
          maxRight = Math.max(maxRight, rect.right - wrapperRect.left);
          maxBottom = Math.max(maxBottom, rect.bottom - wrapperRect.top);
        }
        if (!isFinite(minLeft) || !isFinite(minTop)) return;

        setHighlightRect({
          page: pageNum,
          left: minLeft,
          top: minTop,
          width: maxRight - minLeft,
          height: maxBottom - minTop,
        });
      } catch {
        // Fail silent — page jump still landed correctly; the user just
        // doesn't get an overlay this time.
      }
    },
    [highlightQuote, jumpToPage],
  );

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
                onRenderTextLayerSuccess={() => maybeHighlight(p)}
              />
              {/* Source-quote highlight overlay. Absolutely positioned inside
                  the page wrapper (which is position: relative), so it
                  scrolls with the page. pointer-events:none so it never
                  blocks text selection on the underlying text layer. */}
              {highlightRect?.page === p && (
                <div
                  aria-hidden="true"
                  className="absolute rounded pointer-events-none"
                  style={{
                    left: highlightRect.left,
                    top: highlightRect.top,
                    width: highlightRect.width,
                    height: highlightRect.height,
                    backgroundColor: "rgba(255, 235, 59, 0.4)",
                  }}
                />
              )}
              <p className="text-[10px] text-muted-foreground mt-1">Page {p}</p>
            </div>
          ))}
        </Document>
      </div>
    </div>
  );
}
