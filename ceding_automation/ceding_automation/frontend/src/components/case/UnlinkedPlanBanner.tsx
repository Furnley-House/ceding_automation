// D4 — Unlinked Plans banner + Link/Create dialogs.
//
// Surfaces on Stage 1 (Case Details) and again on Stage 9 receipt panel
// when the case has no zohoCaseId. Two recovery paths:
//   • Link existing — Policy_Ref search against the live Plans module,
//     pick a candidate, backend caches it on the case + PATCHes Zoho
//     Task.What_Id.
//   • Create new in Zoho — backend POSTs a Plans record with Policy_Ref +
//     Plan_Type + Provider, PATCHes the Task.What_Id, AND creates the
//     Plans_X_Clients junction row(s) so the Plan appears under the client
//     in CRM. The dialog shows the client name so the operator can confirm
//     who the new Plan will be linked to.
//
// Both flows trigger a refetch of the case query on success so the header
// LinkedPlanField flips to ✓ Linked without a page reload.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Search, Plus, Loader2, X, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { casesApi } from "@/lib/api";
import { Button } from "@/components/ui/button";

interface PlanHit {
  id: string;
  name: string | null;
  policyRef: string | null;
  planType: string | null;
}

interface Props {
  caseId: string;
  policyRef: string | null;
  planType: string;
  provider: string | null;
  /** Client name shown in the Create-new dialog so the operator can see who
   *  the new Plans record will be linked to. The Plans→Contact link itself
   *  is established server-side via the Plans_X_Clients junction module
   *  (using cached zohoClientOwnerIds / clientZohoId on the case). */
  clientName: string | null;
  /** Optional compact mode for the Stage 9 receipt slot. */
  compact?: boolean;
}

export function UnlinkedPlanBanner({
  caseId,
  policyRef,
  planType,
  provider,
  clientName,
  compact = false,
}: Props) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <div
        className={`rounded-md border border-warning/40 bg-warning/5 ${
          compact ? "p-3" : "p-4"
        }`}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className={`font-semibold text-foreground ${compact ? "text-xs" : "text-sm"}`}>
              No Plans record linked to this case
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              The case carries Policy Ref{" "}
              <span className="font-mono text-foreground">{policyRef ?? "—"}</span>, but the Zoho
              Plans module has no unique record matching it. Stage 9 export will fail until this is resolved.
            </p>
            <div className="flex gap-2 mt-3 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setLinkOpen(true)}
                className="gap-1.5"
              >
                <Search className="h-3.5 w-3.5" /> Link existing
              </Button>
              <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" /> Create new in Zoho
              </Button>
            </div>
          </div>
        </div>
      </div>

      {linkOpen && (
        <LinkExistingPlanDialog
          caseId={caseId}
          initialQuery={policyRef ?? ""}
          onClose={() => setLinkOpen(false)}
        />
      )}
      {createOpen && (
        <CreatePlanDialog
          caseId={caseId}
          policyRef={policyRef}
          planType={planType}
          provider={provider}
          clientName={clientName}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </>
  );
}

