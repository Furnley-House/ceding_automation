// Excel import for the Fund Details table (Stage 4). Two input modes — paste
// a copied Excel range (TSV via the clipboard) or upload an .xlsx/.xls file —
// converge on one column-mapping preview, then bulk-insert via the existing
// /cases/:caseId/fund-lines/bulk endpoint. Entirely client-side parsing
// (SheetJS, already a dependency) so the CA gets instant feedback and the AI
// BFF stays out of it.
import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { X, Upload, ClipboardPaste, Loader2, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { fundLinesApi } from "@/lib/api";

interface Props {
  caseId: string;
  onClose: () => void;
  /** Called after a successful import so the table can refresh. */
  onImported: () => void;
}

// Fund Details target fields the CA can map a source column to.
const TARGET_FIELDS = [
  { key: "__skip__", label: "Skip — don't import this column" },
  { key: "fundName", label: "Fund Name" },
  { key: "isinSedolCiti", label: "ISIN / SEDOL / Citi" },
  { key: "numberOfUnits", label: "Number of units" },
  { key: "pricePerUnit", label: "Price per unit" },
  { key: "value", label: "Value" },
  { key: "ocf", label: "OCF (%)" },
  { key: "transactionCosts", label: "Transaction costs (%)" },
  { key: "isWithProfits", label: "With-profits (Yes/No)" },
] as const;

type TargetKey = (typeof TARGET_FIELDS)[number]["key"];
const NUMERIC_KEYS: TargetKey[] = ["numberOfUnits", "pricePerUnit", "value", "ocf", "transactionCosts"];

// Auto-detect a source header → target field. Returns null when nothing matches.
// Rules applied in priority order; the caller enforces at-most-one column per field.
function detectField(header: string): TargetKey | null {
  const h = header.trim().toLowerCase();
  if (!h) return null;
  if (h.includes("isin") || h.includes("sedol") || h.includes("citi")) return "isinSedolCiti";
  if (h.includes("ocf") || h.includes("ongoing charge")) return "ocf";
  if (h.includes("transaction") || h.includes("ter ") || /\btc\b/i.test(header)) return "transactionCosts";
  if (h.includes("with-profits") || h.includes("with profits") || /\bwp\b/i.test(header)) return "isWithProfits";
  if (h.includes("fund") || h.includes("holding") || h.startsWith("name")) return "fundName";
  if (h.includes("units") || h.includes("shares") || /\bnumber\b/i.test(header)) return "numberOfUnits";
  if (h.includes("price") || h.includes("nav")) return "pricePerUnit";
  if (h.includes("value")) return "value";
  return null;
}

// Build the auto-mapping for a header row. Each target field is claimed by at
// most one source column (first match wins).
function autoMap(headers: string[]): TargetKey[] {
  const used = new Set<TargetKey>();
  return headers.map((hdr) => {
    const detected = detectField(hdr);
    if (detected && detected !== "__skip__" && !used.has(detected)) {
      used.add(detected);
      return detected;
    }
    return "__skip__";
  });
}

// Numeric cleaner — strips currency / percent / thousands separators.
// Returns { ok, value } where ok=false means unparseable.
function cleanNumeric(raw: string): { ok: boolean; value: string | null } {
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  const stripped = t.replace(/[£$€¥%,\s']/g, "");
  if (stripped === "") return { ok: true, value: null };
  const n = Number(stripped);
  return Number.isFinite(n) ? { ok: true, value: stripped } : { ok: false, value: null };
}

function toBool(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t === "yes" || t === "y" || t === "true" || t === "1";
}

// Parse pasted TSV (Excel clipboard) → 2D string array, trimmed, empty rows dropped.
function parseTsv(text: string): string[][] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.split("\t").map((c) => c.trim()))
    .filter((row) => row.some((c) => c !== ""));
}

type Stage = "input" | "mapping" | "importing";
type Mode = "paste" | "upload";

export function FundDetailsImportDialog({ caseId, onClose, onImported }: Props) {
  const [stage, setStage] = useState<Stage>("input");
  const [mode, setMode] = useState<Mode>("paste");
  const [pasteText, setPasteText] = useState("");

  // Parsed grid: row 0 = headers, rest = data.
  const [grid, setGrid] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<TargetKey[]>([]);
  const [replace, setReplace] = useState(false);
  const [emptyAsMissing, setEmptyAsMissing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const headers = grid[0] ?? [];
  const dataRows = useMemo(() => grid.slice(1), [grid]);
  const previewRows = useMemo(() => dataRows.slice(0, 5), [dataRows]);

  const acceptGrid = (g: string[][]) => {
    if (g.length < 2) {
      setError("Need at least a header row and one data row.");
      return;
    }
    setError(null);
    setGrid(g);
    setMapping(autoMap(g[0]));
    setStage("mapping");
  };

  const handlePasteNext = () => acceptGrid(parseTsv(pasteText));

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const g = XLSX.utils.sheet_to_json<string[]>(sheet, {
          header: 1,
          blankrows: false,
          defval: "",
        }) as unknown as string[][];
        const cleaned = g
          .map((row) => row.map((c) => String(c ?? "").trim()))
          .filter((row) => row.some((c) => c !== ""));
        acceptGrid(cleaned);
      } catch (err) {
        setError(`Could not read the workbook: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.onerror = () => setError("Failed to read the file.");
    reader.readAsArrayBuffer(file);
  };

  // Build the mapped + cleaned rows ready for POST. Also returns any per-row
  // numeric parse errors (used to block import when emptyAsMissing is off).
  const { mappedRows, parseErrors } = useMemo(() => {
    const fundNameCol = mapping.indexOf("fundName");
    const rows: Record<string, unknown>[] = [];
    const errors: string[] = [];
    if (fundNameCol === -1) return { mappedRows: rows, parseErrors: errors };

    dataRows.forEach((row, ri) => {
      const fundName = (row[fundNameCol] ?? "").trim();
      if (!fundName) return; // fundName required — skip rows without it
      const out: Record<string, unknown> = { fundName };
      mapping.forEach((target, ci) => {
        if (target === "__skip__" || target === "fundName") return;
        const cell = (row[ci] ?? "").trim();
        if (target === "isinSedolCiti") {
          if (cell) out.isinSedolCiti = cell;
        } else if (target === "isWithProfits") {
          out.isWithProfits = toBool(cell);
        } else if (NUMERIC_KEYS.includes(target)) {
          const { ok, value } = cleanNumeric(cell);
          if (!ok) {
            errors.push(`Row ${ri + 1} "${fundName}": "${cell}" in ${target} isn't a number`);
            if (emptyAsMissing) out[target] = null;
          } else if (value !== null) {
            out[target] = value;
          }
          // value === null (empty) → omit the field entirely
        }
      });
      rows.push(out);
    });
    return { mappedRows: rows, parseErrors: errors };
  }, [dataRows, mapping, emptyAsMissing]);

  const autoDetectedCount = mapping.filter((m) => m !== "__skip__").length;
  const hasFundName = mapping.includes("fundName");
  const importBlocked = !hasFundName || mappedRows.length === 0 || (!emptyAsMissing && parseErrors.length > 0);

  const handleImport = async () => {
    setStage("importing");
    setError(null);
    try {
      await fundLinesApi.bulk(caseId, { rows: mappedRows, replace });
      onImported();
      toast.success(`Imported ${mappedRows.length} fund row${mappedRows.length === 1 ? "" : "s"}`);
      onClose();
    } catch (err) {
      const message =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        (err instanceof Error ? err.message : "Import failed");
      setError(message);
      setStage("mapping");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-foreground flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-teal" /> Import Fund Details from Excel
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* ── State A: input picker ── */}
        {stage === "input" && (
          <>
            <div className="flex gap-1 mb-3 rounded-md border border-border p-1 bg-muted/30 w-fit">
              <button
                onClick={() => setMode("paste")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                  mode === "paste" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                <ClipboardPaste className="h-3.5 w-3.5" /> Paste from Excel
              </button>
              <button
                onClick={() => setMode("upload")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                  mode === "upload" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                <Upload className="h-3.5 w-3.5" /> Upload .xlsx file
              </button>
            </div>

            {mode === "paste" ? (
              <>
                <textarea
                  autoFocus
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={8}
                  placeholder="Paste your Excel range here…"
                  className="w-full rounded-md border border-border bg-background p-2.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  Select the funds range in Excel (include the header row), then paste here with Ctrl+V.
                </p>
                <div className="flex justify-end mt-3">
                  <Button size="sm" onClick={handlePasteNext} disabled={parseTsv(pasteText).length < 2}>
                    Next
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div
                  className="rounded-lg border-2 border-dashed border-border bg-muted/20 p-8 text-center hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-9 w-9 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm font-semibold text-foreground">Choose an Excel file</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">.xlsx or .xls · first sheet is used</p>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleFile(f);
                      e.target.value = "";
                    }}
                  />
                </div>
              </>
            )}
          </>
        )}

        {/* ── State B: mapping preview ── */}
        {stage === "mapping" && (
          <>
            <div className="mb-2 rounded-md border border-info/30 bg-info/5 p-2 text-[11px] text-foreground">
              Auto-detected {autoDetectedCount} of {headers.length} columns. Review and adjust as needed.
              {!hasFundName && (
                <span className="block mt-1 text-destructive font-semibold">
                  Map one column to Fund Name to enable import.
                </span>
              )}
            </div>

            {/* Column cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
              {headers.map((hdr, ci) => (
                <div key={ci} className="rounded-md border border-border p-2">
                  <p className="text-xs font-semibold text-foreground truncate" title={hdr}>
                    {hdr || `(column ${ci + 1})`}
                  </p>
                  <select
                    value={mapping[ci]}
                    onChange={(e) => {
                      const next = [...mapping];
                      const chosen = e.target.value as TargetKey;
                      // Enforce at-most-one source column per target field.
                      if (chosen !== "__skip__") {
                        next.forEach((m, i) => {
                          if (i !== ci && m === chosen) next[i] = "__skip__";
                        });
                      }
                      next[ci] = chosen;
                      setMapping(next);
                    }}
                    className="mt-1 w-full rounded border border-input bg-background px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-teal/40"
                  >
                    {TARGET_FIELDS.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <div className="mt-1 space-y-0.5">
                    {previewRows.map((r, ri) => (
                      <p key={ri} className="text-[10px] text-muted-foreground truncate" title={r[ci] ?? ""}>
                        {r[ci] || "—"}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Preview of mapped rows */}
            {mappedRows.length > 0 && (
              <div className="mb-3 overflow-x-auto rounded-md border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr>
                      {TARGET_FIELDS.filter((t) => t.key !== "__skip__" && mapping.includes(t.key)).map((t) => (
                        <th key={t.key} className="text-left px-2 py-1 font-semibold whitespace-nowrap">
                          {t.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {mappedRows.slice(0, 5).map((row, ri) => (
                      <tr key={ri}>
                        {TARGET_FIELDS.filter((t) => t.key !== "__skip__" && mapping.includes(t.key)).map((t) => (
                          <td key={t.key} className="px-2 py-1 whitespace-nowrap text-foreground">
                            {t.key === "isWithProfits"
                              ? row[t.key]
                                ? "Yes"
                                : "No"
                              : row[t.key] === undefined || row[t.key] === null
                                ? "—"
                                : String(row[t.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!emptyAsMissing && parseErrors.length > 0 && (
              <div className="mb-3 rounded-md border border-warning/40 bg-warning/5 p-2 text-[11px] text-warning max-h-24 overflow-y-auto">
                {parseErrors.slice(0, 8).map((e, i) => (
                  <p key={i}>{e}</p>
                ))}
                {parseErrors.length > 8 && <p>…and {parseErrors.length - 8} more</p>}
              </div>
            )}

            <div className="space-y-1.5 mb-3">
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                Replace existing fund rows on this case
              </label>
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={emptyAsMissing}
                  onChange={(e) => setEmptyAsMissing(e.target.checked)}
                />
                Treat empty / unparseable values as missing
              </label>
            </div>

            <div className="flex justify-between">
              <Button size="sm" variant="outline" onClick={() => setStage("input")}>
                Back
              </Button>
              <Button size="sm" onClick={handleImport} disabled={importBlocked}>
                Import {mappedRows.length} row{mappedRows.length === 1 ? "" : "s"}
              </Button>
            </div>
          </>
        )}

        {/* ── State C: importing ── */}
        {stage === "importing" && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Importing {mappedRows.length} rows…
          </div>
        )}
      </div>
    </div>
  );
}
