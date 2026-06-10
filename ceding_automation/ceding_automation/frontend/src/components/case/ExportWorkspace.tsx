import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  Download,
  Cloud,
  CheckCircle2,
  Loader2,
  FileSpreadsheet,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { auditApi, casesApi, fundLinesApi } from "@/lib/api";
import { useRole } from "@/hooks/useRole";
import { useChecklistFields, isMissing, displayValue } from "@/hooks/useChecklistFields";
import { getTemplate, groupBySection } from "@/lib/checklistTemplates";
import { Button } from "@/components/ui/button";
import type { CaseRow } from "@/lib/caseHelpers";

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

export function ExportWorkspace({ caseItem }: Props) {
  const { userName } = useRole();
  const template = getTemplate(caseItem.plan_type);
  const { rows: fields, loading: isLoading } = useChecklistFields({ caseId: caseItem.id, template });
  const [exporting, setExporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lastExportAt, setLastExportAt] = useState<string | null>(null);
  const [workdriveLink, setWorkdriveLink] = useState<string | null>(null);


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

  const buildWorkbook = async (): Promise<XLSX.WorkBook> => {
    // ---- Checklist sheet ----
    const sectionGroups = groupBySection(template);
    const byKey = new Map(fields.map((f) => [f.field_key, f]));
    const checklistRows: (string | number)[][] = [
      [
        "Section",
        "Field",
        "Value",
        "Status",
        "Confidence",
        "Source page",
        "Manually edited",
        "Notes",
        "Last updated",
      ],
    ];
    sectionGroups.forEach((group) => {
      group.fields.forEach((tf) => {
        const row = byKey.get(tf.key);
        // Use displayValue so literal "MISSING" strings render as "—"
        // and the spreadsheet status column ("missing") agrees with it.
        const missing = isMissing(row);
        checklistRows.push([
          group.section,
          tf.label,
          missing ? "—" : displayValue(row),
          missing ? "missing" : (row?.status ?? "missing"),
          row?.confidence ?? "",
          row?.source_page ?? "",
          row?.manually_edited ? "Yes" : "No",
          row?.notes ?? "",
          formatTs(row?.updated_at ?? null),
        ]);
      });
    });

    // Case summary at top — separate sheet
    const summaryRows: (string | number)[][] = [
      ["Case reference", caseItem.case_ref],
      ["Client", caseItem.client_name],
      ["Provider", caseItem.Provider_group],
      ["Plan type", caseItem.plan_type],
      ["Plan number", caseItem.plan_number],
      ["Status", caseItem.status],
      ["Assigned to", caseItem.owner_name ?? ""],
      ["LOA sent", caseItem.loa_sent_date ?? ""],
      ["Total fields", stats.total],
      ["Approved", stats.approved],
      ["Pending", stats.pending],
      ["Missing", stats.missing],
      ["Exported by", userName ?? "Unknown"],
      ["Exported at", new Date().toLocaleString("en-GB")],
    ];

    // ---- Fund Details sheet ----
    // Multi-row sub-table (per-fund breakdown). Headers mirror the in-app
    // FundDetailsTable so the spreadsheet matches what the CA / paraplanner
    // saw on screen. Totals row appended at the bottom.
    interface FundLineRow {
      fundName: string;
      isinSedolCiti: string | null;
      numberOfUnits: string | null;
      pricePerUnit: string | null;
      value: string | null;
      fundCharge: string | null;
      isWithProfits: boolean;
      status: string;
      confidence: string;
      sourcePageNumber: number | null;
      updatedAt: string | null;
    }
    let fundLines: FundLineRow[] = [];
    let fundTotalValue = "0";
    try {
      const res = await fundLinesApi.list(caseItem.id);
      const data = res.data as {
        rows?: FundLineRow[];
        summary?: { totalValue?: string };
      };
      fundLines = data.rows ?? [];
      fundTotalValue = data.summary?.totalValue ?? "0";
    } catch {
      // fund lines unavailable — sheet still rendered with header only
    }
    const fundRows: (string | number)[][] = [
      [
        "Fund Name",
        "ISIN / Sedol",
        "Units",
        "Price",
        "Value (£)",
        "Charge (%)",
        "With-profits",
        "Status",
        "Confidence",
        "Source page",
        "Last updated",
      ],
    ];
    fundLines.forEach((f) => {
      fundRows.push([
        f.fundName,
        f.isinSedolCiti ?? "",
        f.numberOfUnits ?? "",
        f.pricePerUnit ?? "",
        f.value ?? "",
        f.fundCharge ?? "",
        f.isWithProfits ? "Yes" : "No",
        f.status,
        f.confidence,
        f.sourcePageNumber ?? "",
        formatTs(f.updatedAt ?? null),
      ]);
    });
    if (fundLines.length > 0) {
      fundRows.push([]); // blank separator row
      fundRows.push(["", "", "", "TOTAL", fundTotalValue, "", "", "", "", "", ""]);
    }

    // ---- Audit sheet ----
    let auditList: AuditRow[] = [];
    try {
      const res = await auditApi.getForCase(caseItem.id);
      auditList = (res.data as AuditRow[]) ?? [];
    } catch {
      // audit unavailable — sheet will be empty
    }
    const auditRows: (string | number)[][] = [
      [
        "Timestamp",
        "Field",
        "Action",
        "Source",
        "Actor",
        "Role",
        "Old value",
        "New value",
        "Confidence",
        "Notes",
      ],
    ];
    auditList.forEach((a) => {
      auditRows.push([
        formatTs(a.created_at),
        a.field_label ?? a.field_key ?? "",
        a.action,
        a.source,
        a.actor_name ?? "",
        a.actor_role ?? "",
        a.old_value ?? "",
        a.new_value ?? "",
        a.confidence ?? "",
        a.notes ?? "",
      ]);
    });

    const wb = XLSX.utils.book_new();
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    summarySheet["!cols"] = [{ wch: 22 }, { wch: 40 }];
    const checklistSheet = XLSX.utils.aoa_to_sheet(checklistRows);
    checklistSheet["!cols"] = [
      { wch: 24 }, { wch: 32 }, { wch: 36 }, { wch: 14 },
      { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 30 }, { wch: 18 },
    ];
    const fundSheet = XLSX.utils.aoa_to_sheet(fundRows);
    fundSheet["!cols"] = [
      { wch: 32 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
      { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 18 },
    ];
    const auditSheet = XLSX.utils.aoa_to_sheet(auditRows);
    auditSheet["!cols"] = [
      { wch: 18 }, { wch: 28 }, { wch: 16 }, { wch: 12 },
      { wch: 18 }, { wch: 14 }, { wch: 26 }, { wch: 26 }, { wch: 12 }, { wch: 32 },
    ];
    XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");
    XLSX.utils.book_append_sheet(wb, checklistSheet, "Checklist");
    XLSX.utils.book_append_sheet(wb, fundSheet, "Fund Details");
    XLSX.utils.book_append_sheet(wb, auditSheet, "Audit Trail");
    return wb;
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
      const wb = await buildWorkbook();

      // 1. Local download
      XLSX.writeFile(wb, fileName);

      // 2. Build a Blob from the same workbook (writeFile doesn't return bytes)
      const arrayBuf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([arrayBuf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      // 3. Backend does WorkDrive + Zoho in one call
      const res = await casesApi.completeExport(caseItem.id, blob, fileName);
      const data = res.data as {
        workdrive?: { id: string; permalink?: string } | null;
        workdriveError?: string | null;
        zohoUpdate?: { ok: boolean; fieldsUpdated: number };
        zohoError?: string | null;
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

      const allOk = !!data.workdrive && !!data.zohoUpdate?.ok;
      if (allOk) {
        toast.success("Complete export finished", { description: lines.join("\n") });
      } else {
        toast.warning("Export finished with warnings", { description: lines.join("\n") });
      }
    } catch (err) {
      console.error(err);
      toast.error("Export failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setExporting(false);
      setUploading(false);
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
    </div>
  );
}
