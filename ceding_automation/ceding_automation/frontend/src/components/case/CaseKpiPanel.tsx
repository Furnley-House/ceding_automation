// Stage 10 KPI panel — pure client-side derivation from data already fetched
// (case row + per-case audit log + checklist fields + documents). No new
// backend endpoint. Every metric is defensive: a card is skipped when its
// underlying data isn't available on the case.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { auditApi } from "@/lib/api";
import { useChecklistFields } from "@/hooks/useChecklistFields";
import { useDocuments } from "@/hooks/useDocuments";
import { getTemplate } from "@/lib/checklistTemplates";
import type { CaseRow } from "@/lib/caseHelpers";

interface AuditRow {
  id: string;
  created_at: string;
  action: string;
  new_value?: string | null;
  metadata?: Record<string, unknown> | null;
}

// "2d 3h", "4h 12m", "8m". Returns null for non-positive / invalid spans.
function fmtDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function spanMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (isNaN(a) || isNaN(b)) return null;
  return b - a;
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string | null;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </p>
      <p className="text-lg font-bold text-foreground mt-0.5 leading-tight">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{sub}</p>}
    </div>
  );
}

export function CaseKpiPanel({ caseItem }: { caseItem: CaseRow }) {
  const caseId = caseItem.id;
  const template = useMemo(() => getTemplate(caseItem.plan_type), [caseItem.plan_type]);
  const { rows: checklistRows } = useChecklistFields({ caseId, template });
  const { documents } = useDocuments(caseId);
  const { data: auditRes } = useQuery({
    queryKey: ["case-audit", caseId],
    queryFn: () => auditApi.getForCase(caseId),
  });
  const audit: AuditRow[] = (auditRes?.data as AuditRow[] | undefined) ?? [];

  const c = caseItem as unknown as Record<string, string | null | undefined>;
  const createdAt = c.created_at ?? null;
  const completedAt = c.completed_at ?? c.ceding_complete_date ?? null;
  const readyForReviewAt = c.ready_for_review_at ?? null;
  const approvedAt = c.approved_at ?? null;

  // 1. Total case duration
  const totalMs = spanMs(createdAt, completedAt ?? new Date().toISOString());
  const totalDuration = fmtDuration(totalMs);

  // 2. Per-stage duration — deltas between consecutive CASE_STATUS_CHANGED rows.
  const stageDurations = useMemo(() => {
    const status = audit
      .filter((r) => r.action === "CASE_STATUS_CHANGED" && r.new_value)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const out: { label: string; dur: string }[] = [];
    for (let i = 0; i < status.length - 1; i++) {
      const dur = fmtDuration(spanMs(status[i].created_at, status[i + 1].created_at));
      if (dur) out.push({ label: String(status[i].new_value), dur });
    }
    return out;
  }, [audit]);

  // 3. AI extraction summary — confidence bands (manual override wins).
  // 4. Manual override count.
  const { bands, manualOverrides } = useMemo(() => {
    const b: Record<string, number> = {};
    let mo = 0;
    for (const r of checklistRows as Array<Record<string, unknown>>) {
      const statusVal = typeof r.status === "string" ? r.status.toLowerCase() : "";
      const isManual = r.manually_edited === true || statusVal === "manually_overridden";
      if (isManual) mo += 1;
      const band = isManual
        ? "MANUALLY_OVERRIDDEN"
        : (typeof r.confidence === "string" ? r.confidence.toUpperCase() : "MISSING");
      b[band] = (b[band] ?? 0) + 1;
    }
    return { bands: b, manualOverrides: mo };
  }, [checklistRows]);
  const bandOrder = ["HIGH", "MEDIUM", "LOW", "CONFLICT", "MISSING", "MANUALLY_OVERRIDDEN"];
  const bandSummary = bandOrder
    .filter((k) => bands[k])
    .map((k) => `${k.charAt(0) + k.slice(1).toLowerCase().replace("_", " ")}: ${bands[k]}`)
    .join(" · ");
  const totalFields = Object.values(bands).reduce((s, n) => s + n, 0);

  // 6. Approval timing — ready → approved → completed.
  const reviewMs = spanMs(readyForReviewAt, approvedAt);
  const approveMs = spanMs(approvedAt, completedAt);

  // 7. Stage 9 export outcome — latest CHECKLIST_EXPORTED audit metadata.
  const exportRow = audit
    .filter((r) => r.action === "CHECKLIST_EXPORTED")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  const exportMeta = (exportRow?.metadata ?? null) as Record<string, unknown> | null;

  const cards: React.ReactNode[] = [];

  if (totalDuration) {
    cards.push(
      <StatCard
        key="duration"
        label="Total case duration"
        value={totalDuration}
        sub={completedAt ? "created → completed" : "created → now (open)"}
      />,
    );
  }

  if (totalFields > 0) {
    cards.push(
      <StatCard
        key="ai"
        label="AI extraction"
        value={`${totalFields} fields`}
        sub={bandSummary || undefined}
      />,
    );
  }

  cards.push(
    <StatCard
      key="manual"
      label="Manual overrides"
      value={String(manualOverrides)}
      sub={manualOverrides === 1 ? "field corrected by hand" : "fields corrected by hand"}
    />,
  );

  cards.push(
    <StatCard
      key="docs"
      label="Documents processed"
      value={String(documents.length)}
      sub={documents.length === 1 ? "uploaded to this case" : "uploaded to this case"}
    />,
  );

  if (reviewMs !== null || approveMs !== null) {
    const parts: string[] = [];
    if (reviewMs !== null) parts.push(`Review: ${fmtDuration(reviewMs) ?? "—"}`);
    if (approveMs !== null) parts.push(`Approve→done: ${fmtDuration(approveMs) ?? "—"}`);
    cards.push(
      <StatCard
        key="approval"
        label="Approval timing"
        value={fmtDuration((reviewMs ?? 0) + (approveMs ?? 0)) ?? "—"}
        sub={parts.join(" · ")}
      />,
    );
  }

  if (exportMeta) {
    const workdrive = exportMeta.workdrive ?? exportMeta.workdriveOk;
    const zoho = exportMeta.zoho ?? exportMeta.zohoOk;
    const fieldsUpdated = exportMeta.fieldsUpdated ?? exportMeta.fields_updated;
    const recordId = exportMeta.recordId ?? exportMeta.planRecordId ?? exportMeta.zohoCaseId;
    const sub = [
      workdrive !== undefined ? `WorkDrive ${workdrive ? "✓" : "✗"}` : null,
      zoho !== undefined ? `Zoho ${zoho ? "✓" : "✗"}` : null,
      fieldsUpdated !== undefined ? `${fieldsUpdated} fields` : null,
      recordId ? `Plan ${recordId}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    cards.push(
      <StatCard key="export" label="Stage 9 export" value="Exported" sub={sub || undefined} />,
    );
  }

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground mb-3">
        Case KPIs
      </h4>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">{cards}</div>

      {stageDurations.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Per-stage duration
          </p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {stageDurations.map((s, i) => (
              <span key={i}>
                <span className="text-foreground font-medium">{s.label}</span>: {s.dur}
                {i < stageDurations.length - 1 ? " · " : ""}
              </span>
            ))}
          </p>
        </div>
      )}
    </div>
  );
}
