import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Briefcase,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Sparkles,
  Zap,
  ArrowRight,
  Plus,
  ChevronDown,
  Phone,
  FileText,
  Upload,
  Users,
  Wand2,
} from "lucide-react";
import { getCases } from "@/services/api";
import { auditApi } from "@/lib/api";
import { useRole } from "@/hooks/useRole";
import { Button } from "@/components/ui/button";

// ────────────────────────────────────────────────────────────
// MOCK / placeholder values — clearly marked so they're trivial
// to swap for real backend data later. See response notes for the
// full data-gap list.
// ────────────────────────────────────────────────────────────
const BASELINE_MIN_PER_CASE = 195; // FR-01 KPI: ~195 min baseline before automation
const MOCK_AI_CONFIDENCE_TREND = "▲ 3 pts"; // MOCK — needs historical snapshots
const MOCK_PHASE_MEDIANS = [
  // MOCK — needs audit_log aggregation by CASE_STATUS_CHANGED transitions
  { label: "1 · LOA prep", minutes: 3.2, color: "#00C2CB", widthPct: 18 },
  { label: "2 · AI extract", minutes: 1.1, color: "#4f7cf2", widthPct: 8 },
  { label: "3 · Call Assist", minutes: 4.4, color: "#6e56cf", widthPct: 28 },
  { label: "4 · Apply findings", minutes: 2.0, color: "#d99c4d", widthPct: 14 },
  { label: "5 · Hand off", minutes: 0.6, color: "#ef6b6b", widthPct: 5 },
];
const MOCK_PROVIDER_RESPONSE_DAYS = 1.2; // MOCK — needs LOA-sent → first-doc median
const MOCK_PROVIDER_RESPONSE_DELTA = "▼ 0.4d slower (Aviva)";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
function initials(name?: string | null): string {
  if (!name) return "—";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const m = Math.round(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

// ────────────────────────────────────────────────────────────
// Main page
// ────────────────────────────────────────────────────────────
const Dashboard = () => {
  const navigate = useNavigate();
  const { userName, role } = useRole();
  const [showOlderActivity, setShowOlderActivity] = useState(false);
  const [accordion, setAccordion] = useState({ insights: false, team: false });

  const { data: rawCases = [], isLoading } = useQuery<unknown[]>({
    queryKey: ["cases"],
    queryFn: getCases,
  });

  // Auditlog feed — guarded by RBAC server-side, so this just returns 403 for
  // CA team (we catch it and render a quieter empty state).
  const { data: auditPayload } = useQuery({
    queryKey: ["audit", "global", "dashboard"],
    queryFn: async () => {
      try {
        const r = await auditApi.list({ limit: 10 });
        return r.data as { logs: AuditRow[]; total: number } | AuditRow[];
      } catch {
        return null;
      }
    },
  });

  const audit: AuditRow[] = useMemo(() => {
    if (!auditPayload) return [];
    if (Array.isArray(auditPayload)) return auditPayload;
    return auditPayload.logs ?? [];
  }, [auditPayload]);

  // CA team only sees their own cases on the dashboard (mirrors the existing
  // behaviour and CaseRow.owner_name conventions).
  const cases = useMemo(() => {
    const all = rawCases as CaseLite[];
    if (role !== "ca_team") return all;
    return all.filter((c) => (c.owner_name ?? "").trim() === (userName ?? "").trim());
  }, [rawCases, role, userName]);

  // ────────────────────────────────────────────────────────
  // KPIs
  // ────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let active = 0,
      doneWeek = 0,
      inReview = 0,
      onHold = 0,
      doneMonth = 0,
      adviserCreated = 0;

    let totalCompletedMinutes = 0,
      completedSamples = 0;

    let confidenceSum = 0,
      confidenceSamples = 0;

    for (const c of cases) {
      const status = (c.status ?? "").toLowerCase();
      const updated = c.updated_at ? new Date(c.updated_at) : null;
      if (!["complete", "approved"].includes(status)) active++;
      if (status === "in_review") inReview++;
      if (status === "on_hold") onHold++;
      if (status === "complete" && updated && updated >= monday) doneWeek++;
      if (status === "complete" && updated && updated >= startOfMonth) doneMonth++;

      // case duration → time saved
      if (c.created_at && (status === "complete" || status === "approved")) {
        const created = new Date(c.created_at).getTime();
        const end = c.ceding_complete_date
          ? new Date(c.ceding_complete_date).getTime()
          : updated?.getTime() ?? null;
        if (end && end > created) {
          const minutes = (end - created) / 60000;
          // Only count cases that took <= 4h (240m) — otherwise the long
          // tail (cases waiting weeks on providers) skews the metric and
          // makes "time saved" look absurd. The KPI is about FH-side
          // processing time, not provider response time.
          if (minutes <= 240) {
            totalCompletedMinutes += minutes;
            completedSamples++;
          }
        }
      }

      const conf = typeof c.confidence_score === "number" ? c.confidence_score : null;
      if (conf !== null) {
        confidenceSum += conf;
        confidenceSamples++;
      }

      const createdBy = c.created_by as { role?: string } | undefined;
      if (createdBy?.role === "ADVISER") adviserCreated++;
    }

    const avgProcessingMin =
      completedSamples > 0 ? totalCompletedMinutes / completedSamples : null;
    const timeSavedMin =
      avgProcessingMin !== null
        ? Math.max(0, Math.round(BASELINE_MIN_PER_CASE - avgProcessingMin))
        : null;

    const aiConfidence =
      confidenceSamples > 0
        ? Math.round((confidenceSum / confidenceSamples) * 100) / 100
        : null;

    return {
      active,
      doneWeek,
      inReview,
      onHold,
      doneMonth,
      adviserCreated,
      timeSavedMin,
      aiConfidence,
      totalCases: cases.length,
    };
  }, [cases]);

  // ────────────────────────────────────────────────────────
  // Caseflow line chart — bucket created_at by week, last 30 days
  // ────────────────────────────────────────────────────────
  const caseflow = useMemo(() => {
    const buckets: { label: string; opened: number; delivered: number }[] = [];
    const now = new Date();
    for (let i = 4; i >= 0; i--) {
      const start = new Date(now);
      start.setDate(now.getDate() - i * 7);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      const label = start.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      });
      let opened = 0,
        delivered = 0;
      for (const c of cases) {
        const created = c.created_at ? new Date(c.created_at) : null;
        if (created && created >= start && created < end) opened++;
        const sr = c.sr_prepared_at ? new Date(c.sr_prepared_at) : null;
        if (sr && sr >= start && sr < end) delivered++;
      }
      buckets.push({ label, opened, delivered });
    }
    return buckets;
  }, [cases]);

  // ────────────────────────────────────────────────────────
  // Provider donut — top 3 + Other
  // ────────────────────────────────────────────────────────
  const providerMix = useMemo(() => {
    const tally = new Map<string, number>();
    for (const c of cases) {
      const k = c.provider_name?.trim() || "Unknown";
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    const arr = Array.from(tally.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => ({ name, n }));
    const top = arr.slice(0, 3);
    const otherN = arr.slice(3).reduce((s, x) => s + x.n, 0);
    if (otherN > 0) top.push({ name: "Other", n: otherN });
    const total = top.reduce((s, x) => s + x.n, 0);
    const palette = ["#00C2CB", "#6e56cf", "#4f7cf2", "#ef6b6b"];
    return top.map((p, i) => ({
      ...p,
      pct: total > 0 ? Math.round((p.n / total) * 1000) / 10 : 0,
      color: palette[i],
    }));
  }, [cases]);
  const providerTotal = providerMix.reduce((s, x) => s + x.n, 0);

  // ────────────────────────────────────────────────────────
  // Cases by client — group + progress
  // ────────────────────────────────────────────────────────
  const clientRows = useMemo(() => {
    const map = new Map<string, CaseLite[]>();
    for (const c of cases) {
      const k = c.client_name?.trim() || "Unknown client";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    return Array.from(map.entries())
      .map(([name, items]) => {
        const sorted = [...items].sort(
          (a, b) =>
            new Date(b.updated_at ?? b.created_at ?? 0).getTime() -
            new Date(a.updated_at ?? a.created_at ?? 0).getTime(),
        );
        const top = sorted[0]!;
        const totalStages = 10;
        const completed = Array.isArray(top.stages_completed)
          ? top.stages_completed.length
          : 0;
        const progressPct = Math.round((completed / totalStages) * 100);
        return {
          name,
          top,
          completed,
          totalStages,
          progressPct,
          tasksLeft: Math.max(0, totalStages - completed),
          updatedRelative: timeAgo(top.updated_at ?? top.created_at),
        };
      })
      .sort((a, b) => b.progressPct - a.progressPct)
      .slice(0, 4);
  }, [cases]);

  const topCase = clientRows[0];
  const today = new Date();
  const heroDate = today.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const weekNum = (() => {
    const d = new Date(today);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  })();

  // ────────────────────────────────────────────────────────
  // Team load — approx (no users API for CA role)
  // ────────────────────────────────────────────────────────
  const teamLoad = useMemo(() => {
    const allCases = (rawCases as CaseLite[]) ?? [];
    const tally = new Map<string, { active: number; role?: string }>();
    for (const c of allCases) {
      const k = c.owner_name?.trim();
      if (!k) continue;
      const active = !["complete", "approved"].includes((c.status ?? "").toLowerCase());
      const entry = tally.get(k) ?? { active: 0 };
      if (active) entry.active += 1;
      const ownerRole = (c.assigned_to as { role?: string } | undefined)?.role;
      if (ownerRole) entry.role = ownerRole;
      tally.set(k, entry);
    }
    const arr = Array.from(tally.entries())
      .map(([name, v]) => ({ name, active: v.active, role: v.role ?? "—" }))
      .sort((a, b) => b.active - a.active)
      .slice(0, 4);
    const max = Math.max(...arr.map((a) => a.active), 6);
    return arr.map((a) => ({
      ...a,
      pct: Math.round((a.active / max) * 100),
      over: a.pct > 85,
    }));
  }, [rawCases]);

  // ────────────────────────────────────────────────────────
  // Activity → audit log mapping
  // ────────────────────────────────────────────────────────
  const activityRows = useMemo(() => audit.slice(0, 5), [audit]);
  const olderActivityRows = useMemo(() => audit.slice(5, 10), [audit]);

  // ────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-6 w-6 rounded-full border-2 border-teal border-r-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="animate-slide-in space-y-5">
      {/* ── HERO ────────────────────────────────────────────── */}
      <section
        className="rounded-2xl px-8 py-7 text-white relative overflow-hidden"
        style={{
          background:
            "linear-gradient(135deg, #0D1B2A 0%, #0a1620 60%, #15293f 100%)",
        }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(40% 80% at 100% 0%, rgba(0,194,203,0.12), transparent 60%), radial-gradient(30% 60% at 80% 100%, rgba(184,136,74,0.08), transparent 60%)",
          }}
        />
        <div className="flex items-center justify-between gap-8 relative">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-teal flex items-center gap-2.5">
              <span>{heroDate} · Week {weekNum}</span>
              <span className="flex-1 max-w-[60px] h-px" style={{ background: "linear-gradient(90deg, rgba(0,194,203,0.5), transparent)" }} />
            </div>
            <h1 className="font-serif text-[36px] leading-tight font-medium tracking-tight mt-3 mb-2">
              Welcome back, <em className="text-teal not-italic">{userName?.split(" ")[0] ?? "there"}.</em>
            </h1>
            <p className="text-sm leading-relaxed text-white/60 max-w-[520px]">
              {topCase ? (
                <>
                  {topCase.tasksLeft <= 1 ? (
                    <>
                      <strong className="text-white/85 font-semibold">{topCase.name}</strong>'s
                      {topCase.top.provider_name ? ` ${topCase.top.provider_name}` : ""}
                      {topCase.top.plan_type ? ` ${topCase.top.plan_type}` : ""} case is one task
                      away from being report-ready. Worth a focused 30 minutes this morning.
                    </>
                  ) : (
                    <>
                      You have <strong className="text-white/85 font-semibold">{stats.active}</strong> active
                      cases. Top priority is{" "}
                      <strong className="text-white/85 font-semibold">{topCase.name}</strong> at{" "}
                      {topCase.progressPct}% complete.
                    </>
                  )}
                </>
              ) : (
                <>No active cases right now. Time to clear the inbox or kick off a new ceding.</>
              )}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {topCase ? (
              <Button
                onClick={() => navigate(`/cases/${topCase.top.id}`)}
                className="gap-2 rounded-full bg-teal text-primary hover:bg-teal/90 border border-teal h-10 px-5 font-semibold"
              >
                <Zap className="h-4 w-4" />
                Resume {topCase.name.split(" ")[0]}'s case
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => navigate("/cases")}
              className="gap-2 rounded-full h-10 px-4 bg-transparent text-white border-white/20 hover:bg-white/10 hover:text-white hover:border-white/40"
            >
              <Plus className="h-4 w-4" /> New case
            </Button>
          </div>
        </div>
      </section>

      {/* ── KPI TILES ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiTile
          tone="teal"
          label="Active"
          value={stats.active}
          sub={`of ${stats.totalCases} total`}
          delta={
            stats.active > 0 ? `${Math.round((stats.totalCases - stats.active) * 100 / Math.max(1, stats.totalCases))}% done` : "all clear"
          }
          icon={<Briefcase className="h-4 w-4" />}
          onClick={() => navigate("/cases?status=active")}
        />
        <KpiTile
          tone="navy"
          label="Done · week"
          value={stats.doneWeek}
          sub="primary KPI"
          delta={stats.doneWeek >= 4 ? "▲ on target" : `target 4 · ${Math.max(0, 4 - stats.doneWeek)} to go`}
          icon={<CheckCircle2 className="h-4 w-4" />}
          onClick={() => navigate("/cases?status=complete")}
        />
        <KpiTile
          tone="blue"
          label="In review"
          value={stats.inReview}
          sub="awaiting paraplanner"
          icon={<Clock className="h-4 w-4" />}
          onClick={() => navigate("/cases?status=in_review")}
        />
        <KpiTile
          tone="coral"
          label="On hold"
          value={stats.onHold}
          sub={stats.onHold === 0 ? "all clear" : "review reason"}
          icon={<AlertTriangle className="h-4 w-4" />}
          onClick={() => navigate("/cases?status=on_hold")}
        />
        <KpiTile
          tone="gold"
          label="Time saved"
          value={stats.timeSavedMin ?? "—"}
          suffix={stats.timeSavedMin !== null ? "m" : undefined}
          sub="avg/case vs baseline"
          delta={stats.timeSavedMin !== null ? `baseline ${BASELINE_MIN_PER_CASE}m` : "needs completed cases"}
          icon={<Clock className="h-4 w-4" />}
        />
        <KpiTile
          tone="violet"
          label="AI confidence"
          value={stats.aiConfidence ?? "—"}
          suffix={stats.aiConfidence !== null ? "%" : undefined}
          sub={`${cases.length} cases · ${MOCK_AI_CONFIDENCE_TREND}`}
          icon={<Sparkles className="h-4 w-4" />}
        />
      </div>

      {/* ── CHARTS ROW ───────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.7fr_1fr_1fr] gap-3.5">
        {/* Caseflow */}
        <ChartCard
          eyebrow="Caseflow"
          title="Cases moving through phases"
          subtitle="· last 5 weeks"
          legend={
            <>
              <LegendDot color="#00C2CB" /> Cases opened
              <LegendDot color="#6e56cf" /> SR delivered
            </>
          }
        >
          <CaseflowChart buckets={caseflow} />
        </ChartCard>

        {/* Donut — cases by provider */}
        <ChartCard eyebrow="Mix" title="Cases by provider">
          {providerTotal === 0 ? (
            <EmptyChart label="No cases yet" />
          ) : (
            <div className="flex items-center gap-4 flex-1">
              <DonutChart total={providerTotal} slices={providerMix} />
              <div className="flex flex-col gap-2 flex-1 text-xs">
                {providerMix.map((p) => (
                  <div key={p.name} className="flex items-center gap-2 text-foreground/80">
                    <span className="w-2 h-2 rounded-sm" style={{ background: p.color }} />
                    <span className="truncate">{p.name}</span>
                    <span className="ml-auto font-bold tabular-nums">{p.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </ChartCard>

        {/* Phase medians */}
        <ChartCard eyebrow="Throughput" title="Median time per phase">
          <div className="flex flex-col gap-3 flex-1 justify-center">
            {MOCK_PHASE_MEDIANS.map((p) => (
              <div key={p.label}>
                <div className="flex justify-between text-xs text-foreground/70 mb-1.5">
                  <strong className="font-bold">{p.label}</strong>
                  <span className="text-muted-foreground">{p.minutes} min</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${p.widthPct}%`, background: p.color }}
                  />
                </div>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      {/* ── TWO-COL: cases-by-client + activity / right rail ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
        {/* LEFT */}
        <div className="flex flex-col gap-4">
          {/* Cases by client */}
          <AccordionCard
            iconTone="teal"
            icon={<Briefcase className="h-4 w-4" />}
            eyebrow="Caseload"
            title="Cases by client"
            titleMeta={`· ${stats.active} active`}
            rightPill={
              <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-teal/15 text-teal">
                {clientRows.length} shown
              </span>
            }
            rightLink={
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigate("/cases");
                }}
                className="text-xs text-teal font-semibold hover:underline"
              >
                View all →
              </button>
            }
            defaultOpen
          >
            {clientRows.length === 0 ? (
              <p className="text-sm text-muted-foreground italic px-6 py-8 text-center">
                No cases yet — create one from the Cases page.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {clientRows.map((c, i) => {
                  const isReady = c.tasksLeft <= 1;
                  return (
                    <li
                      key={c.name}
                      className={`grid grid-cols-[36px_1fr_110px_auto] gap-4 items-center px-6 py-3.5 hover:bg-muted/30 cursor-pointer transition-colors ${
                        i > 0 ? "opacity-90" : ""
                      }`}
                      onClick={() => navigate(`/cases/${c.top.id}`)}
                    >
                      <div
                        className={`h-9 w-9 rounded-lg flex items-center justify-center text-xs font-bold tracking-wide ${
                          i === 0 ? "bg-teal/15 text-teal" : "bg-muted text-foreground/70"
                        }`}
                      >
                        {initials(c.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold tracking-tight truncate">{c.name}</span>
                          {isReady ? (
                            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal text-primary">
                              {c.tasksLeft} task left
                            </span>
                          ) : (
                            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-foreground/70">
                              {c.top.status?.replace(/_/g, " ")}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                          <span>{c.top.provider_name ?? "—"}</span>
                          <span className="w-0.5 h-0.5 rounded-full bg-muted-foreground/50" />
                          <span>{c.top.plan_type ?? "—"}</span>
                          {c.top.plan_number ? (
                            <>
                              <span className="w-0.5 h-0.5 rounded-full bg-muted-foreground/50" />
                              <span className="font-mono">{c.top.plan_number}</span>
                            </>
                          ) : null}
                          <span className="w-0.5 h-0.5 rounded-full bg-muted-foreground/50" />
                          <span>updated {c.updatedRelative}</span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{
                              width: `${c.progressPct}%`,
                              background: isReady
                                ? "linear-gradient(90deg, #16a34a, #34d399)"
                                : "linear-gradient(90deg, #00C2CB, #2fd9e0)",
                            }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
                          <span>
                            {c.completed} / {c.totalStages}
                          </span>
                          <span>{c.progressPct}%</span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/cases/${c.top.id}`);
                        }}
                        className={`h-8 px-3 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                          isReady
                            ? "bg-teal text-primary hover:bg-teal/90 shadow-[0_0_0_4px_rgba(0,194,203,0.16)]"
                            : "bg-primary text-primary-foreground hover:bg-primary/90"
                        }`}
                      >
                        {isReady ? "Resume" : "Open"}
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </AccordionCard>

          {/* Activity feed */}
          <AccordionCard
            iconTone="violet"
            icon={<Clock className="h-4 w-4" />}
            eyebrow="Live"
            title="Activity"
            titleMeta="· last 24 hours"
            rightPill={
              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-overdue">
                <span className="w-1.5 h-1.5 rounded-full bg-overdue animate-pulse" />
                Live
              </span>
            }
            rightLink={
              audit.length > 5 ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowOlderActivity((v) => !v);
                  }}
                  className="text-xs text-teal font-semibold hover:underline"
                >
                  {showOlderActivity ? "Hide older" : `Show older (${olderActivityRows.length}) ↓`}
                </button>
              ) : undefined
            }
            defaultOpen
          >
            {activityRows.length === 0 ? (
              <p className="text-sm text-muted-foreground italic px-6 py-6 text-center">
                {role === "ca_team"
                  ? "Activity feed is visible to paraplanner / adviser / admin only."
                  : "No activity in the last 24 hours."}
              </p>
            ) : (
              <ul>
                {activityRows.map((a) => (
                  <ActivityRow key={a.id} row={a} />
                ))}
                {showOlderActivity &&
                  olderActivityRows.map((a) => <ActivityRow key={a.id} row={a} />)}
              </ul>
            )}
          </AccordionCard>
        </div>

        {/* RIGHT RAIL */}
        <div className="flex flex-col gap-4">
          {/* TODAY paper card */}
          <div
            className="rounded-2xl p-6 relative overflow-hidden border border-border"
            style={{ background: "#faf9f6" }}
          >
            <div
              className="absolute -right-5 -bottom-5 w-32 h-32 rounded-full pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle, rgba(0,194,203,0.10), transparent 70%)",
              }}
            />
            <div className="font-serif text-[28px] font-medium leading-none tracking-tight text-foreground">
              {today.toLocaleDateString("en-GB", { weekday: "long" })}
              <div className="text-sm text-muted-foreground mt-2 font-sans font-medium tracking-wider uppercase">
                {today.toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
                {" · "}
                {today.toLocaleTimeString("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
            <ul className="mt-5 space-y-0">
              <TodayItem done label="Sync with Zoho CRM" pill="auto" />
              {topCase ? (
                <TodayItem
                  label={`Resume ${topCase.name.split(" ")[0]}'s case`}
                  pillTone="now"
                  pill="Now"
                />
              ) : null}
              <TodayItem label="Review approvals inbox" pill="11:30" />
              <TodayItem label="Apply call findings" pill="13:00" />
              <TodayItem
                label="Hand off completed cases"
                pillTone="due"
                pill="14:30"
              />
            </ul>
          </div>

          {/* Weekly insights */}
          <AccordionCard
            iconTone="coral"
            icon={<Sparkles className="h-4 w-4" />}
            eyebrow="Weekly"
            title="This week, at a glance"
            defaultOpen={accordion.insights}
            onToggle={() =>
              setAccordion((v) => ({ ...v, insights: !v.insights }))
            }
          >
            <div className="px-5 pb-4 pt-1 space-y-3">
              <InsightRow
                tone="coral"
                num={MOCK_PROVIDER_RESPONSE_DAYS}
                suffix="d"
                label="Median provider response"
                delta={MOCK_PROVIDER_RESPONSE_DELTA}
                deltaTone="down"
              />
              <InsightRow
                tone="blue"
                num={stats.doneMonth}
                label="Cases closed this month"
                delta="target 16 by month-end"
              />
              <InsightRow
                tone="gold"
                num={stats.adviserCreated}
                label="Cases opened by advisers"
                delta="adviser-led intros"
              />
            </div>
          </AccordionCard>

          {/* Team load */}
          <AccordionCard
            iconTone="blue"
            icon={<Users className="h-4 w-4" />}
            eyebrow="Today"
            title="Team load"
            titleMeta={`· ${teamLoad.length} people`}
            rightPill={
              teamLoad.some((t) => t.over) ? (
                <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-overdue/15 text-overdue">
                  {teamLoad.filter((t) => t.over).length} over
                </span>
              ) : undefined
            }
            defaultOpen={accordion.team}
            onToggle={() => setAccordion((v) => ({ ...v, team: !v.team }))}
          >
            <div className="px-5 pb-4 pt-1 space-y-3">
              {teamLoad.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No assignees on active cases yet.</p>
              ) : (
                teamLoad.map((t) => {
                  const me = (userName ?? "").trim() === t.name;
                  return (
                    <div key={t.name} className="grid grid-cols-[32px_1fr_60px] gap-3 items-center">
                      <div
                        className="h-8 w-8 rounded-full text-white text-[11px] font-bold flex items-center justify-center"
                        style={{
                          background: me
                            ? "linear-gradient(135deg, #f59e0b, #dc2626)"
                            : "linear-gradient(135deg, #0d9488, #22d3ee)",
                        }}
                      >
                        {initials(t.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold flex items-center gap-1.5">
                          {t.name}
                          {me ? (
                            <span className="text-[10px] text-teal font-semibold">· you</span>
                          ) : null}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t.role.replace(/_/g, " ").toLowerCase()} · {t.active} active
                        </div>
                      </div>
                      <div>
                        <div className="h-1 bg-muted rounded-full overflow-hidden mb-1">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{
                              width: `${Math.min(100, t.pct)}%`,
                              background: t.over ? "#b45309" : "#5a6779",
                            }}
                          />
                        </div>
                        <div className="text-[10px] text-muted-foreground text-right tabular-nums">
                          {t.pct}%
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </AccordionCard>
        </div>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────
interface CaseLite {
  id: string;
  client_name?: string;
  provider_name?: string;
  plan_type?: string;
  plan_number?: string;
  status?: string;
  owner_name?: string;
  created_at?: string;
  updated_at?: string;
  ceding_complete_date?: string;
  sr_prepared_at?: string;
  confidence_score?: number | null;
  stages_completed?: number[];
  current_stage?: number;
  zoho_ceding_status?: string;
  zoho_task_id?: string;
  created_by?: { role?: string };
  assigned_to?: { role?: string };
}

interface AuditRow {
  id: string;
  created_at: string;
  case_id: string;
  case_ref?: string | null;
  client_name?: string | null;
  action: string;
  source: string;
  field_label?: string | null;
  field_key?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  actor_name?: string | null;
}

const KPI_TONES: Record<string, { bg: string; text: string; iconBg: string }> = {
  teal: {
    bg: "linear-gradient(135deg, #00C2CB, #2fd9e0 80%, #5feaef)",
    text: "#0D1B2A",
    iconBg: "rgba(13,27,42,0.12)",
  },
  navy: { bg: "linear-gradient(135deg, #1e2d3f, #29405d)", text: "white", iconBg: "rgba(255,255,255,0.18)" },
  blue: { bg: "linear-gradient(135deg, #4f7cf2, #6b94ff)", text: "white", iconBg: "rgba(255,255,255,0.18)" },
  coral: { bg: "linear-gradient(135deg, #ef6b6b, #f59292)", text: "white", iconBg: "rgba(255,255,255,0.18)" },
  gold: { bg: "linear-gradient(135deg, #d99c4d, #e9b97c)", text: "white", iconBg: "rgba(255,255,255,0.18)" },
  violet: { bg: "linear-gradient(135deg, #6e56cf, #9d8aec)", text: "white", iconBg: "rgba(255,255,255,0.18)" },
};

function KpiTile({
  tone,
  label,
  value,
  suffix,
  sub,
  delta,
  icon,
  onClick,
}: {
  tone: keyof typeof KPI_TONES;
  label: string;
  value: number | string;
  suffix?: string;
  sub?: string;
  delta?: string;
  icon: React.ReactNode;
  onClick?: () => void;
}) {
  const t = KPI_TONES[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="rounded-2xl p-4 text-left relative overflow-hidden min-h-[112px] flex flex-col justify-between transition-transform hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-default disabled:hover:translate-y-0"
      style={{ background: t.bg, color: t.text }}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="text-[11px] font-bold tracking-[0.08em] uppercase"
          style={{ opacity: tone === "teal" ? 0.7 : 0.85 }}
        >
          {label}
        </span>
        <span
          className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: t.iconBg }}
        >
          {icon}
        </span>
      </div>
      <div>
        <div className="font-serif text-3xl font-medium leading-none tracking-tight mt-1">
          {value}
          {suffix ? <span className="text-lg opacity-75">{suffix}</span> : null}
        </div>
        <div
          className="text-[11px] mt-1.5 flex items-center gap-1.5"
          style={{ opacity: tone === "teal" ? 0.7 : 0.78 }}
        >
          <span>{sub}</span>
          {delta ? <span className="font-semibold">· {delta}</span> : null}
        </div>
      </div>
    </button>
  );
}

function ChartCard({
  eyebrow,
  title,
  subtitle,
  legend,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 flex flex-col">
      <div className="flex items-start justify-between mb-2.5 gap-2">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </div>
          <div className="text-sm font-bold mt-0.5 tracking-tight">
            {title}
            {subtitle ? (
              <small className="font-medium text-muted-foreground ml-1.5 text-xs">
                {subtitle}
              </small>
            ) : null}
          </div>
        </div>
        {legend ? (
          <div className="flex gap-3 text-[11px] text-muted-foreground items-center">{legend}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function LegendDot({ color }: { color: string }) {
  return (
    <span className="inline-flex items-center gap-1 mr-3 last:mr-0">
      <span className="w-2.5 h-[3px] rounded-sm" style={{ background: color }} />
    </span>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-xs italic text-muted-foreground py-6">
      {label}
    </div>
  );
}

function CaseflowChart({
  buckets,
}: {
  buckets: { label: string; opened: number; delivered: number }[];
}) {
  const W = 540,
    H = 180,
    PAD = 30,
    BOTTOM = 30;
  const max = Math.max(8, ...buckets.flatMap((b) => [b.opened, b.delivered]));
  const step = (W - 60) / Math.max(1, buckets.length - 1);
  const yOf = (n: number) =>
    H - BOTTOM - ((n / max) * (H - BOTTOM - PAD)) || H - BOTTOM;

  const pointsOpened = buckets.map((b, i) => `${30 + i * step},${yOf(b.opened)}`);
  const pointsDelivered = buckets.map(
    (b, i) => `${30 + i * step},${yOf(b.delivered)}`,
  );
  const area = `M${pointsOpened.join(" L")} L${30 + (buckets.length - 1) * step},${H - BOTTOM} L30,${H - BOTTOM} Z`;
  const line = `M${pointsOpened.join(" L")}`;
  const violetLine = `M${pointsDelivered.join(" L")}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-44 mt-1" preserveAspectRatio="none">
      <defs>
        <linearGradient id="tealGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00C2CB" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#00C2CB" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="#eef0f4" strokeWidth="1">
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1="0" y1={PAD + i * 40} x2={W} y2={PAD + i * 40} />
        ))}
      </g>
      <path d={area} fill="url(#tealGrad)" opacity={0.6} />
      <path d={line} stroke="#00C2CB" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d={violetLine} stroke="#6e56cf" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {buckets.map((b, i) => (
        <g key={i}>
          <circle cx={30 + i * step} cy={yOf(b.opened)} r="3.5" fill="#00C2CB" />
          {b.delivered > 0 ? (
            <circle cx={30 + i * step} cy={yOf(b.delivered)} r="3" fill="#6e56cf" />
          ) : null}
          <text
            x={30 + i * step}
            y={H - 6}
            textAnchor="middle"
            fill="#8a94a3"
            fontSize="9"
            fontFamily="Inter"
          >
            {b.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function DonutChart({
  total,
  slices,
}: {
  total: number;
  slices: { name: string; n: number; pct: number; color: string }[];
}) {
  // SVG donut using stroke-dasharray on a circle of circumference 100.
  let offset = 25;
  return (
    <svg width="120" height="120" viewBox="0 0 42 42" className="shrink-0">
      <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="#eef0f4" strokeWidth="4" />
      {slices.map((s) => {
        const dash = `${s.pct} ${100 - s.pct}`;
        const node = (
          <circle
            key={s.name}
            cx="21"
            cy="21"
            r="15.915"
            fill="transparent"
            stroke={s.color}
            strokeWidth="4"
            strokeDasharray={dash}
            strokeDashoffset={offset}
            transform="rotate(-90 21 21)"
          />
        );
        offset -= s.pct;
        return node;
      })}
      <text x="21" y="20.5" textAnchor="middle" fontFamily="Fraunces, Georgia, serif" fontSize="7" fontWeight="500" fill="#0D1B2A">
        {total}
      </text>
      <text x="21" y="25" textAnchor="middle" fontFamily="Inter" fontSize="2.5" fill="#8a94a3">
        total
      </text>
    </svg>
  );
}

const ACTION_DOT: Record<string, { tone: string; icon: React.ElementType }> = {
  AI_EXTRACTION_RUN: { tone: "good", icon: Sparkles },
  FIELD_EXTRACTED: { tone: "good", icon: Sparkles },
  DOCUMENT_UPLOADED: { tone: "blue", icon: Upload },
  CASE_CREATED: { tone: "blue", icon: FileText },
  FIELD_EDITED: { tone: "warn", icon: Wand2 },
  FIELD_APPROVED: { tone: "good", icon: CheckCircle2 },
  FIELD_REVIEW_REQUESTED: { tone: "warn", icon: AlertTriangle },
  CALL_SCRIPT_GENERATED: { tone: "teal", icon: Phone },
  TRANSCRIPT_ANALYSED: { tone: "teal", icon: Phone },
  CASE_APPROVED: { tone: "good", icon: CheckCircle2 },
  CHECKLIST_EXPORTED: { tone: "teal", icon: FileText },
  WORKDRIVE_EXPORTED: { tone: "teal", icon: FileText },
  CASE_ASSIGNED: { tone: "teal", icon: Users },
  CHASE_LOGGED: { tone: "warn", icon: AlertTriangle },
};
const DOT_BG: Record<string, string> = {
  good: "linear-gradient(135deg, #00C2CB, #2fd9e0)",
  warn: "linear-gradient(135deg, #d99c4d, #e9b97c)",
  bad: "linear-gradient(135deg, #ef6b6b, #f59292)",
  teal: "linear-gradient(135deg, #6e56cf, #9d8aec)",
  blue: "linear-gradient(135deg, #4f7cf2, #6b94ff)",
};

function ActivityRow({ row }: { row: AuditRow }) {
  const meta = ACTION_DOT[row.action] ?? { tone: "good", icon: Sparkles };
  const Icon = meta.icon;
  const summary = (() => {
    switch (row.action) {
      case "AI_EXTRACTION_RUN":
        return `${row.new_value ?? "Fields"} auto-filled by AI`;
      case "FIELD_EXTRACTED":
        return `${row.field_label ?? row.field_key ?? "Field"} extracted`;
      case "DOCUMENT_UPLOADED":
        return `Document uploaded — ${row.new_value ?? "file"}`;
      case "FIELD_EDITED":
        return `${row.field_label ?? "Field"} edited manually`;
      case "FIELD_APPROVED":
        return `${row.field_label ?? "Field"} approved`;
      case "FIELD_REVIEW_REQUESTED":
        return `Review requested on ${row.field_label ?? "field"}`;
      case "CALL_SCRIPT_GENERATED":
        return `Call script generated · ${row.new_value ?? ""}`;
      case "TRANSCRIPT_ANALYSED":
        return `Transcript analysed`;
      case "CASE_APPROVED":
        return `Case approved`;
      case "CHECKLIST_EXPORTED":
        return `Checklist exported · ${row.new_value ?? "Excel"}`;
      case "WORKDRIVE_EXPORTED":
        return `Uploaded to WorkDrive`;
      case "CASE_ASSIGNED":
        return `Case assigned`;
      case "CHASE_LOGGED":
        return `Chase logged`;
      case "CASE_CREATED":
        return `Case created`;
      default:
        return row.action.replace(/_/g, " ").toLowerCase();
    }
  })();

  return (
    <li className="grid grid-cols-[22px_1fr_auto] gap-3.5 px-5 py-3 items-start relative hover:bg-muted/30 transition-colors">
      <span
        className="w-5 h-5 rounded-full flex items-center justify-center text-white shrink-0 z-10 relative"
        style={{ background: DOT_BG[meta.tone] ?? "#94a3b8" }}
      >
        <Icon className="h-3 w-3" strokeWidth={2.5} />
      </span>
      <div>
        <div className="text-sm leading-relaxed text-foreground/85">
          {row.client_name ? <strong className="font-semibold text-foreground">{row.client_name}</strong> : null}
          {row.client_name ? " · " : null}
          {summary}
        </div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-1">
          {row.case_ref ? (
            <span className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded">
              {row.case_ref}
            </span>
          ) : null}
          {row.actor_name ? <span>· {row.actor_name}</span> : null}
        </div>
      </div>
      <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
        {timeAgo(row.created_at)}
      </span>
    </li>
  );
}

function AccordionCard({
  iconTone,
  icon,
  eyebrow,
  title,
  titleMeta,
  rightPill,
  rightLink,
  defaultOpen = false,
  onToggle,
  children,
}: {
  iconTone: "teal" | "violet" | "coral" | "gold" | "blue";
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  titleMeta?: string;
  rightPill?: React.ReactNode;
  rightLink?: React.ReactNode;
  defaultOpen?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ICON_BG: Record<string, string> = {
    teal: "linear-gradient(135deg, #00C2CB, #2fd9e0)",
    violet: "linear-gradient(135deg, #6e56cf, #9d8aec)",
    coral: "linear-gradient(135deg, #ef6b6b, #f59292)",
    gold: "linear-gradient(135deg, #d99c4d, #e9b97c)",
    blue: "linear-gradient(135deg, #4f7cf2, #6b94ff)",
  };
  const handle = () => {
    setOpen((o) => !o);
    onToggle?.();
  };
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <button
        onClick={handle}
        type="button"
        className="w-full flex items-center gap-3.5 px-5 py-3.5 hover:bg-muted/30 transition-colors text-left"
      >
        <span
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0 transition-transform hover:scale-110"
          style={{ background: ICON_BG[iconTone], color: iconTone === "teal" ? "#0D1B2A" : "white" }}
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </div>
          <div className="text-sm font-bold tracking-tight">
            {title}
            {titleMeta ? <small className="ml-1 text-muted-foreground font-medium">{titleMeta}</small> : null}
          </div>
        </div>
        {rightPill}
        {rightLink}
        <ChevronDown
          className={`h-5 w-5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`overflow-hidden transition-[max-height] duration-500 ease-out ${
          open ? "max-h-[2000px]" : "max-h-0"
        }`}
      >
        <div className="border-t border-border">{children}</div>
      </div>
    </div>
  );
}

function TodayItem({
  label,
  done,
  pill,
  pillTone,
}: {
  label: string;
  done?: boolean;
  pill?: string;
  pillTone?: "now" | "due";
}) {
  return (
    <li
      className={`grid grid-cols-[18px_1fr_auto] items-center gap-2.5 py-2.5 border-t border-dashed border-border first:border-t-0 text-sm ${
        done ? "text-muted-foreground line-through decoration-muted-foreground/30" : "text-foreground/85"
      }`}
    >
      <span
        className={`w-4 h-4 rounded-full border-[1.5px] ${
          done ? "bg-success border-success" : "bg-white border-muted-foreground/50"
        }`}
      />
      <span className={done ? "" : "font-medium"}>{label}</span>
      <span
        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
          pillTone === "now"
            ? "bg-teal text-primary"
            : pillTone === "due"
              ? "bg-overdue/15 text-overdue"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {pill}
      </span>
    </li>
  );
}

function InsightRow({
  tone,
  num,
  suffix,
  label,
  delta,
  deltaTone,
}: {
  tone: "coral" | "blue" | "gold";
  num: number | string;
  suffix?: string;
  label: string;
  delta?: string;
  deltaTone?: "up" | "down";
}) {
  const SWATCH: Record<string, string> = {
    coral: "linear-gradient(135deg, #ef6b6b, #f59292)",
    blue: "linear-gradient(135deg, #4f7cf2, #6b94ff)",
    gold: "linear-gradient(135deg, #d99c4d, #e9b97c)",
  };
  const numColor: Record<string, string> = {
    coral: "#ef6b6b",
    blue: "#4f7cf2",
    gold: "#d99c4d",
  };
  return (
    <div className="flex items-center gap-3 text-xs py-3 border-b border-dashed border-border last:border-b-0">
      <span
        className="w-9 h-9 rounded-lg flex items-center justify-center text-white shrink-0"
        style={{ background: SWATCH[tone] }}
      >
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="font-serif text-xl font-medium leading-none tabular-nums min-w-[60px]" style={{ color: numColor[tone] }}>
        {num}
        {suffix ? <span className="text-xs text-muted-foreground ml-0.5">{suffix}</span> : null}
      </div>
      <div className="flex-1 text-foreground/80 leading-snug">
        <strong className="text-foreground">{label}</strong>
        {delta ? (
          <span
            className={`block text-[10px] mt-0.5 ${
              deltaTone === "down"
                ? "text-overdue"
                : deltaTone === "up"
                  ? "text-success"
                  : "text-muted-foreground"
            }`}
          >
            {delta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default Dashboard;
