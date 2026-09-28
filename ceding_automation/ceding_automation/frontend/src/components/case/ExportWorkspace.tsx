import { useEffect, useMemo, useState } from "react";
import {
  Download,
  Cloud,
  CheckCircle2,
  Loader2,
  FileSpreadsheet,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { auditApi, casesApi, contributionsApi, fundLinesApi } from "@/lib/api";
import { useRole } from "@/hooks/useRole";
import { useChecklistFields, isMissing, displayValue } from "@/hooks/useChecklistFields";
import { getTemplate } from "@/lib/checklistTemplates";
import { Button } from "@/components/ui/button";
import type { CaseRow } from "@/lib/caseHelpers";
import { buildStyledExport, type ExportInput } from "@/lib/exportTemplate";

interface AuditRow {
  id: string;
  created_at: string;
  case_id: string;
  field_key?: string | null;
  field_label?: string | null;
  action: string;
  source: string;
  old_value?: string | null;
  new_value?: string | null;
  confidence?: string | null;
  actor_name?: string | null;
  actor_role?: string | null;
  notes?: string | null;
}

interface Props {
  caseItem: CaseRow;
}

function formatTs(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

// Snapshot of the latest CHECKLIST_EXPORTED audit row's metadata — the
// shape the backend writes in export.ts is mirrored here so the receipt
// panel can render without an `any` cast. Optional everywhere because
// older audit rows may pre-date the fields we read.
interface ExportReceipt {
  exportedAt: string;
  actorName: string | null;
  fileName?: string;
  workdrive?: { id: string; permalink?: string; name?: string } | null;
  workdriveError?: string | null;
  zohoUpdate?: {
    ok: boolean;
    fieldsUpdated: number;
    recordId?: string;
    planName?: string;
    resolvedVia?: "stored" | "policy_ref_search";
    // Full payload sent to Zoho — rendered as a key/value table in the
    // receipt so testers can verify what landed without opening Zoho.
    fields?: Record<string, unknown>;
  };
  zohoError?: string | null;
  /**
   * Outcome of the Holdings subform push. Summarised rather than dumped:
   * the raw payload is a wall of JSON that hides whether anything actually
   * changed, which is the only thing the CA needs from it.
   */
  holdings?: {
    added: number;
    updated: number;
    kept: number;
    skipped: string[];
  } | null;
  holdingsError?: string | null;
  cacheWarning?: string | null;
}

// Convert a Zoho-bound value into something human-readable. Lookup fields
// arrive as { id: "..." }; primitives pass through; booleans → Yes/No.
function formatZohoValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string") return `linked · ${o.id}`;
    return JSON.stringify(o);
  }
  return String(v);
}

