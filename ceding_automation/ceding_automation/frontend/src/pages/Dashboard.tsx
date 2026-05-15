import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Briefcase,
  Sparkles,
  Database,
  AlertTriangle,
  CheckCircle2,
  Clock,
  TrendingUp,
  ArrowRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  Users,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useState } from "react";
import { getCases, updateCase } from "@/services/api";
import { useRole } from "@/hooks/useRole";
import { calculateRag, RAG_STYLES, STATUS_LABELS, STATUS_STYLES } from "@/lib/caseHelpers";
import { seedDemoData } from "@/lib/seedDemoData";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const Dashboard = () => {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { userName, role } = useRole();
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set());

  const { data: cases = [], isLoading } = useQuery({ queryKey: ["cases"], queryFn: getCases });

  // CA team members only see tasks assigned to them (mirrors CRM
  // ownership). Advisers/paraplanners/admins see everything.
  const myCases = role === "ca_team"
    ? (cases as any[]).filter((c) => (c.owner_name ?? "").trim() === (userName ?? "").trim())
    : (cases as any[]);

  const seedMutation = useMutation({
    mutationFn: seedDemoData,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      toast.success(r.inserted > 0 ? `Loaded ${r.inserted} starter cases` : "Starter cases already loaded");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);

  const weeklyCompleted = myCases.filter(
    (c) => c.status === "complete" && new Date(c.updated_at) >= monday,
  ).length;
  const inReview = myCases.filter((c) => c.status === "in_review").length;
  const onHold = myCases.filter((c) => c.status === "on_hold").length;
  const active = myCases.filter((c) => !["complete", "approved"].includes(c.status)).length;

  const recent = [...myCases]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 6);

  // SR-ready: ceding finished AND Zoho confirmed AND SR not already prepared.
  // For CA team this is scoped to their own tasks.
  const srReady = myCases
    .filter(
      (c: any) =>
        c.zoho_ceding_status === "ceding_complete" &&
        ["complete", "approved"].includes(c.status) &&
        !c.sr_prepared_at,
    )
    .sort(
      (a: any, b: any) =>
        new Date(b.ceding_complete_date ?? b.updated_at).getTime() -
        new Date(a.ceding_complete_date ?? a.updated_at).getTime(),
    );

  // Group every case by client so advisers can see SR readiness across all
  // ceding tasks belonging to the same person.
  const clientGroups = (() => {
    const map = new Map<string, any[]>();
    for (const c of cases as any[]) {
      const key = c.client_name?.trim() || "Unknown client";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries())
      // CA team only sees clients where they own at least one task.
      // Aggregate counts still include every CA's tasks so they know whether
      // the client is ready for SR overall.
      .filter(([, items]) => {
        if (role !== "ca_team") return true;
        return items.some(
          (i) => (i.owner_name ?? "").trim() === (userName ?? "").trim(),
        );
      })
      .map(([client_name, items]) => {
        const total = items.length;
        const completed = items.filter((i) =>
          ["complete", "approved"].includes(i.status),
        ).length;
        const allComplete = total > 0 && completed === total;
        const allZohoConfirmed =
          allComplete && items.every((i) => i.zoho_ceding_status === "ceding_complete");
        const anySrInProgress = items.some((i) => i.sr_prepared_at);
        const srReady = allZohoConfirmed && !anySrInProgress;
        const myItems = role === "ca_team"
          ? items.filter(
              (i) => (i.owner_name ?? "").trim() === (userName ?? "").trim(),
            )
          : items;
        return {
          client_name,
          items,
          myItems,
          total,
          completed,
          allComplete,
          srReady,
          anySrInProgress,
        };
      })
      .sort((a, b) => {
        // SR-ready first, then most incomplete, then alphabetical
        if (a.srReady !== b.srReady) return a.srReady ? -1 : 1;
        const aRem = a.total - a.completed;
        const bRem = b.total - b.completed;
        if (aRem !== bRem) return bRem - aRem;
        return a.client_name.localeCompare(b.client_name);
      });
  })();

  const toggleClient = (name: string) => {
    setExpandedClients((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handlePrepareSR = async (c: any) => {
    if (c.zoho_ceding_status !== "ceding_complete") {
      toast.error("Ceding is not confirmed yet", {
        description: "Wait for the CRM blueprint to mark ceding complete.",
      });
      return;
    }
    setPreparingId(c.id);
    try {
      // Production integration point: trigger the SR Preparation transition on the linked task.
      await new Promise((r) => setTimeout(r, 600));
      await updateCase(c.id, {
        sr_prepared_at: new Date().toISOString(),
        zoho_ceding_status: "sr_in_progress",
      } as any);
      qc.invalidateQueries({ queryKey: ["cases"] });
      toast.success("SR blueprint triggered", { description: "Opening task…" });
      if (c.zoho_task_id) {
        // const taskUrl = `https://crm.zoho.eu/crm/tab/Tasks/${c.zoho_task_id}`;
        const taskUrl = `https://crmsandbox.zoho.eu/crm/transactionsandbox/tab/Tasks/${c.zoho_task_id}`;
        window.open(taskUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to prepare SR", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPreparingId(null);
    }
  };

  const handleSyncZoho = async () => {
    // Production integration point: pull the latest blueprint status for linked tasks.
    setSyncing(true);
    try {
      await new Promise((r) => setTimeout(r, 800));
      qc.invalidateQueries({ queryKey: ["cases"] });
      toast.success("Synced with CRM");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="animate-slide-in">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-teal font-semibold mb-1">
            {today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
          </p>
          <h1 className="text-2xl font-bold theme-heading text-foreground">Welcome back, {userName?.split(" ")[0]}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Here's what's happening across your ceding cases today.
          </p>
        </div>
        {cases.length === 0 && (
          <Button onClick={() => seedMutation.mutate()} disabled={seedMutation.isPending} className="gap-2">
            <Database className="h-4 w-4" />
            {seedMutation.isPending ? "Loading…" : "Load starter cases"}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4 mb-6">
        <KPICard
          icon={Briefcase}
          label="Active cases"
          value={active}
          sub={`${cases.length} total`}
          accent="primary"
          onClick={() => navigate("/cases?status=active")}
        />
        <KPICard
          icon={CheckCircle2}
          label="Completed this week"
          value={weeklyCompleted}
          sub="Primary KPI"
          accent="success"
          onClick={() => navigate("/cases?status=complete")}
        />
        <KPICard
          icon={Clock}
          label="In review"
          value={inReview}
          sub="Awaiting approval"
          accent="warning"
          onClick={() => navigate("/cases?status=in_review")}
        />
        <KPICard
          icon={AlertTriangle}
          label="On hold"
          value={onHold}
          sub="Need attention"
          accent={onHold > 0 ? "overdue" : "muted"}
          onClick={() => navigate("/cases?status=on_hold")}
        />
      </div>

      {/* SR-ready (Zoho-confirmed ceding complete) */}
      <div className="mb-6 theme-card theme-card-accent border border-teal/30 bg-teal/5 overflow-hidden p-0">
        <div className="border-b border-teal/20 bg-teal/10 px-5 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest font-bold text-teal">
              Suitability Report queue
            </p>
            <h2 className="text-sm theme-heading text-foreground flex items-center gap-2 mt-0.5">
              <Sparkles className="h-4 w-4 text-teal" />
              Ready for SR · {srReady.length}
            </h2>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncZoho}
            disabled={syncing}
            className="gap-2 shrink-0"
          >
            {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sync CRM
          </Button>
        </div>
        {srReady.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-foreground font-medium">No cases ready for SR</p>
            <p className="text-xs text-muted-foreground mt-1">
              Cases appear here once ceding is confirmed complete.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-teal/10">
            {srReady.slice(0, 6).map((c: any) => (
              <li
                key={c.id}
                className="flex items-center gap-4 px-5 py-3 hover:bg-teal/5 transition-colors"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success/15 text-success shrink-0">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <button
                  onClick={() => navigate(`/cases/${c.id}`)}
                  className="flex-1 min-w-0 text-left"
                >
                  <p className="text-sm font-semibold text-foreground truncate">{c.client_name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {c.Provider_group} · {c.plan_type} ·{" "}
                    <span className="font-mono">{c.case_ref}</span>
                    {c.zoho_task_id && (
                      <>
                        {" · "}
                        <span className="font-mono">Task {c.zoho_task_id}</span>
                      </>
                    )}
                  </p>
                </button>
                <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-success">
                  <CheckCircle2 className="h-3 w-3" /> Ceding complete
                </span>
                <Button
                  size="sm"
                  className="gap-2 shrink-0"
                  onClick={() => handlePrepareSR(c)}
                  disabled={preparingId === c.id}
                >
                  {preparingId === c.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {preparingId === c.id ? "Triggering…" : "Prepare SR"}
                  {preparingId !== c.id && <ExternalLink className="h-3 w-3" />}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Client-wise view: aggregates all ceding tasks per client and shows SR readiness */}
      <div className="mb-6 theme-card theme-card-accent border border-border bg-card overflow-hidden p-0">
        <div className="border-b border-border bg-muted/30 px-5 py-3 flex items-center justify-between">
          <h2 className="text-sm theme-heading text-foreground flex items-center gap-2">
            <Users className="h-4 w-4 text-teal" />
            Cases by client · {clientGroups.length}
          </h2>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
            SR unlocks once all ceding tasks complete
          </span>
        </div>
        {clientGroups.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            No clients yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {clientGroups.map((g) => {
              const isExpanded = expandedClients.has(g.client_name);
              const pct = g.total > 0 ? Math.round((g.completed / g.total) * 100) : 0;
              return (
                <li key={g.client_name}>
                  <button
                    onClick={() => toggleClient(g.client_name)}
                    className="w-full flex items-center gap-4 px-5 py-3 hover:bg-muted/40 transition-colors text-left"
                  >
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-full shrink-0 ${
                        g.allComplete ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {g.allComplete ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <Briefcase className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {g.client_name}
                        </p>
                        <span className="text-[10px] font-semibold text-muted-foreground">
                          {g.completed} / {g.total} ceding tasks
                        </span>
                        {g.srReady && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-teal/15 text-teal">
                            <Sparkles className="h-3 w-3" /> SR ready
                          </span>
                        )}
                        {g.anySrInProgress && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-info/15 text-info">
                            SR in progress
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden max-w-md">
                        <div
                          className={`h-full transition-all ${
                            g.allComplete ? "bg-success" : "bg-teal"
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    {g.srReady && (
                      <Button
                        size="sm"
                        className="gap-2 shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          // SR is a client-level action: once every ceding task
                          // for the client is complete, any team member viewing
                          // the client can trigger SR — even if the remaining
                          // task is owned by another CA. Prefer the user's own
                          // task when available, otherwise fall back to the most
                          // recently completed task in the group.
                          const ownPending = g.myItems.filter((i: any) => !i.sr_prepared_at);
                          const pool = ownPending.length > 0 ? ownPending : g.items;
                          const target = [...pool]
                            .filter((i) => !i.sr_prepared_at)
                            .sort(
                              (a, b) =>
                                new Date(b.ceding_complete_date ?? b.updated_at).getTime() -
                                new Date(a.ceding_complete_date ?? a.updated_at).getTime(),
                            )[0];
                          if (target) handlePrepareSR(target);
                          else
                            toast.info("SR already prepared", {
                              description: "Every task for this client has already moved to SR.",
                            });
                        }}
                        disabled={preparingId !== null}
                      >
                        <Sparkles className="h-3.5 w-3.5" /> Proceed to SR
                      </Button>
                    )}
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                  </button>
                  {isExpanded && (
                    <ul className="bg-muted/20 border-t border-border divide-y divide-border">
                      {g.items.map((c: any) => {
                        const statusStyle =
                          STATUS_STYLES[c.status] ?? "bg-muted text-muted-foreground";
                        const done = ["complete", "approved"].includes(c.status);
                        const isMine =
                          role !== "ca_team" ||
                          (c.owner_name ?? "").trim() === (userName ?? "").trim();
                        return (
                          <li key={c.id}>
                            <button
                              onClick={() => {
                                if (isMine) navigate(`/cases/${c.id}`);
                                else
                                  toast.info("Owned by another CA", {
                                    description: `${c.owner_name ?? "Another team member"} is handling this task.`,
                                  });
                              }}
                              className={`w-full flex items-center gap-3 pl-16 pr-5 py-2 transition-colors text-left ${
                                isMine ? "hover:bg-muted/40" : "opacity-70 cursor-not-allowed"
                              }`}
                            >
                              {done ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                              ) : (
                                <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-foreground truncate">
                                  {c.Provider_group} · {c.plan_type}
                                  {!isMine && c.owner_name && (
                                    <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                                      · owned by {c.owner_name}
                                    </span>
                                  )}
                                </p>
                                <p className="text-[11px] text-muted-foreground font-mono truncate">
                                  {c.case_ref} · {c.plan_number}
                                </p>
                              </div>
                              <span
                                className={`hidden sm:inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold ${statusStyle}`}
                              >
                                {STATUS_LABELS[c.status] ?? c.status}
                              </span>
                              {isMine && (
                                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 theme-card theme-card-accent border border-border bg-card overflow-hidden p-0">
          <div className="border-b border-border bg-muted/30 px-5 py-3 flex items-center justify-between">
            <h2 className="text-sm theme-heading text-foreground flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-teal" /> Recent Activity
            </h2>
            <button
              onClick={() => navigate("/cases")}
              className="text-xs text-teal hover:underline flex items-center gap-1 font-semibold"
            >
              View all cases <ArrowRight className="h-3 w-3" />
            </button>
          </div>

          {isLoading ? (
            <div className="p-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : recent.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <Briefcase className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">No ceding cases yet</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">
                Create a case to start tracking ceding work.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {recent.map((c) => {
                const rag = calculateRag(c);
                const ragStyle = RAG_STYLES[rag];
                const statusStyle = STATUS_STYLES[c.status] ?? "bg-muted text-muted-foreground";
                return (
                  <button
                    key={c.id}
                    onClick={() => navigate(`/cases/${c.id}`)}
                    className="flex w-full items-center gap-4 px-5 py-3 hover:bg-muted/50 transition-colors text-left"
                  >
                    <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${ragStyle.dot}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{c.client_name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {c.Provider_group} · {c.plan_type} · {c.plan_number}
                      </p>
                    </div>
                    <span className={`hidden sm:inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold ${statusStyle}`}>
                      {STATUS_LABELS[c.status] ?? c.status}
                    </span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="theme-card theme-card-accent border border-border bg-card">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 text-teal" />
              <h3 className="text-sm theme-heading">Your role</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-2">You're signed in as <strong className="text-foreground">{userName}</strong>.</p>
            <p className="text-xs text-muted-foreground">
              {role === "ca_team" && "You can upload documents, edit checklists, and run AI extraction across all cases."}
              {role === "adviser" && "You can review approved checklists and finalise case recommendations."}
              {role === "paraplanner" && "You can review extracted data and approve or request review on each field."}
              {role === "admin" && "You have full access to the Admin Panel, Provider Directory, and templates."}
            </p>
          </div>

          <div className="theme-card theme-card-accent border border-border bg-card">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-4 w-4 text-teal" />
              <h3 className="text-sm theme-heading">Quick start</h3>
            </div>
            <div className="space-y-2">
              <button
                onClick={() => navigate("/cases")}
                className="w-full text-left text-xs px-3 py-2 rounded-md border border-border hover:bg-muted transition-colors"
              >
                + Create a new case
              </button>
              <button
                onClick={() => navigate("/providers")}
                className="w-full text-left text-xs px-3 py-2 rounded-md border border-border hover:bg-muted transition-colors"
              >
                Browse Provider Directory
              </button>
              {cases.length === 0 && (
                <button
                  onClick={() => seedMutation.mutate()}
                  className="w-full text-left text-xs px-3 py-2 rounded-md border border-border hover:bg-muted transition-colors"
                >
                  Load starter cases
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

function KPICard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  suffix,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  sub: string;
  accent: "primary" | "success" | "warning" | "overdue" | "muted";
  suffix?: string;
  onClick?: () => void;
}) {
  const iconBg =
    accent === "primary"
      ? "bg-teal/15 text-teal"
      : accent === "success"
      ? "bg-success/15 text-success"
      : accent === "warning"
      ? "bg-warning/15 text-warning"
      : accent === "overdue"
      ? "bg-overdue/15 text-overdue"
      : "bg-muted text-muted-foreground";

  return (
    <button
      type="button"
      onClick={onClick}
      className="kpi-card theme-card border border-border bg-card text-left w-full transition-all hover:shadow-md hover:border-teal/40 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal/40"
    >
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-md ${iconBg}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-foreground theme-heading leading-none">{value}{suffix}</p>
          <p className="text-xs text-muted-foreground mt-1">{label}</p>
        </div>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">{sub}</p>
    </button>
  );
}

export default Dashboard;
