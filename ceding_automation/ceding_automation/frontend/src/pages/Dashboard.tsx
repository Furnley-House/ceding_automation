import { useEffect, useMemo, useRef, useState } from "react";
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
  FileCheck2,
  Upload,
  Users,
  Wand2,
  Info,
} from "lucide-react";
import { getCases, getCaseflow, type CaseStats } from "@/services/api";
import { useCaseStats } from "@/hooks/useCaseStats";
import { CASEFLOW_PERIODS, caseflowRange, type CaseflowPeriod } from "@/lib/caseflowPeriods";
import { auditApi } from "@/lib/api";
import { useRole } from "@/hooks/useRole";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Portal as TooltipPortal } from "@radix-ui/react-tooltip";

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

// A case is closed once ceding is complete or it's been cancelled (NPW) —
// UI statuses "complete" / "cancelled" from flattenCase. APPROVED is NOT
// closed: the checklist is signed off but Stage 9 (Export & WorkDrive)
// still has to run.
function isClosed(c: { status?: string }): boolean {
  const s = (c.status ?? "").toLowerCase();
  return s === "complete" || s === "cancelled";
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

// Animates a numeric target from 0 → target over `duration` ms using
// an ease-out curve. Falls back to the raw value when reduced-motion
// is requested or when the target is not a finite number.
function useCountUp(target: number | string, duration = 1400, delayMs = 0): string {
  const isNum = typeof target === "number" && Number.isFinite(target);
  const [display, setDisplay] = useState<number>(isNum ? 0 : 0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isNum) return;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setDisplay(target as number);
      return;
    }

    const isInteger = Number.isInteger(target as number);
    const targetNum = target as number;
    let cancelled = false;

    const tick = (now: number) => {
      if (cancelled) return;
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current - delayMs;
      if (elapsed < 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const current = targetNum * eased;
      setDisplay(isInteger ? Math.round(current) : Math.round(current * 10) / 10);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(targetNum);
      }
    };

    startRef.current = null;
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, delayMs, isNum]);

  if (!isNum) return String(target);
  return Number.isInteger(target as number)
    ? String(display)
    : display.toFixed(1);
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
  // CA team (we catch it and render a quieter empty state). Limited to the
  // last 24 hours and refreshed every minute, matching the "Live · last 24
  // hours" labels on the card.
  const { data: auditPayload } = useQuery({
    queryKey: ["audit", "global", "dashboard"],
    refetchInterval: 60_000,
    queryFn: async () => {
      try {
        const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const r = await auditApi.list({ limit: 10, from });
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

  // The dashboard shows every case the backend returns: all cases for
  // CA team / paraplanners / admin, linked cases only for advisers.
  const cases = rawCases as CaseLite[];

  // ────────────────────────────────────────────────────────
  // KPIs + caseflow — aggregated server-side (GET /cases/stats) so they
  // cover the whole caseload, not just the 200 rows fetched above.
  // ────────────────────────────────────────────────────────
  const { data: stats } = useCaseStats();

  // Caseflow period switch — bucket boundaries come from the browser's
  // local calendar (lib/caseflowPeriods.ts); counts from GET /cases/caseflow.
  const [flowPeriod, setFlowPeriod] = useState<CaseflowPeriod>("weeks");
  const flowRange = useMemo(() => caseflowRange(flowPeriod), [flowPeriod]);
  const { data: flowBuckets } = useQuery({
    queryKey: ["cases", "caseflow", flowPeriod, flowRange.end.toISOString()],
    queryFn: () => getCaseflow(flowRange.starts, flowRange.end),
  });
  const caseflow = useMemo(
    () =>
      (flowBuckets ?? []).map((b, i) => ({
        label: flowRange.labels[i] ?? "",
        range: flowRange.ranges[i] ?? "",
        opened: b.opened,
        delivered: b.completed,
      })),
    [flowBuckets, flowRange],
  );

  const weekDelta = stats ? stats.doneWeek - stats.doneLastWeek : 0;
  const donePct =
    stats && stats.total - stats.cancelled > 0
      ? Math.round((stats.completed * 100) / (stats.total - stats.cancelled))
      : 0;

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
    const palette = ["#63B1BC", "#8C4799", "#426DA9", "#CB333B"];
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
  const allClientRows = useMemo(() => {
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
        // Represent the client by their most recently updated *open* case, so
        // a finished case doesn't mask outstanding work on another plan.
        const top = sorted.find((it) => !isClosed(it)) ?? sorted[0]!;
        const totalStages = 10;
        const completed = Array.isArray(top.stages_completed)
          ? top.stages_completed.length
          : 0;
        const progressPct = Math.round((completed / totalStages) * 100);
        const tasksLeft = Math.max(0, totalStages - completed);
        // "Prepare for SR" is the action that takes the user to Stage 9
        // (Export — SR pack assembly + WorkDrive upload). It is the next
        // action *after* all preceding case-team tasks have been completed
        // for a client. The UI stage map is:
        //   1 CaseDetails · 2 SendLOA · 3 DocumentUpload · 4 AIExtraction
        //   5 CallAssist  · 6 ReviewChecklist · 7 AuditTrail · 8 Approval
        //   9 Export (= Prepare SR pack) · 10 Complete
        // So when `completed === 8` (stages 1-8 done) AND the case isn't
        // yet closed AND SR hasn't already been prepared, the next action
        // is to assemble the SR pack — that's when we surface the button.
        const caseClosed = isClosed(top);
        const alreadyPrepared = Boolean(top.sr_prepared_at);
        const srReady =
          !caseClosed && !alreadyPrepared && completed === 8;

        // Stronger signal: ALL of this client's cases are ceding-complete /
        // approved. At that point ceding is fully handed off to the adviser
        // for the Suitability Report. We surface a separate "Prepare for SR"
        // CTA that deep-links into the client's CRM record (where the
        // adviser will draft the SR). The CRM URL template is derived from
        // any case's zoho_deep_link by swapping the path to /tab/Contacts;
        // the exact CRM page can be tweaked later by the user.
        // At least one must be genuinely complete — a client whose cases
        // were all cancelled has nothing to hand to the adviser.
        const allClientCasesComplete =
          items.length > 0 &&
          items.every(isClosed) &&
          items.some((it) => it.backend_status === "STAGE_10_COMPLETE");

        let srCrmUrl: string | null = null;
        if (allClientCasesComplete) {
          // Try to build a Contacts URL from any deep link we have, falling
          // back to the bare CRM origin if we can't parse it.
          const anyDeepLink = items.find((it) => it.zoho_deep_link)?.zoho_deep_link;
          const clientZohoId = items.find((it) => it.client_zoho_id)?.client_zoho_id;
          if (clientZohoId && anyDeepLink) {
            // Sample link: https://crmsandbox.zoho.eu/crm/transactionsandbox/tab/Tasks/621...
            // Swap the trailing "/tab/Tasks/<id>" segment to "/tab/Contacts/<clientId>".
            srCrmUrl = anyDeepLink.replace(/\/tab\/[^/]+\/[^/?#]+/, `/tab/Contacts/${clientZohoId}`);
          } else if (clientZohoId) {
            srCrmUrl = `https://crm.zoho.eu/crm/tab/Contacts/${clientZohoId}`;
          }
        }

        return {
          name,
          top,
          items,
          completed,
          totalStages,
          progressPct,
          tasksLeft,
          srReady,
          allClientCasesComplete,
          srCrmUrl,
          updatedRelative: timeAgo(top.updated_at ?? top.created_at),
        };
      })
      .sort((a, b) => b.progressPct - a.progressPct);
  }, [cases]);
  const clientRows = allClientRows.slice(0, 4);

  // Hero "top priority": the open case closest to done. Fully signed-off
  // clients only surface (as the Prepare-SR prompt) when nothing is open —
  // otherwise they'd sit at 100% and pin the hero permanently.
  const topCase =
    allClientRows.find((r) => !isClosed(r.top)) ??
    allClientRows.find((r) => r.allClientCasesComplete);
  // Ticks every 30s so the Today card's clock (and the date, past midnight)
  // stays current instead of freezing at page-load time.
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setToday(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
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
  // Team load — open cases per owner across the whole team, counted
  // server-side (GET /cases/stats) so every role sees the full team, not
  // just the cases they can open. Bars are relative to the busiest person;
  // there's no capacity figure to measure "overloaded" against.
  // ────────────────────────────────────────────────────────
  // Team performance — per person: total, active and completed (with
  // shares of their total), ranked by completion rate server-side.
  const teamPerformance = stats?.teamPerformance ?? [];

  // ────────────────────────────────────────────────────────
  // Today — real to-do list from the viewer's caseload. Each bucket matches
  // a Cases-page status filter so the item opens exactly those cases.
  // ────────────────────────────────────────────────────────
  const todayItems = useMemo(() => {
    const n = (statuses: string[]) =>
      statuses.reduce((sum, st) => sum + (stats?.statusCounts?.[st] ?? 0), 0);
    const reviewer = role === "paraplanner" || role === "adviser";
    return [
      { key: "pending_loa", label: "Send LOAs", count: n(["DRAFT", "STAGE_1_LOA_PREP", "STAGE_2_COLLECT_DETAILS", "STAGE_3_CRM_SETUP"]) },
      { key: "awaiting_documents", label: "Chase provider documents", count: n(["STAGE_4_PROVIDER_REQUEST", "STAGE_5_CHASING", "STAGE_6_DOCUMENT_UPLOAD"]) },
      { key: "extraction_complete", label: "Verify extracted checklists", count: n(["STAGE_7_MISSING_INFO", "STAGE_8_VERIFY_CHECKLIST"]) },
      { key: "in_review", label: reviewer ? "Sign off reviews" : "Awaiting sign-off", count: n(["STAGE_9_PARAPLANNER_REVIEW", "IN_REVIEW"]) },
      { key: "approved", label: "Export approved cases to WorkDrive", count: n(["APPROVED"]) },
      { key: "on_hold", label: "Cases on hold", count: n(["ON_HOLD"]) },
    ].filter((i) => i.count > 0);
  }, [stats, role]);

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
            "linear-gradient(135deg, #253746 0%, #1a2832 60%, #2f4555 100%)",
        }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(40% 80% at 100% 0%, rgba(99,177,188,0.12), transparent 60%), radial-gradient(30% 60% at 80% 100%, rgba(184,136,74,0.08), transparent 60%)",
          }}
        />
        <div className="flex items-center justify-between gap-8 relative">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-teal flex items-center gap-2.5">
              <span>{heroDate} · Week {weekNum}</span>
              <span className="flex-1 max-w-[60px] h-px" style={{ background: "linear-gradient(90deg, rgba(99,177,188,0.5), transparent)" }} />
            </div>
            <h1 className="font-sans text-[36px] leading-tight font-bold tracking-tight mt-3 mb-2">
              Welcome back, <em className="text-teal not-italic">{userName?.split(" ")[0] ?? "there"}.</em>
            </h1>
            <p className="text-sm leading-relaxed text-white/60 max-w-[520px]">
              {topCase ? (
                <>
                  {topCase.allClientCasesComplete ? (
                    <>
                      <strong className="text-white/85 font-semibold">{topCase.name}</strong>'s
                      ceding is complete — all {topCase.items.length} case
                      {topCase.items.length === 1 ? "" : "s"} signed off. Ready for the
                      adviser to draft the Suitability Report.
                    </>
                  ) : topCase.srReady ? (
                    <>
                      <strong className="text-white/85 font-semibold">{topCase.name}</strong>'s
                      {topCase.top.provider_name ? ` ${topCase.top.provider_name}` : ""}
                      {topCase.top.plan_type ? ` ${topCase.top.plan_type}` : ""} case is ready
                      for SR pack. All upstream tasks are complete.
                    </>
                  ) : topCase.tasksLeft === 1 ? (
                    <>
                      <strong className="text-white/85 font-semibold">{topCase.name}</strong>'s
                      {topCase.top.provider_name ? ` ${topCase.top.provider_name}` : ""}
                      {topCase.top.plan_type ? ` ${topCase.top.plan_type}` : ""} case is one task
                      away from being report-ready.
                    </>
                  ) : (
                    <>
                      {/* Admin sees the whole team's caseload, not cases
                          assigned to them — word it accordingly.
                          Non-admins see their own myActive, not the full
                          team's `active` number (which read as "178" for
                          anyone and was never scoped to the viewer). */}
                      {role === "admin"
                        ? <>The team has{" "}<strong className="text-white/85 font-semibold">{stats?.active ?? "…"}</strong></>
                        : <>You have{" "}<strong className="text-white/85 font-semibold">{stats?.myActive ?? "…"}</strong></>
                      } active
                      {(role === "admin" ? stats?.active : stats?.myActive) === 1 ? " case" : " cases"}. Top priority is{" "}
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
              topCase.allClientCasesComplete && topCase.srCrmUrl ? (
                // All cases for this client are signed off → hand off to
                // adviser in CRM. Same destination as the Prepare-SR link
                // in the Caseload widget.
                <a
                  href={topCase.srCrmUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[#8C4799] to-[#a76ab2] text-white hover:from-[#9b5fa6] hover:to-[#b87fc2] border-0 h-10 px-5 font-semibold shadow-[0_0_0_4px_rgba(140,71,153,0.18)] text-sm"
                >
                  <FileCheck2 className="h-4 w-4" />
                  Prepare SR for {topCase.name.split(" ")[0]}
                </a>
              ) : topCase.srReady ? (
                <Button
                  onClick={() =>
                    navigate(`/cases/${topCase.top.id}`, {
                      state: { goToStage: 9 },
                    })
                  }
                  className="gap-2 rounded-full bg-gradient-to-r from-[#8C4799] to-[#a76ab2] text-white hover:from-[#9b5fa6] hover:to-[#b87fc2] border-0 h-10 px-5 font-semibold shadow-[0_0_0_4px_rgba(140,71,153,0.18)]"
                >
                  <FileCheck2 className="h-4 w-4" />
                  Prepare SR for {topCase.name.split(" ")[0]}
                </Button>
              ) : (
                <Button
                  onClick={() => navigate(`/cases/${topCase.top.id}`)}
                  className="gap-2 rounded-full bg-teal text-primary hover:bg-teal/90 border border-teal h-10 px-5 font-semibold"
                >
                  <Zap className="h-4 w-4" />
                  Resume {topCase.name.split(" ")[0]}'s case
                </Button>
              )
            ) : null}
            <Button
              variant="outline"
              onClick={() => navigate("/cases?new=1")}
              className="gap-2 rounded-full h-10 px-4 bg-transparent text-white border-white/20 hover:bg-white/10 hover:text-white hover:border-white/40"
            >
              <Plus className="h-4 w-4" /> New case
            </Button>
          </div>
        </div>
      </section>

      {/* ── KPI TILES ──────────────────────────────────────────
          No throughput target shown: the 75/week goal spans every plan type
          and depends on the full app shipping, so "Done · week" compares
          against last week instead.
          Removed:
          - "On hold"        — backend supports ON_HOLD, but no UI sets it
          - "AI confidence"  — confidence_score is never written to the DB
          - "Time saved"     — needs hands-on effort time, which isn't
                               recorded; replaced by median cycle time */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile
          tone="teal"
          label={role === "admin" ? "Active" : "My active"}
          value={role === "admin" ? (stats?.active ?? "—") : (stats?.myActive ?? "—")}
          // Admins see team-wide / total. Non-admins see their own count +
          // team-wide total as context in the sub-text. Item 14 in Revathy's
          // 2026-10-05 retest: she asked for the viewer's own count as the
          // primary number with the team total labelled separately so a CA
          // isn't told "you have 178 cases" when 178 is the whole team's.
          sub={
            stats
              ? role === "admin"
                ? `of ${stats.total} total`
                : `Team active: ${stats.active}`
              : "loading"
          }
          delta={
            stats
              ? (role === "admin" ? stats.active : stats.myActive) > 0
                ? `${donePct}% done`
                : "all clear"
              : undefined
          }
          icon={<Briefcase className="h-4 w-4" />}
          onClick={() =>
            navigate(role === "ca_team" || role === "paraplanner" ? "/cases?status=active&scope=mine" : "/cases?status=active")
          }
          index={0}
          info={TILE_INFO.active}
        />
        <KpiTile
          tone="green"
          label="Done · week"
          value={stats?.doneWeek ?? "—"}
          sub="completed since Monday"
          delta={
            stats
              ? weekDelta > 0
                ? `▲ ${weekDelta} vs last week`
                : weekDelta < 0
                  ? `▼ ${-weekDelta} vs last week`
                  : "same as last week"
              : undefined
          }
          icon={<CheckCircle2 className="h-4 w-4" />}
          onClick={() => navigate("/cases?status=complete&completed=week")}
          index={1}
          info={TILE_INFO.doneWeek}
        />
        <KpiTile
          tone="blue"
          label="In review"
          value={stats?.inReview ?? "—"}
          sub="awaiting sign-off"
          icon={<Clock className="h-4 w-4" />}
          onClick={() => navigate("/cases?status=in_review")}
          index={2}
          info={TILE_INFO.inReview}
        />
        <KpiTile
          tone="navy"
          label="Cycle time"
          value={stats?.cycleTime.medianDays ?? "—"}
          suffix={stats?.cycleTime.medianDays != null ? "d" : undefined}
          sub="median, open → complete"
          delta={
            stats
              ? stats.cycleTime.sampleSize > 0
                ? `${stats.cycleTime.sampleSize} case${stats.cycleTime.sampleSize === 1 ? "" : "s"} · last ${stats.cycleTime.windowDays}d`
                : `none completed in ${stats.cycleTime.windowDays}d`
              : undefined
          }
          icon={<Clock className="h-4 w-4" />}
          index={3}
          info={TILE_INFO.cycleTime}
        />
      </div>

      {/* ── CHARTS ROW ─────────────────────────────────────────
          Removed "Phase medians" — was driven entirely by MOCK constants
          and no audit-log aggregation backs it. Bring it back once we
          record CASE_STATUS_CHANGED timestamps consistently. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.7fr_1fr] gap-3.5">
        {/* Caseflow */}
        <ChartCard
          eyebrow="Caseflow"
          title="Cases moving through phases"
          subtitle={`· ${CASEFLOW_PERIODS.find((p) => p.key === flowPeriod)?.subtitle ?? ""}`}
          info={TILE_INFO.caseflow}
          legend={
            <>
              <LegendDot color="#63B1BC" /> Cases opened
              <LegendDot color="#8C4799" /> Ceding completed
            </>
          }
        >
          <div role="tablist" aria-label="Caseflow period" className="flex flex-wrap gap-1 mb-1">
            {CASEFLOW_PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="tab"
                aria-selected={flowPeriod === p.key}
                onClick={() => setFlowPeriod(p.key)}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                  flowPeriod === p.key
                    ? "bg-foreground text-background border-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <CaseflowChart buckets={caseflow} />
        </ChartCard>

        {/* Donut — cases by provider */}
        <ChartCard eyebrow="Mix" title="Cases by provider" info={TILE_INFO.providerMix}>
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
            info={TILE_INFO.caseload}
            titleMeta={`· ${stats?.active ?? "…"} active`}
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
                          {c.allClientCasesComplete ? (
                            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gradient-to-r from-[#8C4799] to-[#a76ab2] text-white">
                              All ceding done · Prepare SR
                            </span>
                          ) : c.srReady ? (
                            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gradient-to-r from-[#8C4799] to-[#a76ab2] text-white">
                              Ready for SR
                            </span>
                          ) : isReady ? (
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
                                ? "linear-gradient(90deg, #56C271, #7ad091)"
                                : "linear-gradient(90deg, #63B1BC, #7fc1cb)",
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
                      {c.allClientCasesComplete && c.srCrmUrl ? (
                        // All cases done → open the client's CRM record in a
                        // new tab so the adviser can draft the Suitability
                        // Report. URL is built off any case's zoho_deep_link;
                        // user can adjust the exact CRM page later.
                        <a
                          href={c.srCrmUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="h-8 px-3 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors bg-gradient-to-r from-[#7a3d87] to-[#8C4799] text-white hover:from-[#8C4799] hover:to-[#a76ab2] shadow-[0_0_0_4px_rgba(140,71,153,0.18)]"
                        >
                          <FileCheck2 className="h-3 w-3" />
                          Prepare SR
                        </a>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (c.srReady) {
                              navigate(`/cases/${c.top.id}`, {
                                state: { goToStage: 9 },
                              });
                            } else {
                              navigate(`/cases/${c.top.id}`);
                            }
                          }}
                          className={`h-8 px-3 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                            c.srReady
                              ? "bg-gradient-to-r from-[#7a3d87] to-[#8C4799] text-white hover:from-[#8C4799] hover:to-[#a76ab2] shadow-[0_0_0_4px_rgba(140,71,153,0.18)]"
                              : isReady
                                ? "bg-teal text-primary hover:bg-teal/90 shadow-[0_0_0_4px_rgba(99,177,188,0.16)]"
                                : "bg-primary text-primary-foreground hover:bg-primary/90"
                          }`}
                        >
                          {c.srReady ? (
                            <>
                              <FileCheck2 className="h-3 w-3" />
                              Prepare SR
                            </>
                          ) : isReady ? (
                            <>
                              Resume
                              <ArrowRight className="h-3 w-3" />
                            </>
                          ) : (
                            <>
                              Open
                              <ArrowRight className="h-3 w-3" />
                            </>
                          )}
                        </button>
                      )}
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
            info={TILE_INFO.activity}
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
            className="group rounded-2xl p-6 relative overflow-hidden border border-border"
            style={{ background: "#faf9f6" }}
          >
            <InfoTip text={TILE_INFO.today} className="absolute top-4 right-4 text-muted-foreground" />
            <div
              className="absolute -right-5 -bottom-5 w-32 h-32 rounded-full pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle, rgba(99,177,188,0.10), transparent 70%)",
              }}
            />
            <div className="font-sans text-[28px] font-bold leading-none tracking-tight text-foreground">
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
              {topCase && !topCase.allClientCasesComplete ? (
                <TodayItem
                  label={`Resume ${topCase.name.split(" ")[0]}'s case`}
                  pillTone="now"
                  pill="Next"
                  onClick={() => navigate(`/cases/${topCase.top.id}`)}
                />
              ) : null}
              {todayItems.map((item) => (
                <TodayItem
                  key={item.key}
                  label={item.label}
                  pill={String(item.count)}
                  pillTone={item.key === "approved" || item.key === "in_review" ? "due" : undefined}
                  onClick={() => navigate(`/cases?status=${item.key}`)}
                />
              ))}
              {stats && todayItems.length === 0 && !topCase ? (
                <li className="py-2.5 text-sm text-muted-foreground italic">
                  Nothing waiting — all clear.
                </li>
              ) : null}
            </ul>
          </div>

          {/* Weekly insights */}
          <AccordionCard
            iconTone="coral"
            icon={<Sparkles className="h-4 w-4" />}
            eyebrow="Weekly"
            title="This week, at a glance"
            info={TILE_INFO.weekly}
            defaultOpen={accordion.insights}
            onToggle={() =>
              setAccordion((v) => ({ ...v, insights: !v.insights }))
            }
          >
            <div className="px-5 pb-4 pt-1 space-y-3">
              <InsightRow
                tone="blue"
                num={stats?.doneMonth ?? 0}
                label="Cases closed this month"
                delta="ceding complete"
              />
              <InsightRow
                tone="gold"
                num={stats?.adviserCreated ?? 0}
                label="Cases opened by advisers"
                delta="adviser-led intros"
              />
            </div>
          </AccordionCard>

          {/* Team load */}
          <AccordionCard
            iconTone="blue"
            icon={<Users className="h-4 w-4" />}
            eyebrow="Workload"
            title="Team performance"
            info={TILE_INFO.teamLoad}
            titleMeta={`· ${teamPerformance.length} ${teamPerformance.length === 1 ? "person" : "people"} · ranked by completion`}
            rightPill={
              stats && stats.unassigned > 0 ? (
                <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-overdue/15 text-overdue">
                  {stats.unassigned} unassigned
                </span>
              ) : undefined
            }
            defaultOpen={accordion.team}
            onToggle={() => setAccordion((v) => ({ ...v, team: !v.team }))}
          >
            <div className="px-5 pb-4 pt-1 space-y-3 max-h-96 overflow-y-auto">
              {teamPerformance.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No cases assigned yet.</p>
              ) : (
                teamPerformance.map((t) => {
                  const me = (userName ?? "").trim() === t.name;
                  return (
                    <div key={t.userId} className="grid grid-cols-[22px_32px_1fr_92px] gap-3 items-center">
                      <div
                        className={`text-xs font-bold text-center ${t.rank <= 3 ? "text-foreground" : "text-muted-foreground"}`}
                        aria-label={`Rank ${t.rank}`}
                      >
                        #{t.rank}
                      </div>
                      <div
                        className="h-8 w-8 rounded-full text-white text-[11px] font-bold flex items-center justify-center"
                        style={{
                          background: me
                            ? "linear-gradient(135deg, #FFB81C, #CB333B)"
                            : "linear-gradient(135deg, #56C271, #63B1BC)",
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
                          {ROLE_LABEL[t.role] ?? t.role.replace(/_/g, " ").toLowerCase()} · {t.total} total
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          <span className="text-foreground font-medium">{t.active}</span> active ({t.activePct}%) ·{" "}
                          <span className="text-foreground font-medium">{t.completed}</span> completed ({t.completedPct}%)
                        </div>
                      </div>
                      <div>
                        <div className="text-right text-sm font-bold">{t.completedPct}%</div>
                        <div
                          className="h-1.5 bg-muted rounded-full overflow-hidden mt-1 flex"
                          title={`${t.completedPct}% completed, ${t.activePct}% active`}
                        >
                          <div className="h-full" style={{ width: `${t.completedPct}%`, background: "#56C271" }} />
                          <div className="h-full" style={{ width: `${t.activePct}%`, background: "#5a6878" }} />
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
  client_zoho_id?: string;
  provider_name?: string;
  plan_type?: string;
  plan_number?: string;
  status?: string;
  backend_status?: string;
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
  zoho_deep_link?: string;
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

const ROLE_LABEL: Record<string, string> = {
  CA_TEAM: "CA team",
  PARAPLANNER: "Paraplanner",
  ADVISER: "Adviser",
  ADMIN: "Admin",
};

const KPI_TONES: Record<string, { bg: string; text: string; iconBg: string }> = {
  teal: {
    bg: "linear-gradient(135deg, #63B1BC, #7fc1cb 80%, #9bd0d8)",
    text: "#253746",
    iconBg: "rgba(37,55,70,0.12)",
  },
  navy: { bg: "linear-gradient(135deg, #253746, #3a5364)", text: "white", iconBg: "rgba(255,255,255,0.18)" },
  blue: { bg: "linear-gradient(135deg, #426DA9, #5e85bd)", text: "white", iconBg: "rgba(255,255,255,0.18)" },
  coral: { bg: "linear-gradient(135deg, #CB333B, #db5d64)", text: "white", iconBg: "rgba(255,255,255,0.18)" },
  gold: { bg: "linear-gradient(135deg, #FFB81C, #ffc94d)", text: "#2a1f00", iconBg: "rgba(0,0,0,0.10)" },
  violet: { bg: "linear-gradient(135deg, #8C4799, #a76ab2)", text: "white", iconBg: "rgba(255,255,255,0.18)" },
  green: { bg: "linear-gradient(135deg, #B7BF10, #cbd239)", text: "#1f2305", iconBg: "rgba(0,0,0,0.10)" },
};

// ── Tile explanations (ⓘ tooltips) ────────────────────────
// Keep in sync with GET /cases/stats (backend/src/routes/cases.ts) and
// backend/src/utils/caseStats.ts.
const TILE_INFO = {
  active:
    "My active: open cases you own: assigned to you (CA Team: or created by you while unassigned; Paraplanner: you're the paraplanner; Adviser: your clients). Team active: every open case, everything except Ceding Complete (Stage 10) and Cancelled / NPW. Approved cases stay active until they're exported. \"Team % done\" = completed ÷ (total − cancelled).",
  doneWeek:
    "Cases that reached Ceding Complete (Stage 10) since Monday 00:00, compared with the whole of last week (Mon–Sun).",
  inReview: "Cases waiting for paraplanner sign-off — status In Review or Paraplanner Review. An adviser signs off only when the paraplanner is unavailable.",
  cycleTime:
    "Median number of days from a case being created to Ceding Complete, for cases completed in the last 90 days. Includes time waiting on providers, so it's elapsed time rather than hands-on effort.",
  caseflow:
    "Cases opened (teal) and cases that reached Ceding Complete (purple) per period. Switch between the last 5 weeks (Mon–Sun), last week by day, this month by day and this year by month. Hover a point for its numbers.",
  providerMix:
    "Share of cases by provider, across open and completed cases. The top 3 providers are shown; the rest are grouped as Other.",
  caseload:
    "Cases grouped by client. Each client is shown by their most recently updated open case; progress = stages completed out of 10. Sorted by progress, top 4 shown. The header count is active cases.",
  activity:
    "The latest audit-log events (up to 10) from the last 24 hours, across the whole team — uploads, extractions, edits, approvals, exports. Visible to Paraplanners, Advisers and Admins.",
  today:
    "Your to-do list: how many cases sit at each stage that needs action (send LOAs, chase documents, verify checklists, sign off, export). \"Next\" is the open case closest to completion. Click an item to open those cases.",
  weekly:
    "Cases closed this month: cases that reached Ceding Complete since the 1st of this month. Cases opened by advisers: all-time count of cases created by a user with the Adviser role.",
  teamLoad:
    "Cases per person across the whole team, all time. Owner = the assigned task owner, or the creator if no one is assigned. Total = active + completed (cancelled excluded); the percentages are each person's share of their own total. Ranked by completion rate, then by number completed. \"Unassigned\" = open cases with no owner.",
} as const;

// ⓘ icon that fades in when its tile is hovered/focused and explains the
// tile on hover. Sits inside clickable tiles, so it swallows clicks/keys to
// avoid navigating or toggling the tile. A <span>, not a <button>: KpiTile
// is itself a <button> and buttons can't nest.
function InfoTip({ text, className = "" }: { text: string; className?: string }) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={text}
          onClick={stop}
          onKeyDown={stop}
          className={`inline-flex align-middle cursor-help rounded-full opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal ${className}`}
        >
          <Info className="h-3.5 w-3.5" />
        </span>
      </TooltipTrigger>
      {/* Portal: every tile is overflow-hidden, which would clip the tooltip. */}
      <TooltipPortal>
        <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">
          {text}
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
}

function KpiTile({
  tone,
  label,
  value,
  suffix,
  sub,
  delta,
  icon,
  onClick,
  index = 0,
  info,
}: {
  tone: keyof typeof KPI_TONES;
  label: string;
  value: number | string;
  suffix?: string;
  sub?: string;
  delta?: string;
  icon: React.ReactNode;
  onClick?: () => void;
  index?: number;
  info?: string;
}) {
  const t = KPI_TONES[tone];
  // Stagger each tile by ~120ms so the counters fire in a wave on page load.
  const animated = useCountUp(value, 1400, index * 120);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="group rounded-2xl p-4 text-left relative overflow-hidden min-h-[112px] flex flex-col justify-between transition-transform hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-default disabled:hover:translate-y-0"
      style={{ background: t.bg, color: t.text }}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="text-[11px] font-bold tracking-[0.08em] uppercase"
          style={{ opacity: tone === "teal" ? 0.7 : tone === "green" || tone === "gold" ? 0.8 : 0.85 }}
        >
          {label}
          {info ? <InfoTip text={info} className="ml-1.5 -mt-px" /> : null}
        </span>
        <span
          className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: t.iconBg }}
        >
          {icon}
        </span>
      </div>
      <div>
        <div className="font-sans text-3xl font-bold leading-none tracking-tight mt-1 tabular-nums">
          {animated}
          {suffix ? <span className="text-lg opacity-75">{suffix}</span> : null}
        </div>
        <div
          className="text-[11px] mt-1.5 flex items-center gap-1.5"
          style={{ opacity: tone === "teal" ? 0.7 : tone === "green" || tone === "gold" ? 0.8 : 0.78 }}
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
  info,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  legend?: React.ReactNode;
  info?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group rounded-2xl border border-border bg-card p-5 flex flex-col">
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
            {info ? <InfoTip text={info} className="ml-1.5 text-muted-foreground" /> : null}
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
  buckets: { label: string; range: string; opened: number; delivered: number }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 540,
    H = 180,
    PAD = 30,
    BOTTOM = 30,
    LEFT = 30;
  const max = Math.max(8, ...buckets.flatMap((b) => [b.opened, b.delivered]));
  const step = (W - 60) / Math.max(1, buckets.length - 1);
  const xOf = (i: number) => (buckets.length === 1 ? W / 2 : LEFT + i * step);
  const yOf = (n: number) =>
    H - BOTTOM - ((n / max) * (H - BOTTOM - PAD)) || H - BOTTOM;
  // Up to ~8 axis labels; every point keeps its hover tooltip.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));

  if (buckets.length === 0) return <EmptyChart label="Loading caseflow…" />;

  const pointsOpened = buckets.map((b, i) => `${xOf(i)},${yOf(b.opened)}`);
  const pointsDelivered = buckets.map((b, i) => `${xOf(i)},${yOf(b.delivered)}`);
  const area = `M${pointsOpened.join(" L")} L${xOf(buckets.length - 1)},${H - BOTTOM} L${xOf(0)},${H - BOTTOM} Z`;
  const line = `M${pointsOpened.join(" L")}`;
  const violetLine = `M${pointsDelivered.join(" L")}`;
  const hb = hover !== null ? buckets[hover] : null;

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-44 mt-1" preserveAspectRatio="none">
        <defs>
          <linearGradient id="tealGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#63B1BC" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#63B1BC" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g stroke="#eef0f4" strokeWidth="1">
          {[0, 1, 2, 3].map((i) => (
            <line key={i} x1="0" y1={PAD + i * 40} x2={W} y2={PAD + i * 40} />
          ))}
        </g>
        <path d={area} fill="url(#tealGrad)" opacity={0.6} />
        <path d={line} stroke="#63B1BC" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d={violetLine} stroke="#8C4799" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        {hover !== null ? (
          <line x1={xOf(hover)} x2={xOf(hover)} y1={PAD - 10} y2={H - BOTTOM} stroke="#c9ced6" strokeDasharray="3 3" />
        ) : null}
        {buckets.map((b, i) => (
          <g key={i}>
            <circle cx={xOf(i)} cy={yOf(b.opened)} r={hover === i ? 5 : 3.5} fill="#63B1BC" />
            {b.delivered > 0 || hover === i ? (
              <circle cx={xOf(i)} cy={yOf(b.delivered)} r={hover === i ? 4.5 : 3} fill="#8C4799" />
            ) : null}
            {i % labelEvery === 0 || i === buckets.length - 1 ? (
              <text x={xOf(i)} y={H - 6} textAnchor="middle" fill="#888B8D" fontSize="9" fontFamily="Quicksand">
                {b.label}
              </text>
            ) : null}
            {/* Full-height hover band so the whole column is a target. */}
            <rect
              x={xOf(i) - Math.max(step, 24) / 2}
              y={0}
              width={Math.max(step, 24)}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              tabIndex={0}
              aria-label={`${b.range}: ${b.opened} opened, ${b.delivered} completed`}
            />
          </g>
        ))}
      </svg>
      {hb && hover !== null ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-md whitespace-nowrap"
          style={{ left: `${Math.min(88, Math.max(12, (xOf(hover) / W) * 100))}%` }}
        >
          <div className="font-semibold text-foreground mb-0.5">{hb.range}</div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: "#63B1BC" }} />
            Opened <span className="font-semibold text-foreground ml-auto pl-2">{hb.opened}</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: "#8C4799" }} />
            Completed <span className="font-semibold text-foreground ml-auto pl-2">{hb.delivered}</span>
          </div>
        </div>
      ) : null}
    </div>
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
      <text x="21" y="20.5" textAnchor="middle" fontFamily="Quicksand" fontSize="7" fontWeight="700" fill="#253746">
        {total}
      </text>
      <text x="21" y="25" textAnchor="middle" fontFamily="Quicksand" fontSize="2.5" fill="#888B8D">
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
  good: "linear-gradient(135deg, #56C271, #7ad091)",
  warn: "linear-gradient(135deg, #FFB81C, #ffc94d)",
  bad: "linear-gradient(135deg, #CB333B, #db5d64)",
  teal: "linear-gradient(135deg, #8C4799, #a76ab2)",
  blue: "linear-gradient(135deg, #426DA9, #5e85bd)",
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
        style={{ background: DOT_BG[meta.tone] ?? "#888B8D" }}
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
  info,
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
  info?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ICON_BG: Record<string, string> = {
    teal: "linear-gradient(135deg, #63B1BC, #7fc1cb)",
    violet: "linear-gradient(135deg, #8C4799, #a76ab2)",
    coral: "linear-gradient(135deg, #CB333B, #db5d64)",
    gold: "linear-gradient(135deg, #FFB81C, #ffc94d)",
    blue: "linear-gradient(135deg, #426DA9, #5e85bd)",
  };
  const handle = () => {
    setOpen((o) => !o);
    onToggle?.();
  };
  return (
    <div className="group rounded-2xl border border-border bg-card overflow-hidden">
      {/* div[role=button], not <button>: the header hosts its own buttons
          (View all, Show older) and a <button> can't contain another. */}
      <div
        onClick={handle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handle();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="w-full flex items-center gap-3.5 px-5 py-3.5 hover:bg-muted/30 transition-colors text-left cursor-pointer"
      >
        <span
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0 transition-transform hover:scale-110"
          style={{ background: ICON_BG[iconTone], color: iconTone === "teal" ? "#253746" : "white" }}
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
            {info ? <InfoTip text={info} className="ml-1.5 text-muted-foreground" /> : null}
          </div>
        </div>
        {rightPill}
        {rightLink}
        <ChevronDown
          className={`h-5 w-5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </div>
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
  onClick,
}: {
  label: string;
  done?: boolean;
  pill?: string;
  pillTone?: "now" | "due";
  onClick?: () => void;
}) {
  return (
    <li
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={`grid grid-cols-[18px_1fr_auto] items-center gap-2.5 py-2.5 border-t border-dashed border-border first:border-t-0 text-sm ${
        done ? "text-muted-foreground line-through decoration-muted-foreground/30" : "text-foreground/85"
      } ${onClick ? "cursor-pointer hover:text-foreground" : ""}`}
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
    coral: "linear-gradient(135deg, #CB333B, #db5d64)",
    blue: "linear-gradient(135deg, #426DA9, #5e85bd)",
    gold: "linear-gradient(135deg, #FFB81C, #ffc94d)",
  };
  const numColor: Record<string, string> = {
    coral: "#CB333B",
    blue: "#426DA9",
    gold: "#FFB81C",
  };
  return (
    <div className="flex items-center gap-3 text-xs py-3 border-b border-dashed border-border last:border-b-0">
      <span
        className="w-9 h-9 rounded-lg flex items-center justify-center text-white shrink-0"
        style={{ background: SWATCH[tone] }}
      >
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="font-sans text-xl font-bold leading-none tabular-nums min-w-[60px]" style={{ color: numColor[tone] }}>
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