export function ExportWorkspace({ caseItem }: Props) {
  const { userName } = useRole();
  const template = getTemplate(caseItem.plan_type);
  const { rows: fields, loading: isLoading } = useChecklistFields({ caseId: caseItem.id, template });
  const [exporting, setExporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Set when the server refuses because the holdings were never checked. The
  // workbook bytes are held so confirming re-sends them instead of rebuilding.
  const [unverifiedPrompt, setUnverifiedPrompt] = useState<{
    blob: Blob;
    message: string;
    holdings: string[];
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lastExportAt, setLastExportAt] = useState<string | null>(null);
  const [workdriveLink, setWorkdriveLink] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ExportReceipt | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(true);

  // Reads the latest CHECKLIST_EXPORTED audit row so the receipt panel
  // persists across page reloads — testers stop having to re-export just
  // to see the previous run's outcome.
  const fetchLatestReceipt = useMemo(
    () => async () => {
      try {
        const res = await auditApi.getForCase(caseItem.id);
        const rows = (res.data as Array<{
          action: string;
          created_at: string;
          actor_name: string | null;
          metadata: Record<string, unknown> | null;
        }>) ?? [];
        const last = rows.find((r) => r.action === "CHECKLIST_EXPORTED");
        if (!last || !last.metadata) {
          setReceipt(null);
          return;
        }
        const m = last.metadata;
        setReceipt({
          exportedAt: last.created_at,
          actorName: last.actor_name,
          fileName: (m.fileName as string) ?? undefined,
          workdrive: (m.workdrive as ExportReceipt["workdrive"]) ?? null,
          workdriveError: (m.workdriveError as string | null) ?? null,
          zohoUpdate: (m.zohoUpdate as ExportReceipt["zohoUpdate"]) ?? undefined,
          zohoError: (m.zohoError as string | null) ?? null,
          holdings: (m.holdings as ExportReceipt["holdings"]) ?? null,
          holdingsError: (m.holdingsError as string | null) ?? null,
          cacheWarning: (m.cacheWarning as string | null) ?? null,
        });
      } catch {
        setReceipt(null);
      } finally {
        setReceiptLoading(false);
      }
    },
    [caseItem.id],
  );

  useEffect(() => {
    fetchLatestReceipt();
  }, [fetchLatestReceipt]);


  const stats = useMemo(() => {
    const total = template.length;
    const byKey = new Map(fields.map((f) => [f.field_key, f]));
    let approved = 0;
    let missing = 0;
    let pending = 0;
    template.forEach((tf) => {
      const row = byKey.get(tf.key);
      if (isMissing(row)) missing += 1;
      else if (row?.status === "approved") approved += 1;
      else pending += 1;
    });
    return { total, approved, missing, pending, allApproved: approved === total && total > 0 };
  }, [fields, template]);

  const buildWorkbookBytes = async (): Promise<Uint8Array> => {
    // Fetch fund lines (best-effort — empty on failure).
    let fundLines: ExportInput["fundLines"] = [];
    try {
      const res = await fundLinesApi.list(caseItem.id);
      const data = res.data as { rows?: ExportInput["fundLines"] };
      fundLines = data.rows ?? [];
    } catch {
      /* fund lines unavailable — export continues without them */
    }

    // Fetch Pension contributions table (best-effort). On non-Pension
    // cases the API still returns 4 auto-seeded rows, but the template
    // builder ignores them because only the Pension sheet has the target
    // cells (row 20 / row 21).
    let contributions: ExportInput["contributions"] = [];
    try {
      const res = await contributionsApi.list(caseItem.id);
      const data = res.data as { rows?: Array<{ position: number; taxYearLabel: string; amount: string | null }> };
      contributions = (data.rows ?? [])
        .sort((a, b) => a.position - b.position)
        .map((r) => ({
          position: r.position,
          taxYearLabel: r.taxYearLabel,
          amount: r.amount ?? null,
        }));
    } catch {
      /* contributions unavailable — export falls back to the legacy text field */
    }

    // Fetch audit rows (best-effort).
    let auditRows: ExportInput["auditRows"] = [];
    try {
      const res = await auditApi.getForCase(caseItem.id);
      const list = (res.data as AuditRow[]) ?? [];
      auditRows = list.map((a) => ({
        timestamp: formatTs(a.created_at),
        field: a.field_label ?? a.field_key ?? "",
        action: a.action,
        actor: a.actor_name ?? "",
        old_value: a.old_value ?? "",
        new_value: a.new_value ?? "",
      }));
    } catch {
      /* audit unavailable — sheet will be empty */
    }

    // Normalise the plan type onto the enum the template builder expects.
    // Anything unrecognised falls back to PENSION so the export still runs;
    // the resulting sheet will just have no field values populated.
    const planType = (
      ["PENSION", "ISA", "GIA"] as const
    ).find((p) => p === (caseItem.plan_type ?? "").toUpperCase()) ?? "PENSION";

    const input: ExportInput = {
      planType,
      caseRef: caseItem.case_ref,
      clientName: caseItem.client_name,
      fields: fields.map((f) => ({
        field_key: f.field_key,
        value: isMissing(f) ? "" : displayValue(f),
        confidence: f.confidence ?? null,
        status: f.status ?? null,
      })),
      fundLines,
      contributions,
      auditRows,
    };

    return buildStyledExport(input);
  };

  const fileName = `${caseItem.case_ref}_${caseItem.client_name.replace(/\s+/g, "_")}_ceding.xlsx`;

  // One-shot Stage 9 action:
  //   1. Build the XLSX in the browser.
  //   2. Trigger a local download.
  //   3. POST the same workbook bytes to the backend → WorkDrive upload + Zoho Plans PATCH.
  // Each leg succeeds or fails independently; the toast surfaces partials.
  const handleCompleteExport = async () => {
    setExporting(true);
    setUploading(true);
    try {
      const bytes = await buildWorkbookBytes();
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      // 1. Local download — synthetic <a download> click since we already
      //    have the bytes in-hand (ExcelJS returned them directly).
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      // 3. Backend does WorkDrive + Zoho in one call
      await sendToBackend(blob, false);
    } catch (err) {
      console.error(err);
      toast.error("Export failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setExporting(false);
      setUploading(false);
    }
  };

  /**
   * POST the workbook. Split out from the build/download so that confirming
   * an unverified export re-sends the same bytes rather than rebuilding the
   * workbook and downloading a second copy to the CA's machine.
   */
  const sendToBackend = async (blob: Blob, confirmUnverified: boolean) => {
    try {
      const res = await casesApi.completeExport(caseItem.id, blob, fileName, confirmUnverified);
      const data = res.data as {
        workdrive?: { id: string; permalink?: string } | null;
        workdriveError?: string | null;
        zohoUpdate?: { ok: boolean; fieldsUpdated: number };
        zohoError?: string | null;
        holdings?: { added: number; updated: number; kept: number; skipped: string[] } | null;
        holdingsError?: string | null;
        exportedAt: string;
      };

      setLastExportAt(data.exportedAt);
      if (data.workdrive?.permalink) {
        setWorkdriveLink(data.workdrive.permalink);
      }

      // Build a precise multi-line toast so the CA sees exactly what worked.
      const lines: string[] = [`Downloaded ${fileName}`];
      if (data.workdrive) lines.push("Uploaded to WorkDrive ✓");
      else if (data.workdriveError) lines.push(`WorkDrive upload failed: ${data.workdriveError}`);
      if (data.zohoUpdate?.ok) lines.push(`Updated ${data.zohoUpdate.fieldsUpdated} fields in Zoho CRM ✓`);
      else if (data.zohoError) lines.push(`Zoho update failed: ${data.zohoError}`);

      // Holdings get their own line — they are the part a CA is most likely
      // to want confirmed, and the field count above does not distinguish
      // "the subform was sent" from "the subform changed anything".
      if (data.holdingsError) {
        lines.push("Fund holdings were not sent — please run the export again");
      } else if (data.zohoUpdate?.ok && data.holdings) {
        const { added, updated } = data.holdings;
        if (added > 0 || updated > 0) {
          const parts: string[] = [];
          if (updated > 0) parts.push(`${updated} updated`);
          if (added > 0) parts.push(`${added} added`);
          lines.push(`Fund holdings: ${parts.join(", ")} ✓`);
        } else {
          lines.push("Fund holdings: no changes");
        }
      }

      const allOk = !!data.workdrive && !!data.zohoUpdate?.ok;
      if (allOk) {
        toast.success("Complete export finished", { description: lines.join("\n") });
      } else {
        toast.warning("Export finished with warnings", { description: lines.join("\n") });
      }

      // Pull the audit row that the backend just wrote so the receipt panel
      // reflects this latest run without a page reload.
      await fetchLatestReceipt();
      setUnverifiedPrompt(null);
    } catch (err) {
      // The holdings have not been checked. That is a decision for the CA,
      // not a failure — ask, rather than reporting an error they cannot act
      // on. Nothing has been written at this point.
      const resp = (err as { response?: { status?: number; data?: Record<string, unknown> } })
        .response;
      if (resp?.status === 409 && resp.data?.code === "HOLDINGS_UNVERIFIED") {
        setUnverifiedPrompt({
          blob,
          message: String(resp.data.error ?? "These fund holdings have not been checked."),
          holdings: Array.isArray(resp.data.holdings) ? (resp.data.holdings as string[]) : [],
        });
        return;
      }
      console.error(err);
      toast.error("Export failed", { description: err instanceof Error ? err.message : "Unknown error" });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading checklist…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Readiness banner */}
      <div
        className={`rounded-md border p-4 ${
          stats.allApproved
            ? "border-success/30 bg-success/5"
            : "border-warning/30 bg-warning/5"
        }`}
      >
        <div className="flex items-start gap-3">
          {stats.allApproved ? (
            <ShieldCheck className="h-5 w-5 text-success shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            <p className="text-[10px] uppercase tracking-widest font-bold text-foreground">
              {stats.allApproved ? "Case approved · ready to export" : "Case not yet fully approved"}
            </p>
            <p className="text-sm text-foreground mt-1">
              {stats.approved}/{stats.total} fields approved
              {stats.missing > 0 && ` · ${stats.missing} missing`}
              {stats.pending > 0 && ` · ${stats.pending} pending`}
            </p>
            {!stats.allApproved && (
              <p className="text-[11px] text-muted-foreground mt-1">
                You can still export at any time, but production exports should typically wait until Stage 9 sign-off.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Workbook preview */}
      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <FileSpreadsheet className="h-4 w-4 text-teal" />
          <h4 className="text-[11px] uppercase tracking-widest font-bold text-foreground">
            Workbook contents
          </h4>
        </div>
        <ul className="text-xs text-muted-foreground space-y-1.5">
          <li className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            <span className="font-semibold text-foreground">Summary</span> — case meta, counts, exporter
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            <span className="font-semibold text-foreground">Checklist</span> — every field with value, status, confidence, page, notes
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            <span className="font-semibold text-foreground">Fund Details</span> — per-fund table (name, ISIN, units, price, value, charge) with total
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            <span className="font-semibold text-foreground">Audit Trail</span> — full immutable history (extractions, edits, calls, approvals)
          </li>
        </ul>
        <p className="text-[10px] text-muted-foreground italic mt-3 font-mono">{fileName}</p>
      </div>

      {/* Single complete-export action */}
      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <Cloud className="h-4 w-4 text-teal" />
          <h4 className="text-sm font-bold text-foreground">Complete export</h4>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          One click does all three: downloads the .xlsx to your Downloads folder, uploads the
          same workbook to the case's Zoho WorkDrive folder, and writes the final field values
          back to the Zoho CRM Plans record.
        </p>
        <ul className="text-[11px] text-muted-foreground space-y-1 mb-4 pl-4 list-disc">
          <li>Local download · <span className="font-mono">{fileName}</span></li>
          <li>WorkDrive upload to the configured ceding folder</li>
          <li>Zoho Plans PATCH (Provider, Policy_Ref, Valuation, Plan_Status, …)</li>
        </ul>
        <Button
          onClick={handleCompleteExport}
          disabled={exporting || uploading}
          className="w-full gap-2"
        >
          {(exporting || uploading) ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {exporting || uploading ? "Exporting…" : "Complete export"}
        </Button>
        {lastExportAt && (
          <p className="text-[10px] text-muted-foreground mt-2 text-center">
            Last export: {formatTs(lastExportAt)}
          </p>
        )}
        {workdriveLink && (
          <a
            href={workdriveLink}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-teal hover:underline mt-2 text-center inline-flex items-center justify-center gap-1 w-full"
          >
            <ExternalLink className="h-3 w-3" /> Open in WorkDrive
          </a>
        )}
      </div>

      {/* Zoho update receipt (D3) — sourced from the latest CHECKLIST_EXPORTED audit row */}
      <ExportReceiptPanel receipt={receipt} loading={receiptLoading} />

      {/* The holdings were never checked. Nothing has been written yet — the
          CA either goes back and verifies, or says to send them as they are
          and that decision is recorded against their name. */}
      {unverifiedPrompt && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !confirming && setUnverifiedPrompt(null)}
        >
          <div
            className="bg-card border border-border rounded-lg shadow-lg w-[480px] max-w-full p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-foreground">
                  Fund holdings have not been checked
                </h3>
                <p className="text-xs text-muted-foreground mt-1">{unverifiedPrompt.message}</p>
              </div>
            </div>

            {unverifiedPrompt.holdings.length > 0 && (
              <ul className="text-[11px] text-foreground bg-muted/40 rounded p-2 max-h-28 overflow-y-auto list-disc list-inside">
                {unverifiedPrompt.holdings.map((h, i) => (
                  <li key={`${h}-${i}`}>{h}</li>
                ))}
              </ul>
            )}

            <p className="text-[11px] text-muted-foreground">
              If you export now, the figures on the checklist go to CRM exactly as they are and
              this will be recorded against your name.
            </p>

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={confirming}
                onClick={() => setUnverifiedPrompt(null)}
              >
                Go back and verify
              </Button>
              <Button
                size="sm"
                disabled={confirming}
                className="gap-1.5"
                onClick={async () => {
                  setConfirming(true);
                  try {
                    await sendToBackend(unverifiedPrompt.blob, true);
                  } finally {
                    setConfirming(false);
                  }
                }}
              >
                {confirming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Export anyway
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Renders a persistent summary of the most recent Complete-export run so
// QA / testers can verify Zoho-side success without DB access. Distinct
// from the post-action toast (which evaporates) — this survives reloads.
function ExportReceiptPanel({
  receipt,
  loading,
}: {
  receipt: ExportReceipt | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading export receipt…
      </div>
    );
  }
  if (!receipt) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        No export run yet for this case — receipt will appear here after Complete export.
      </div>
    );
  }

  const wdOk = !!receipt.workdrive;
  const zohoOk = !!receipt.zohoUpdate?.ok;
  const allOk = wdOk && zohoOk;

  return (
    <div
      className={`rounded-md border p-4 ${
        allOk
          ? "border-success/40 bg-success/5"
          : "border-warning/40 bg-warning/5"
      }`}
    >
      <div className="flex items-center gap-2 mb-3">
        {allOk ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-warning" />
        )}
        <h4 className="text-[11px] uppercase tracking-widest font-bold text-foreground">
          Zoho update receipt
        </h4>
      </div>

      <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Run at</dt>
        <dd className="text-foreground">{formatTs(receipt.exportedAt)}</dd>

        {receipt.actorName && (
          <>
            <dt className="text-muted-foreground">By</dt>
            <dd className="text-foreground">{receipt.actorName}</dd>
          </>
        )}

        {receipt.fileName && (
          <>
            <dt className="text-muted-foreground">File</dt>
            <dd className="text-foreground font-mono text-[11px] break-all">{receipt.fileName}</dd>
          </>
        )}

        <dt className="text-muted-foreground">WorkDrive</dt>
        <dd className={wdOk ? "text-success" : "text-warning"}>
          {wdOk ? (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Uploaded
              {receipt.workdrive?.permalink && (
                <a
                  href={receipt.workdrive.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 text-teal hover:underline inline-flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" /> Open
                </a>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <XCircle className="h-3 w-3" /> {receipt.workdriveError ?? "Failed"}
            </span>
          )}
        </dd>

        <dt className="text-muted-foreground">Zoho Plans</dt>
        <dd className={zohoOk ? "text-success" : "text-warning"}>
          {zohoOk ? (
            <div className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Updated{" "}
                {receipt.zohoUpdate?.fieldsUpdated ?? 0} field
                {receipt.zohoUpdate?.fieldsUpdated === 1 ? "" : "s"}
              </span>
              <span className="text-foreground text-[11px]">
                {receipt.zohoUpdate?.planName ? (
                  <span className="font-semibold">{receipt.zohoUpdate.planName}</span>
                ) : (
                  <span className="font-mono">{receipt.zohoUpdate?.recordId ?? "—"}</span>
                )}
                {receipt.zohoUpdate?.resolvedVia && (
                  <span className="text-muted-foreground ml-2">
                    · resolved via{" "}
                    {receipt.zohoUpdate.resolvedVia === "stored"
                      ? "cached id"
                      : "Policy Ref search"}
                  </span>
                )}
              </span>
              {receipt.zohoUpdate?.fields && Object.keys(receipt.zohoUpdate.fields).length > 0 && (
                <PushedFieldsTable fields={receipt.zohoUpdate.fields} />
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              <span className="inline-flex items-center gap-1">
                <XCircle className="h-3 w-3" /> Update failed
              </span>
              {receipt.zohoError && (
                <span className="text-foreground text-[11px] break-words">
                  {receipt.zohoError}
                </span>
              )}
            </div>
          )}
        </dd>

        <dt className="text-muted-foreground">Holdings</dt>
        <dd>
          <HoldingsOutcome
            holdings={receipt.holdings}
            error={receipt.holdingsError}
            zohoOk={zohoOk}
          />
        </dd>

        {receipt.cacheWarning && (
          <>
            <dt className="text-muted-foreground">Note</dt>
            <dd className="text-warning text-[11px]">{receipt.cacheWarning}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

// Field-by-field breakdown of what landed in Zoho. Renders inside the
// Zoho Plans row so the receipt is self-contained — no need to open the
// Zoho record to verify each value. Lookup fields show as "linked · {id}";
// scalars / pick-list / dates show their literal value.
/**
 * What happened to the fund holdings, in a sentence.
 *
 * This used to render as the raw Holdings_List payload — several hundred
 * characters of JSON in which the one thing that matters, whether the rows
 * actually changed, was invisible. The counts say it directly.
 */
function HoldingsOutcome({
  holdings,
  error,
  zohoOk,
}: {
  holdings: ExportReceipt["holdings"];
  error?: string | null;
  zohoOk: boolean;
}) {
  if (error) {
    return (
      <span className="inline-flex items-start gap-1 text-warning">
        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
        <span>
          Fund holdings were not sent. Everything else exported fine — please run the export
          again.
        </span>
      </span>
    );
  }

  // The Plan update failed as a whole, so the subform never landed either.
  // Saying "3 updated" here would contradict the row above it.
  if (!zohoOk) {
    return (
      <span className="inline-flex items-center gap-1 text-warning">
        <XCircle className="h-3 w-3" /> Not sent — the Zoho update failed
      </span>
    );
  }

  if (!holdings) {
    return <span className="text-muted-foreground">—</span>;
  }

  const { added, updated, skipped } = holdings;

  // Only what this export did to this case's funds. What else happens to sit
  // on the plan is not the CA's business and naming it just raises questions
  // they have no way to answer.
  if (added === 0 && updated === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <CheckCircle2 className="h-3 w-3" /> No changes
      </span>
    );
  }

  const parts: string[] = [];
  if (updated > 0) parts.push(`${updated} fund${updated === 1 ? "" : "s"} updated`);
  if (added > 0) parts.push(`${added} fund${added === 1 ? "" : "s"} added`);

  return (
    <div className="flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1 text-success">
        <CheckCircle2 className="h-3 w-3" /> {parts.join(", ")}
      </span>
      {/* Worth saying, because these funds will not be in CRM and nothing
          else on this screen would tell them. */}
      {skipped.length > 0 && (
        <span className="text-warning text-[11px]">
          Not sent: {skipped.join(", ")} — add a fund name or ISIN on the checklist first.
        </span>
      )}
    </div>
  );
}

// The subform is summarised in its own row above, so it is left out of the
// field-by-field table — its payload is JSON that would swamp the panel.
const RECEIPT_HIDDEN_FIELDS = new Set(["Holdings_List"]);

function PushedFieldsTable({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields).filter(([k]) => !RECEIPT_HIDDEN_FIELDS.has(k));
  return (
    <div className="mt-2 rounded-md border border-success/30 bg-background/60 overflow-hidden">
      <table className="w-full text-[11px]">
        <thead className="bg-muted/50">
          <tr>
            <th className="text-left px-2 py-1 font-semibold text-muted-foreground w-1/2">Field</th>
            <th className="text-left px-2 py-1 font-semibold text-muted-foreground">Value pushed</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="border-t border-border">
              <td className="px-2 py-1 font-mono text-foreground">{key}</td>
              <td className="px-2 py-1 text-foreground break-all">{formatZohoValue(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
