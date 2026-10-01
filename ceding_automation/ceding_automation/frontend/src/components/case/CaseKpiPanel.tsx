// Stage 10 KPI panel — pure client-side derivation from data already fetched
// (case row + per-case audit log + checklist fields + documents). No new
// backend endpoint. Every metric is defensive: a card is skipped when its
// underlying data isn't available on the case.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { auditApi } from "@/lib/api";
import { useChecklistFields } from "@/hooks/useChecklistFields";
import { useCaseCompletionStats } from "@/hooks/useCaseCompletionStats";
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
  //
  // Shared stats via useCaseCompletionStats. Carmel's "2 missing" tile
  // (27 of her PENSION cases) is resolved here: pre-migration, Stage 10
  // iterated hook-filtered rows which still included the two contribution
  // scalars (confidence="MISSING" strings), landing them in the MISSING
  // band with no CA-accessible way to action them (ApprovalWorkspace hides
  // them). Post-migration the shared helper applies the same
  // CONTRIBUTIONS_LEGACY_FIELD_KEYS filter the other stages use, so those
  // scalars are no longer counted individually — they fold into the
  // Contributions grid synthetic slots which appear on the new "Grids
  // reviewed" line below.
  const { stats: _caseStats } = useCaseCompletionStats({
    caseId,
    planType: caseItem.plan_type,
  });
  const bands = _caseStats.confidenceBands;
  const manualOverrides = _caseStats.manualOverrides;
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

  // Grids reviewed card — new post-migration. Shows the Fund + Contribs
  // synthetic slots so the KPI panel accounts for every logical section
  // (not just scalars). Reviewed count stays at 0 pre-grid-approval-UI
  // (KI-17); display shows filled vs total so a CA sees whether the grids
  // have data at all. Only shows when gridSlots.total > 0 (always true
  // for Pension/ISA/GIA — there's always at least the Fund slot).
  if (_caseStats.gridSlots.total > 0) {
    cards.push(
      <StatCard
        key="grids"
        label="Grids reviewed"
        value={`${_caseStats.gridSlots.reviewed}/${_caseStats.gridSlots.total}`}
        sub={`${_caseStats.gridSlots.filled} populated with data`}
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

      {/* Hidden per user request (2026-07-28): the raw per-stage
          duration strip repeats internal enum names (STAGE_2_COLLECT_DETAILS,
          IN_REVIEW, …) and duplicates cover-page KPIs, so it wasn't
          reading as useful. The `stageDurations` compute above still
          runs cheaply, so bringing it back is a one-liner. */}
      {/*
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
      */}
    </div>
  );
}