// ── Link existing dialog ─────────────────────────────────────
export function LinkExistingPlanDialog({
  caseId,
  initialQuery,
  onClose,
}: {
  caseId: string;
  initialQuery: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<PlanHit[]>([]);
  const [searched, setSearched] = useState(false);

  const searchMutation = useMutation({
    mutationFn: async (q: string) => {
      const res = await casesApi.searchPlans(q);
      return (res.data as { hits: PlanHit[] }).hits ?? [];
    },
    onSuccess: (rows) => {
      setHits(rows);
      setSearched(true);
    },
    onError: (e: Error) => toast.error("Search failed", { description: e.message }),
  });

  const linkMutation = useMutation({
    mutationFn: (planRecordId: string) => casesApi.linkPlan(caseId, planRecordId),
    onSuccess: (res) => {
      const data = res.data as { planName: string | null; planRecordId: string; taskLinkNote: string | null };
      toast.success("Plans record linked", {
        description: `${data.planName ?? data.planRecordId}${
          data.taskLinkNote ? ` · ${data.taskLinkNote}` : ""
        }`,
      });
      qc.invalidateQueries({ queryKey: ["case", caseId] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      onClose();
    },
    onError: (e: Error) => toast.error("Link failed", { description: e.message }),
  });

  return (
    <DialogShell onClose={onClose} title="Link existing Plans record">
      <p className="text-xs text-muted-foreground mb-3">
        Search the Zoho Plans module by Policy Ref. Showing up to 10 matches that{" "}
        <span className="font-semibold">start with</span> your search term.
      </p>
      <div className="flex gap-2 mb-3">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) searchMutation.mutate(query);
          }}
          placeholder="Policy Ref…"
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal/40"
        />
        <Button
          size="sm"
          onClick={() => searchMutation.mutate(query)}
          disabled={!query.trim() || searchMutation.isPending}
          className="gap-1.5"
        >
          {searchMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          Search
        </Button>
      </div>

      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {!searched && (
          <p className="p-4 text-xs text-muted-foreground text-center">
            Enter a Policy Ref and click Search.
          </p>
        )}
        {searched && hits.length === 0 && !searchMutation.isPending && (
          <p className="p-4 text-xs text-muted-foreground text-center">
            No Plans records matched. Try a shorter prefix, or use{" "}
            <span className="font-semibold">Create new in Zoho</span>.
          </p>
        )}
        {hits.length > 0 && (
          <ul className="divide-y divide-border">
            {hits.map((h) => (
              <li key={h.id} className="flex items-center justify-between p-2.5 hover:bg-muted/40">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{h.name ?? h.id}</p>
                  <p className="text-[11px] text-muted-foreground font-mono">
                    {h.policyRef ?? "—"}
                    {h.planType ? ` · ${h.planType}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => linkMutation.mutate(h.id)}
                  disabled={linkMutation.isPending}
                >
                  {linkMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Link"
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogShell>
  );
}

// ── Create new dialog ────────────────────────────────────────
export function CreatePlanDialog({
  caseId,
  policyRef,
  planType,
  provider,
  clientName,
  onClose,
}: {
  caseId: string;
  policyRef: string | null;
  planType: string;
  provider: string | null;
  clientName: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const createMutation = useMutation({
    mutationFn: () => casesApi.createPlan(caseId),
    onSuccess: (res) => {
      const data = res.data as {
        planName: string | null;
        planRecordId: string;
        taskLinkNote: string | null;
        plansXClientsNote?: string | null;
        plansXClientsCreated?: number;
        plansXClientsErrors?: string[];
      };
      const desc =
        `${data.planName ?? data.planRecordId} created` +
        (data.taskLinkNote ? ` · ${data.taskLinkNote}` : "") +
        (data.plansXClientsNote ? ` · ${data.plansXClientsNote}` : "");
      const hasJunctionErrors = (data.plansXClientsErrors?.length ?? 0) > 0;
      if (hasJunctionErrors) {
        toast.warning("Plans created — some client links failed", { description: desc });
      } else {
        toast.success("Plans record created", { description: desc });
      }
      qc.invalidateQueries({ queryKey: ["case", caseId] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      onClose();
    },
    onError: (e: Error) => toast.error("Create failed", { description: e.message }),
  });

  const blocked = !policyRef;

  return (
    <DialogShell onClose={onClose} title="Create new Plans record in Zoho">
      <p className="text-xs text-muted-foreground mb-3">
        The following values will be sent to the Zoho Plans module to create a fresh record. The
        Zoho Task will be linked automatically via <span className="font-mono">What_Id</span>,
        and the new Plan will be linked to the client via the Plans_X_Clients junction module.
      </p>
      <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-xs mb-3 rounded-md border border-border p-3 bg-muted/30">
        <dt className="text-muted-foreground">Policy Ref</dt>
        <dd className="text-foreground font-mono">{policyRef ?? "— (missing — fix on the case first)"}</dd>
        <dt className="text-muted-foreground">Plan Type</dt>
        <dd className="text-foreground">{planType}</dd>
        <dt className="text-muted-foreground">Provider</dt>
        <dd className="text-foreground">{provider ?? "—"}</dd>
        <dt className="text-muted-foreground">Client</dt>
        <dd className="text-foreground">{clientName ?? "—"}</dd>
      </dl>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => createMutation.mutate()}
          disabled={blocked || createMutation.isPending}
          className="gap-1.5"
        >
          {createMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          Create in Zoho
        </Button>
      </div>
    </DialogShell>
  );
}

// Minimal modal shell — avoids pulling in shadcn Dialog for one-off use.
function DialogShell({
  children,
  title,
  onClose,
}: {
  children: React.ReactNode;
  title: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-foreground">{title}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
