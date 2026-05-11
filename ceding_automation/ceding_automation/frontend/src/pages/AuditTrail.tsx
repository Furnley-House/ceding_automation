import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  History,
  ShieldCheck,
  Search,
  X,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { getCases } from "@/services/api";
import { AuditTimeline } from "@/components/case/AuditTimeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STATUS_LABELS, STATUS_STYLES, type CaseRow } from "@/lib/caseHelpers";

/**
 * Audit Trail (case-scoped).
 *
 * Compliance-driven design: the audit log is always read in the context of a
 * specific case. There is no global cross-case view in the UI — users (CA,
 * paraplanner, adviser, admin) must pick a case first, then see that case's
 * full timeline. This minimises incidental access to other cases' history.
 *
 * Deep-link supported via `?case=<caseId>`. Picking / clearing a case mutates
 * the URL so the link is shareable + back-button-able.
 *
 * Cases shown in the picker are already filtered server-side by RBAC (CA team
 * only see their own; paraplanner / adviser see assigned + reviewing; admin
 * sees all). No additional client gating needed.
 */
const AuditTrail = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedCaseId = searchParams.get("case");
  const [search, setSearch] = useState("");

  const { data: cases = [], isLoading } = useQuery<CaseRow[]>({
    queryKey: ["cases"],
    queryFn: getCases,
  });

  const selectedCase = useMemo(
    () => cases.find((c) => c.id === selectedCaseId) ?? null,
    [cases, selectedCaseId],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cases.slice(0, 50);
    return cases
      .filter((c) => {
        return (
          c.client_name?.toLowerCase().includes(q) ||
          c.case_ref?.toLowerCase().includes(q) ||
          c.provider_name?.toLowerCase().includes(q) ||
          c.plan_number?.toLowerCase().includes(q)
        );
      })
      .slice(0, 50);
  }, [cases, search]);

  const pickCase = (id: string) => {
    setSearchParams({ case: id }, { replace: false });
    setSearch("");
  };

  const clearCase = () => {
    setSearchParams({}, { replace: false });
  };

  return (
    <div className="animate-slide-in space-y-6">
      <div className="flex items-start gap-3 pb-5 border-b border-border">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-teal/15 text-teal shrink-0">
          <History className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold theme-heading text-foreground">
            Audit Trail
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Pick a case to see its immutable, append-only timeline of every
            state-changing action — extractions, edits, approvals, calls,
            exports, notifications.
          </p>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-success shrink-0">
          <ShieldCheck className="h-3.5 w-3.5" />
          Immutable
        </div>
      </div>

      {selectedCase ? (
        // ── Selected case view ─────────────────────────────────
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4 flex items-start gap-3">
            <div className="h-10 w-10 rounded-md bg-teal/10 text-teal flex items-center justify-center shrink-0">
              <History className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-base font-bold text-foreground truncate">
                  {selectedCase.client_name}
                </p>
                <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground">
                  {selectedCase.case_ref}
                </span>
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                    STATUS_STYLES[selectedCase.status] ??
                    "bg-muted text-foreground"
                  }`}
                >
                  {STATUS_LABELS[selectedCase.status] ?? selectedCase.status}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {selectedCase.provider_name} · {selectedCase.plan_type} ·{" "}
                {selectedCase.plan_number}
                {selectedCase.owner_name
                  ? ` · Owner: ${selectedCase.owner_name}`
                  : ""}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={clearCase}
              className="gap-1 shrink-0"
            >
              <X className="h-3.5 w-3.5" /> Pick another case
            </Button>
          </div>

          {/* Per-case timeline — already supports filters, search, CSV export */}
          <AuditTimeline caseId={selectedCase.id} showCase={false} />
        </div>
      ) : (
        // ── Case picker ────────────────────────────────────────
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="relative max-w-2xl">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by client, case ref, provider or policy reference…"
                className="h-10 pl-10"
                autoFocus
              />
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              {isLoading
                ? "Loading cases…"
                : `${cases.length} case${cases.length === 1 ? "" : "s"} accessible to you. Showing the first ${filtered.length}.`}
            </p>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-10 text-center">
              <History className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
              <p className="text-sm font-semibold text-foreground">
                No cases match
              </p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                {search
                  ? "Adjust the search above. The audit page only shows cases you have access to."
                  : "You don't have any accessible cases. Audit trails are only visible per case."}
              </p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => pickCase(c.id)}
                    className="w-full flex items-center gap-3 rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-teal/40 hover:bg-muted/30"
                  >
                    <div className="h-9 w-9 rounded-md bg-teal/10 text-teal flex items-center justify-center shrink-0">
                      <History className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-foreground truncate">
                          {c.client_name}
                        </p>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {c.case_ref}
                        </span>
                        <span
                          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                            STATUS_STYLES[c.status] ??
                            "bg-muted text-foreground"
                          }`}
                        >
                          {STATUS_LABELS[c.status] ?? c.status}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                        {c.provider_name} · {c.plan_type} · {c.plan_number}
                        {c.owner_name ? ` · ${c.owner_name}` : ""}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default AuditTrail;
