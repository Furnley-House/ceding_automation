import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, ArrowRight, LayoutGrid, Inbox, Sparkles, FileText, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCases } from "@/services/api";
import type { CaseRow } from "@/lib/caseHelpers";
import { RAG_STYLES, STATUS_LABELS, calculateRag } from "@/lib/caseHelpers";

interface Props {
  caseItem: CaseRow;
}

export function CompleteWorkspace({ caseItem }: Props) {
  const navigate = useNavigate();
  const { data: allCases = [] } = useQuery({ queryKey: ["cases"], queryFn: getCases });

  // Pick the next 3 active cases that aren't this one and aren't already complete
  const nextCases = (allCases as CaseRow[])
    .filter(
      (c) =>
        c.id !== caseItem.id &&
        c.status !== "complete" &&
        c.status !== "approved" &&
        (c.current_stage ?? 1) < 11,
    )
    .sort((a, b) => {
      // Prioritise red > amber > green, then most recently active
      const ragOrder: Record<string, number> = { red: 0, amber: 1, green: 2 };
      const ar = ragOrder[calculateRag(a)] ?? 3;
      const br = ragOrder[calculateRag(b)] ?? 3;
      if (ar !== br) return ar - br;
      return new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime();
    })
    .slice(0, 3);

  const completedDate = caseItem.ceding_complete_date
    ? new Date(caseItem.ceding_complete_date).toLocaleDateString("en-GB")
    : new Date().toLocaleDateString("en-GB");

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="rounded-lg border border-success/30 bg-gradient-to-br from-success/10 via-card to-card p-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/20 text-success mb-4">
          <CheckCircle2 className="h-9 w-9" strokeWidth={2.5} />
        </div>
        <p className="text-[10px] uppercase tracking-widest text-success font-bold mb-1">
          Ceding pack complete
        </p>
        <h3 className="text-2xl font-bold theme-heading text-foreground">
          {caseItem.client_name}
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          {caseItem.Provider_group} · {caseItem.plan_type} · {caseItem.plan_number}
        </p>
        <p className="text-xs text-muted-foreground mt-3">
          Completed on <span className="font-semibold text-foreground">{completedDate}</span>
        </p>

        {/* Quick stats */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 text-success px-3 py-1 text-[11px] font-semibold">
            <CheckCircle2 className="h-3 w-3" /> All 10 stages complete
          </span>
          {caseItem.zoho_task_id && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-teal/15 text-teal px-3 py-1 text-[11px] font-semibold">
              <FileText className="h-3 w-3" /> Zoho task {caseItem.zoho_task_id}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted text-muted-foreground px-3 py-1 text-[11px] font-semibold">
            <Sparkles className="h-3 w-3" /> Handed to adviser
          </span>
        </div>
      </div>

      {/* Primary actions */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Button asChild size="lg" className="gap-2 h-auto py-4 flex-col items-start">
          <Link to="/cases">
            <span className="flex items-center gap-2 text-sm font-bold">
              <LayoutGrid className="h-4 w-4" /> Browse all cases
            </span>
            <span className="text-[11px] font-normal opacity-90">
              Pick the next case from the full pipeline
            </span>
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="gap-2 h-auto py-4 flex-col items-start">
          <Link to="/inbox">
            <span className="flex items-center gap-2 text-sm font-bold">
              <Inbox className="h-4 w-4" /> Go to my inbox
            </span>
            <span className="text-[11px] font-normal text-muted-foreground">
              See cases assigned to you
            </span>
          </Link>
        </Button>
      </div>

      {/* Suggested next cases */}
      {nextCases.length > 0 && (
        <div className="rounded-md border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
              Suggested next cases
            </h4>
            <Link to="/cases" className="text-[11px] text-teal hover:underline font-semibold">
              View all →
            </Link>
          </div>
          <ul className="divide-y divide-border">
            {nextCases.map((c) => {
              const rag = calculateRag(c);
              return (
                <li key={c.id}>
                  <button
                    onClick={() => navigate(`/cases/${c.id}`)}
                    className="w-full flex items-center gap-3 py-3 px-1 text-left hover:bg-muted/40 rounded-md transition-colors"
                  >
                    <span className={`h-2.5 w-2.5 rounded-full ${RAG_STYLES[rag].dot} shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {c.client_name}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {c.Provider_group} · {c.plan_type} ·{" "}
                        <span className="font-mono">{c.case_ref}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-[10px] text-muted-foreground hidden sm:inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Step {c.current_stage ?? 1}/10
                      </span>
                      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-muted text-muted-foreground font-semibold">
                        {STATUS_LABELS[c.status] ?? c.status}
                      </span>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
