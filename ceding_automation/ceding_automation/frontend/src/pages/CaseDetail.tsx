import { useParams, useNavigate, Link, useLocation, useOutletContext } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Loader2, ChevronRight, ChevronLeft, ChevronDown, ChevronUp, AlertTriangle, ExternalLink, RefreshCw, Search, Plus } from "lucide-react";
import type { AppLayoutContext } from "@/components/layout/AppLayout";
import { getCaseById, updateCase, importCrmTaskAsCase, syncCaseFromZoho } from "@/services/api";
import { CEDING_STAGES, STATUS_LABELS, STATUS_STYLES, RAG_STYLES, calculateRag } from "@/lib/caseHelpers";
import { isSupportedPlanType, SUPPORTED_PLAN_TYPES } from "@/lib/checklistTemplates";
import { useRole } from "@/hooks/useRole";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  StageCaseDetails,
  StageSendLOA,
  StageDocumentUpload,
  StageAIExtraction,
  StageCallAssist,
  StageReviewChecklist,
  StageAuditTrail,
  StageApproval,
  StageExport,
  StageComplete,
} from "@/components/case/stages";
import { LinkExistingPlanDialog, CreatePlanDialog } from "@/components/case/UnlinkedPlanBanner";

const CaseDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { isCA, role, userName } = useRole();
  // Sidebar auto-collapse hook lives at the layout level — we only consume
  // it from Stage 4 (PDF↔extraction comparison wants every pixel it can get).
  const layoutCtx = useOutletContext<AppLayoutContext | undefined>();

  const { data: caseItem, isLoading } = useQuery({
    queryKey: ["case", id],
    queryFn: () => getCaseById(id!),
    enabled: !!id,
  });

  const syncFromZoho = async () => {
    const zohoTaskId = (caseItem as any)?.zoho_task_id;
    if (!zohoTaskId) return;
    const t = toast.loading("Syncing from Zoho…");
    try {
      await importCrmTaskAsCase(zohoTaskId);
      await qc.invalidateQueries({ queryKey: ["case", id] });
      await qc.invalidateQueries({ queryKey: ["cases"] });
      toast.success("Case synced from Zoho", { id: t });
    } catch (e) {
      toast.error("Sync failed", { id: t, description: e instanceof Error ? e.message : "Unknown error" });
    }
  };

  const updateMutation = useMutation({
    mutationFn: ({ updates }: { updates: any }) => updateCase(id!, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case", id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Pull latest basic details from Zoho whenever the case page is opened.
  // The case detail page has no edit UI for client/provider/policy ref —
  // those fields are owned by Zoho CRM, so we re-sync each time the user
  // navigates here. Sync is fire-and-forget: errors are silent so the
  // page still renders if Zoho is unreachable.
  const syncedRef = useRef<string | null>(null);
  const zohoTaskId = (caseItem as any)?.zoho_task_id as string | undefined;
  const syncMutation = useMutation({
    mutationFn: () => syncCaseFromZoho(id!),
    onSuccess: (result) => {
      if (!result.changed) return;
      qc.invalidateQueries({ queryKey: ["case", id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      const fields = result.changes.map((c) => c.field).join(", ");
      toast.success(
        `Updated from Zoho: ${result.changes.length} change${result.changes.length === 1 ? "" : "s"}`,
        { description: fields },
      );
    },
    // Stay quiet on errors — we don't want a Zoho hiccup to spam the user.
    onError: (e: Error) => {
      // eslint-disable-next-line no-console
      console.warn("Zoho sync failed:", e.message);
    },
  });

  useEffect(() => {
    if (!id || !zohoTaskId) return;
    if (syncedRef.current === id) return;
    syncedRef.current = id;
    syncMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, zohoTaskId]);

  // Handle stage navigation from sidebar sub-nav / MyInbox / inline links.
  // We park the requested target in a ref and clear the location state;
  // the viewStage effect below picks it up on the next render.
  const pendingGoToStage = useRef<number | null>(null);
  useEffect(() => {
    const target = (location.state as any)?.goToStage;
    if (target && typeof target === "number") {
      pendingGoToStage.current = target;
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // Local view-state for which stage to render. Stepper clicks update only
  // this — they don't PATCH `current_stage` to the backend, which would
  // otherwise clobber status (e.g. IN_REVIEW → STAGE_5_CHASING when a CA
  // hops to Call Assist to chase a returned field). The local override
  // re-syncs whenever the backend status changes, but a pending
  // location.state.goToStage always wins (deep-link / sidebar nav intent).
  //
  // Declared above the early returns so the hook order stays stable across
  // loading / loaded / not-found render passes.
  const rawStage: number = (caseItem as any)?.current_stage ?? 1;
  let computedStage: number = Math.min(10, Math.max(1, rawStage));
  if (caseItem?.status === "in_review") {
    if (role === "ca_team") computedStage = 6;
    else if (role === "paraplanner" || role === "adviser") computedStage = 8;
  }
  const [viewStage, setViewStage] = useState<number>(computedStage);
  useEffect(() => {
    if (pendingGoToStage.current !== null) {
      setViewStage(pendingGoToStage.current);
      pendingGoToStage.current = null;
    } else {
      setViewStage(computedStage);
    }
  }, [computedStage]);

  // Stage-specific layout tweaks.
  // - Stage 4 is the PDF↔checklist comparison surface. The case header
  //   eats vertical space and the global sidebar eats horizontal space —
  //   both get collapsed on entry. We restore the pre-Stage-4 sidebar
  //   state on exit so the layout doesn't feel jumpy for stages 1/2/3.
  // - The case-header accordion is local to this page; default closed
  //   when arriving on Stage 4, openable on demand.
  const [headerCollapsed, setHeaderCollapsed] = useState<boolean>(false);
  // Stage-3-only Link/Create-Plan controls in the header. Available whether or
  // not a plan is already linked, so the CA can re-link to the correct Plans
  // record once the provider document reveals the real policy number.
  const [linkPlanOpen, setLinkPlanOpen] = useState(false);
  const [createPlanOpen, setCreatePlanOpen] = useState(false);
  const sidebarPriorStateRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (viewStage === 4) {
      setHeaderCollapsed(true);
      if (layoutCtx && sidebarPriorStateRef.current === null) {
        sidebarPriorStateRef.current = layoutCtx.sidebarCollapsed;
        layoutCtx.setSidebarCollapsed(true);
      }
    } else {
      setHeaderCollapsed(false);
      if (layoutCtx && sidebarPriorStateRef.current !== null) {
        layoutCtx.setSidebarCollapsed(sidebarPriorStateRef.current);
        sidebarPriorStateRef.current = null;
      }
    }
    // layoutCtx is stable between renders but its setter ref changes on
    // every render — depending on viewStage only keeps the effect tight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewStage]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!caseItem) {
    return (
      <div className="p-8 text-center">
        <p className="text-muted-foreground mb-4">Case not found.</p>
        <Link to="/cases" className="text-teal hover:underline text-sm">
          ← Back to cases
        </Link>
      </div>
    );
  }

  // CA team can only open tasks assigned to them in Zoho CRM.
  if (
    role === "ca_team" &&
    (caseItem.owner_name ?? "").trim() !== (userName ?? "").trim()
  ) {
    return (
      <div className="p-8 text-center max-w-md mx-auto">
        <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-warning" />
        <p className="text-foreground font-semibold mb-1">Not assigned to you</p>
        <p className="text-sm text-muted-foreground mb-4">
          This task is owned by{" "}
          <strong>{caseItem.owner_name ?? "another CA"}</strong> in Zoho CRM.
          Only the assigned CA can open it.
        </p>
        <Link to="/cases" className="text-teal hover:underline text-sm">
          ← Back to my cases
        </Link>
      </div>
    );
  }

  // viewStage / computedStage are declared above the early returns to keep
  // the hook order stable. After this point caseItem is guaranteed loaded.
  const currentStage = viewStage;

  const stagesCompleted: number[] = ((caseItem as any).stages_completed ?? []).filter(
    (n: number) => n >= 1 && n <= 10,
  );
  const rag = calculateRag(caseItem as any);
  const planSupported = isSupportedPlanType(caseItem.plan_type);
  // A Plans record is linked once zoho_case_id is cached on the case. Used to
  // (a) highlight the Stage-3 header Link/Create buttons as a required action
  // and (b) block advancing Stage 3 → Stage 4 until a plan is linked.
  const planLinked = !!(caseItem as any).zoho_case_id;

  const goToStage = (n: number) => {
    if (n < 1 || n > 10) return;
    if (!planSupported && n > 1) {
      toast.error("Plan type out of scope", {
        description: `${caseItem.plan_type} is not currently supported. Only ${SUPPORTED_PLAN_TYPES.join(", ")} can be processed.`,
      });
      return;
    }
    // Sequential gating: cannot jump ahead past the next unfinished step.
    const maxAllowed = Math.min(10, (stagesCompleted.length > 0 ? Math.max(...stagesCompleted) : 0) + 1);
    const reachable = Math.max(currentStage, maxAllowed);
    if (n > reachable) {
      toast.error("Complete the previous step first", {
        description: `You must finish step ${reachable} before moving to step ${n}.`,
      });
      return;
    }
    setViewStage(n);
  };

  const completeAndNext = () => {
    const newCompleted = Array.from(new Set([...stagesCompleted, currentStage])).sort((a, b) => a - b);
    const next = Math.min(currentStage + 1, 10);
    // Advance the view stage locally first — the backend may legitimately
    // refuse the implicit status change (e.g. case is already IN_REVIEW or
    // COMPLETE) and we don't want the UI to freeze on the current stage.
    setViewStage(next);
    const updates: any = {
      current_stage: next,
      stages_completed: newCompleted,
      last_activity_at: new Date().toISOString(),
    };
    // Stamp completion when crossing into the final stage
    if (currentStage === 9 && next === 10) {
      updates.status = "complete";
      updates.ceding_complete_date = new Date().toISOString().slice(0, 10);
      // Mirror to the Zoho ceding status so the dashboard SR-ready panel picks it up.
      // In production this happens via a Zoho CRM webhook; here we mark it locally.
      (updates as any).zoho_ceding_status = "ceding_complete";
      (updates as any).zoho_synced_at = new Date().toISOString();
    }
    updateMutation.mutate({ updates });
    toast.success(`Stage ${currentStage} complete`, {
      description: next === 10 ? "Ceding complete!" : `Moved to step ${next}.`,
    });
  };

  const StageComponent = [
    StageCaseDetails,
    StageSendLOA,
    StageDocumentUpload,
    StageAIExtraction,
    StageCallAssist,
    StageReviewChecklist,
    StageAuditTrail,
    StageApproval,
    StageExport,
    StageComplete,
  ][currentStage - 1];

  return (
    <div className="animate-slide-in">
      <Link to="/cases" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to cases
      </Link>

      {/* Sticky: header + horizontal stepper */}
      <div className="sticky top-16 z-20 -mx-6 px-6 pt-1 pb-3 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border mb-6">
        {/* Header — consolidated case details */}
        <div className="rounded-lg border border-border bg-card p-4 mb-3">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <span className={`inline-block h-3 w-3 rounded-full ${RAG_STYLES[rag].dot}`} />
                <h1 className="text-xl font-bold theme-heading text-foreground truncate">{caseItem.client_name}</h1>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold ${STATUS_STYLES[caseItem.status] ?? ""}`}>
                  {STATUS_LABELS[caseItem.status] ?? caseItem.status}
                </span>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                  {caseItem.case_ref}
                </span>
                <div className="ml-auto flex items-center gap-3">
                  {/* Link / Create Plan — Stage 3 (Document Upload) only.
                      Shown whether or not a plan is already linked so the CA
                      can re-link once the provider doc confirms the real
                      policy number. Overwrites case.zohoCaseId server-side. */}
                  {currentStage === 3 && (
                    <div className="flex items-center gap-1.5">
                      {/* When no plan is linked yet, render filled amber so the
                          CA reads this as a required action (matches the ⚠ Not
                          linked status line). Relaxes to outline once linked. */}
                      <Button
                        size="sm"
                        variant={planLinked ? "outline" : "default"}
                        className={`h-7 gap-1 text-xs ${
                          planLinked
                            ? ""
                            : "bg-warning text-warning-foreground hover:bg-warning/90 border-transparent"
                        }`}
                        onClick={() => setLinkPlanOpen(true)}
                        title="Find an existing Plans record by Policy Ref"
                      >
                        <Search className="h-3 w-3" /> Link existing
                      </Button>
                      <Button
                        size="sm"
                        variant={planLinked ? "outline" : "default"}
                        className={`h-7 gap-1 text-xs ${
                          planLinked
                            ? ""
                            : "bg-warning text-warning-foreground hover:bg-warning/90 border-transparent"
                        }`}
                        onClick={() => setCreatePlanOpen(true)}
                        title="Create a new Plans record in Zoho if none exists"
                      >
                        <Plus className="h-3 w-3" /> Create new
                      </Button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      syncedRef.current = null; // force the sync to run again
                      syncMutation.mutate();
                    }}
                    disabled={syncMutation.isPending || !zohoTaskId}
                    title="Pull the latest task + linked Contact (paraplanner, owner, …) from Zoho CRM"
                    className="inline-flex items-center gap-1 text-xs text-teal hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw className={`h-3 w-3 ${syncMutation.isPending ? "animate-spin" : ""}`} />
                    {syncMutation.isPending ? "Refreshing…" : "Refresh from Zoho"}
                  </button>
                  {(caseItem as any).zoho_deep_link && (
                    <a
                      href={(caseItem as any).zoho_deep_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-teal hover:underline"
                    >
                      View in Zoho <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {/* Accordion toggle — hides the detailed field grid below.
                      Auto-collapses on Stage 4 (Extract & Fill Gaps) so the
                      PDF↔extraction comparison gets the full viewport.
                      Always available so testers on any stage can reclaim
                      vertical space if they want. */}
                  <button
                    type="button"
                    onClick={() => setHeaderCollapsed((v) => !v)}
                    title={headerCollapsed ? "Show case details" : "Hide case details"}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {headerCollapsed ? (
                      <>
                        <ChevronDown className="h-3.5 w-3.5" /> Show details
                      </>
                    ) : (
                      <>
                        <ChevronUp className="h-3.5 w-3.5" /> Hide details
                      </>
                    )}
                  </button>
                </div>
              </div>
              {!headerCollapsed && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1.5 text-xs mt-2">
                  <HeaderField label="Provider" value={caseItem.Provider_group} />
                  <HeaderField label="Plan type" value={caseItem.plan_type} />
                  <HeaderField label="Policy ref" value={caseItem.plan_number} mono />
                  <HeaderField label="Task owner" value={caseItem.owner_name ?? "—"} />
                  <HeaderField
                    label="Paraplanner"
                    value={(caseItem as any).paraplanner_name ?? "—"}
                  />
                  <HeaderField label="Zoho task" value={(caseItem as any).zoho_task_id ?? "—"} mono />
                  <HeaderField
                    label="Created"
                    value={new Date(caseItem.created_at).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  />
                  <HeaderField label="Stage" value={`${currentStage} of 10`} />
                  <HeaderField label="RAG" value={RAG_STYLES[rag].label} />
                  <LinkedPlanField
                    zohoCaseId={(caseItem as any).zoho_case_id ?? null}
                    planName={(caseItem as any).zoho_plan_name ?? null}
                    policyRef={(caseItem.plan_number as string | null | undefined) ?? null}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Horizontal stepper */}
        <div className="rounded-lg border border-border bg-card p-3 overflow-x-auto">
          <div className="flex items-start gap-1 min-w-[820px]">
            {CEDING_STAGES.map((s, i) => {
              const isDone = stagesCompleted.includes(s.num);
              const isCurrent = currentStage === s.num;
              const maxReachable = Math.max(
                currentStage,
                Math.min(10, (stagesCompleted.length > 0 ? Math.max(...stagesCompleted) : 0) + 1),
              );
              const isLocked = s.num > maxReachable;
              return (
                <button
                  key={s.num}
                  onClick={() => goToStage(s.num)}
                  disabled={isLocked}
                  className={`flex-1 group text-center px-2 py-1.5 rounded-md transition-colors ${
                    isCurrent ? "bg-teal/10" : "hover:bg-muted/50"
                  } ${isLocked ? "opacity-50 cursor-not-allowed hover:bg-transparent" : ""}`}
                  title={isLocked ? "Complete previous steps first" : s.label}
                >
                  <div className="flex items-center gap-1">
                    <div
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold shrink-0 ${
                        isDone
                          ? "bg-success text-success-foreground"
                          : isCurrent
                          ? "bg-teal text-teal-foreground ring-2 ring-teal/30"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {isDone ? <CheckCircle2 className="h-3.5 w-3.5" /> : s.num}
                    </div>
                    {i < CEDING_STAGES.length - 1 && (
                      <div className={`flex-1 h-0.5 ${isDone ? "bg-success" : "bg-border"}`} />
                    )}
                  </div>
                  <p
                    className={`mt-1.5 text-[10px] font-semibold leading-tight ${
                      isCurrent ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {s.label}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div>
        {/* Stage content */}
        <main className="space-y-4">
          {!planSupported && (
            <div className="rounded-lg border-2 border-overdue bg-overdue/10 p-4 flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-overdue shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-sm font-bold text-overdue theme-heading">
                  Plan type out of scope — case flagged
                </h3>
                <p className="text-xs text-foreground mt-1">
                  This case has plan type <strong>{caseItem.plan_type}</strong>, which is not currently
                  supported. Only <strong>{SUPPORTED_PLAN_TYPES.join(", ")}</strong> can be processed
                  end-to-end. Please reassign or close this case — progression beyond Stage 1 is blocked.
                </p>
              </div>
            </div>
          )}
          {(caseItem as any).zoho_task_id &&
            (!caseItem.Provider_group || !(caseItem as any).plan_number) && (
              <Button size="sm" variant="outline" onClick={syncFromZoho} className="text-xs">
                Sync provider &amp; policy ref from Zoho
              </Button>
            )}

          {planSupported && <StageComponent caseItem={caseItem as any} />}

          {/* Stage 3 gate — a Plans record must be linked before advancing to
              Stage 4. The helper sits directly above the complete button. */}
          {isCA && currentStage === 3 && !planLinked && (
            <p className="text-xs text-muted-foreground text-right pt-4">
              Link a Plans record before continuing — use Link existing or + Create new in the case header above.
            </p>
          )}

          {/* Stage navigation */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <Button
              variant="outline"
              onClick={() => goToStage(currentStage - 1)}
              disabled={currentStage <= 1}
              className="gap-2"
            >
              <ChevronLeft className="h-4 w-4" /> Previous step
            </Button>
            <p className="text-xs text-muted-foreground">
              Step {currentStage} of 10 · {CEDING_STAGES[currentStage - 1]?.label ?? ""}
            </p>
            {isCA && currentStage < 10 ? (
              <Button
                onClick={completeAndNext}
                className="gap-2"
                disabled={!planSupported || (currentStage === 3 && !planLinked)}
                title={
                  currentStage === 3 && !planLinked
                    ? "Link a Plans record before continuing — use Link existing or + Create new in the case header above."
                    : undefined
                }
              >
                {currentStage === 9 ? "Mark ceding complete" : "Mark complete & continue"}
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : currentStage < 10 ? (
              <Button
                variant="outline"
                onClick={() => goToStage(currentStage + 1)}
                disabled={currentStage >= 10 || !planSupported}
                className="gap-2"
              >
                Next step <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <div />
            )}
          </div>
        </main>
      </div>

      {linkPlanOpen && (
        <LinkExistingPlanDialog
          caseId={id!}
          initialQuery={(caseItem.plan_number as string | null | undefined) ?? ""}
          onClose={() => setLinkPlanOpen(false)}
        />
      )}
      {createPlanOpen && (
        <CreatePlanDialog
          caseId={id!}
          policyRef={(caseItem.plan_number as string | null | undefined) ?? null}
          planType={caseItem.plan_type}
          provider={caseItem.Provider_group ?? null}
          clientName={caseItem.client_name ?? null}
          onClose={() => setCreatePlanOpen(false)}
        />
      )}
    </div>
  );
};

function HeaderField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
      <span className={`text-foreground truncate ${mono ? "font-mono text-[11px]" : "text-xs"}`}>{value}</span>
    </div>
  );
}

// Linked Plan indicator (D3) — surfaces whether the case is wired to a Zoho
// Plans record without making the tester open Zoho. Two states today:
//   ✓ Linked    — zoho_case_id is populated (either from Zoho Task.What_Id
//                 at import, or from the Policy_Ref Plans search that runs
//                 on every Refresh-from-Zoho sync).
//   ⚠ Not linked — no id even after the policy-ref fallback search; the
//                 CRM either has no matching Plans record, or has more
//                 than one (the search requires a single unique hit).
// "✗ No match found" as a third state needs the sync to surface that
// distinction; for now the warning text below explains both possibilities.
function LinkedPlanField({
  zohoCaseId,
  planName,
  policyRef,
}: {
  zohoCaseId: string | null;
  planName: string | null;
  policyRef: string | null;
}) {
  const linked = !!zohoCaseId;
  const label = linked ? "✓ Linked" : "⚠ Not linked";
  // Preferred display: "Plan119575 (CT98621568A)" when both are known;
  // gracefully fall back to whichever piece is available.
  let valueText: string;
  if (!linked) {
    valueText = "No unique Plans record";
  } else if (planName && policyRef) {
    valueText = `${planName} (${policyRef})`;
  } else if (planName) {
    valueText = planName;
  } else {
    valueText = policyRef ?? "—";
  }
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        Linked plan
      </span>
      <span className={`text-xs truncate ${linked ? "text-success" : "text-warning"}`}>
        <span className="font-semibold">{label}</span>
        <span className="text-foreground font-mono ml-1">· {valueText}</span>
      </span>
    </div>
  );
}

export default CaseDetail;
