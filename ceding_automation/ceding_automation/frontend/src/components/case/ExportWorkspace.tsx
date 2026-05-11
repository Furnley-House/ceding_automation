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
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { auditApi } from "@/lib/api";
import { useRole } from "@/hooks/useRole";
import { useChecklistFields } from "@/hooks/useChecklistFields";
import { getTemplate, groupBySection } from "@/lib/checklistTemplates";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
      if (!row || row.status === "missing" || !row.value) missing += 1;
      else if (row.status === "approved") approved += 1;
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
        checklistRows.push([
          group.section,
          tf.label,
          row?.value ?? "",
          row?.status ?? "missing",
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
      ["Provider", caseItem.provider_name],
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
    const auditSheet = XLSX.utils.aoa_to_sheet(auditRows);
    auditSheet["!cols"] = [
      { wch: 18 }, { wch: 28 }, { wch: 16 }, { wch: 12 },
      { wch: 18 }, { wch: 14 }, { wch: 26 }, { wch: 26 }, { wch: 12 }, { wch: 32 },
    ];
    XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");
    XLSX.utils.book_append_sheet(wb, checklistSheet, "Checklist");
    XLSX.utils.book_append_sheet(wb, auditSheet, "Audit Trail");
    return wb;
  };

  const fileName = `${caseItem.case_ref}_${caseItem.client_name.replace(/\s+/g, "_")}_ceding.xlsx`;

  const handleDownload = async () => {
    setExporting(true);
    try {
      const wb = await buildWorkbook();
      XLSX.writeFile(wb, fileName);
      setLastExportAt(new Date().toISOString());
      toast.success("Excel file downloaded", { description: fileName });
      // Audit. Server-side write so the actor is the JWT subject and can't be
      // spoofed. Failure here is non-blocking — the user got their file.
      try {
        await auditApi.logExport(caseItem.id, {
          action: "CHECKLIST_EXPORTED",
          fileName,
          notes: `${stats.approved}/${stats.total} fields approved at export time`,
        });
      } catch (auditErr) {
        console.warn("Failed to log CHECKLIST_EXPORTED audit:", auditErr);
      }
    } catch (err) {
      console.error(err);
      toast.error("Export failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setExporting(false);
    }
  };

  const handleWorkDriveUpload = async () => {
    setUploading(true);
    try {
      // Stub: in production this would POST to a Zoho WorkDrive edge function.
      await new Promise((r) => setTimeout(r, 1200));
      const stubLink = `https://workdrive.zoho.com/file/stub-${caseItem.case_ref.toLowerCase()}`;
      setWorkdriveLink(stubLink);
      toast.success("Uploaded to WorkDrive", { description: "CA team notified" });
      try {
        await auditApi.logExport(caseItem.id, {
          action: "WORKDRIVE_EXPORTED",
          fileName,
          destination: stubLink,
          notes: "Uploaded to WorkDrive (Client / Deal WIP)",
        });
      } catch (auditErr) {
        console.warn("Failed to log WORKDRIVE_EXPORTED audit:", auditErr);
      }
    } catch (err) {
      console.error(err);
      toast.error("Upload failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
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
            <span className="font-semibold text-foreground">Audit Trail</span> — full immutable history (extractions, edits, calls, approvals)
          </li>
        </ul>
        <p className="text-[10px] text-muted-foreground italic mt-3 font-mono">{fileName}</p>
      </div>

      {/* Actions */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-card p-4 flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <Download className="h-4 w-4 text-teal" />
            <h4 className="text-sm font-bold text-foreground">Download .xlsx</h4>
          </div>
          <p className="text-xs text-muted-foreground mb-4 flex-1">
            Generates the workbook in your browser and saves it to your Downloads folder.
          </p>
          <Button onClick={handleDownload} disabled={exporting} className="w-full gap-2">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {exporting ? "Generating…" : "Download Excel"}
          </Button>
          {lastExportAt && (
            <p className="text-[10px] text-muted-foreground mt-2 text-center">
              Last download: {formatTs(lastExportAt)}
            </p>
          )}
        </div>

        <div className="rounded-md border border-border bg-card p-4 flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <Cloud className="h-4 w-4 text-teal" />
            <h4 className="text-sm font-bold text-foreground">Push to Zoho WorkDrive</h4>
            <Badge variant="outline" className="text-[9px] uppercase tracking-wider ml-auto">
              <Sparkles className="h-2.5 w-2.5 mr-1" /> Stub
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mb-4 flex-1">
            Production: posts the workbook to the case's WorkDrive folder via the Zoho API and notifies the CA team.
          </p>
          <Button
            onClick={handleWorkDriveUpload}
            disabled={uploading}
            variant="outline"
            className="w-full gap-2"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
            {uploading ? "Uploading…" : "Upload to WorkDrive"}
          </Button>
          {workdriveLink && (
            <a
              href={workdriveLink}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-teal hover:underline mt-2 text-center inline-flex items-center justify-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              {workdriveLink}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
