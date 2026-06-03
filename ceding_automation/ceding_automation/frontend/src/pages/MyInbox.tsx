import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Inbox, ChevronRight, Calendar, AlertCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useRole } from "@/hooks/useRole";
import { PARAPLANNERS } from "@/lib/paraplanners";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { calculateRag, RAG_STYLES, STATUS_LABELS, STATUS_STYLES, type CaseRow } from "@/lib/caseHelpers";

const MyInbox = () => {
  const { userName } = useRole();
  // Match logged-in paraplanner by name.
  const me = useMemo(
    () => PARAPLANNERS.find((p) => p.full_name === userName) ?? PARAPLANNERS[0],
    [userName],
  );

  const { data: cases = [], isLoading } = useQuery({
    queryKey: ["my-inbox", userName],
    queryFn: async () => {
      const res = await api.get("/cases");
      // Backend returns { cases, total, page, limit }
      const raw = res.data as { cases?: CaseRow[] };
      const all = (raw.cases ?? (Array.isArray(res.data) ? (res.data as CaseRow[]) : [])) ?? [];
      // Show cases where the signed-in paraplanner is the assigned reviewer.
      // The backend /cases endpoint already filters to cases involving the
      // authenticated user (createdBy / assignedTo / paralPlanner) for
      // non-admin roles, so a name match is enough to narrow to "mine".
      return all
        .filter((c) => (c.paraplanner_name ?? "").trim() === (userName ?? "").trim())
        .sort((a, b) =>
          new Date(b.last_activity_at ?? b.created_at ?? 0).getTime() -
          new Date(a.last_activity_at ?? a.created_at ?? 0).getTime()
        );
    },
    enabled: !!userName,
  });

  // Tasks not implemented in backend — return empty so due-date logic is a no-op
  const tasks: { case_id: string; due_date: string; completed: boolean }[] = [];

  const dueByCase = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) {
      if (t.case_id && t.due_date && !t.completed) {
        const existing = m.get(t.case_id);
        if (!existing || t.due_date < existing) m.set(t.case_id, t.due_date);
      }
    }
    return m;
  }, [tasks]);

  const enriched = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return cases
      .map((c) => {
        const due = dueByCase.get(c.id);
        const dueDate = due ? new Date(due) : null;
        const overdue = dueDate ? dueDate < today : false;
        const daysUntil = dueDate
          ? Math.ceil((dueDate.getTime() - today.getTime()) / 86400000)
          : null;
        return { c, rag: calculateRag(c), due, overdue, daysUntil };
      })
      .sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        if (a.due && b.due) return a.due.localeCompare(b.due);
        if (a.due) return -1;
        if (b.due) return 1;
        return 0;
      });
  }, [cases, dueByCase]);

  const overdueCount = enriched.filter((e) => e.overdue).length;
  const dueSoonCount = enriched.filter((e) => !e.overdue && e.daysUntil !== null && e.daysUntil <= 2).length;

  return (
    <div className="animate-slide-in space-y-6">
      <div className="flex items-start gap-3 pb-5 border-b border-border">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-teal/15 text-teal shrink-0">
          <Inbox className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold theme-heading text-foreground">My Inbox</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Cases assigned to <strong className="text-foreground">{me.full_name}</strong> · sorted by due date.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Open cases" value={enriched.length} tone="info" />
        <Stat label="Due in ≤2 days" value={dueSoonCount} tone="warning" />
        <Stat label="Overdue" value={overdueCount} tone="overdue" />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : enriched.length === 0 ? (
        <Card className="p-10 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground">Inbox zero</p>
          <p className="text-xs text-muted-foreground mt-1">
            No cases are currently assigned to you. New assignments will appear here and ping the bell.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {enriched.map(({ c, rag, due, overdue, daysUntil }) => {
            const ragStyle = RAG_STYLES[rag];
            return (
              <Card key={c.id} className="p-4 hover:border-teal/40 transition-colors">
                <div className="flex items-center gap-4">
                  <div className={`flex flex-col items-center justify-center h-12 w-12 rounded-md ${ragStyle.bg} shrink-0`}>
                    <div className={`h-2 w-2 rounded-full ${ragStyle.dot} mb-0.5`} />
                    <span className={`text-[9px] font-bold uppercase ${ragStyle.text}`}>{ragStyle.label}</span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-foreground truncate">{c.client_name}</p>
                      <span className="text-[10px] font-mono text-muted-foreground">{c.case_ref}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${STATUS_STYLES[c.status] ?? "bg-muted text-foreground"}`}>
                        {STATUS_LABELS[c.status] ?? c.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {c.Provider_group} · {c.Plan_Number}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {due ? (
                      <div className={`flex items-center gap-1 text-xs font-semibold ${overdue ? "text-overdue" : daysUntil !== null && daysUntil <= 2 ? "text-warning" : "text-muted-foreground"}`}>
                        {overdue ? <AlertCircle className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
                        {overdue
                          ? `Overdue ${Math.abs(daysUntil ?? 0)}d`
                          : daysUntil === 0
                          ? "Due today"
                          : `Due in ${daysUntil}d`}
                      </div>
                    ) : (
                      <span className="text-[10px] text-muted-foreground italic">No due date</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {due ? new Date(due).toLocaleDateString("en-GB") : ""}
                    </span>
                  </div>

                  <Button asChild size="sm" className="gap-1 shrink-0">
                    <Link to={`/cases/${c.id}`} state={{ goToStage: 8 }}>
                      Start review <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

function Stat({ label, value, tone }: { label: string; value: number; tone: "info" | "warning" | "overdue" }) {
  const styles = {
    info: "bg-info/10 text-info border-info/30",
    warning: "bg-warning/10 text-warning border-warning/30",
    overdue: "bg-overdue/10 text-overdue border-overdue/30",
  }[tone];
  return (
    <Card className={`p-4 border ${styles}`}>
      <p className="text-[10px] uppercase tracking-wider font-semibold opacity-80">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </Card>
  );
}

export default MyInbox;
