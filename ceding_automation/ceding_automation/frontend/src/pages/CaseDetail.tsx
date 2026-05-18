import { useParams, useNavigate, Link, useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Loader2, ChevronRight, ChevronLeft, AlertTriangle } from "lucide-react";
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
import { ZohoCrmTaskPanel } from "@/components/case/ZohoCrmTaskPanel";

const CaseDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { isCA, role, userName } = useRole();

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

  // Handle stage navigation from sidebar sub-nav
  useEffect(() => {
    const target = (location.state as any)?.goToStage;
    if (target && typeof target === "number") {
      updateMutation.mutate({
        updates: { current_stage: target, last_activity_at: new Date().toISOString() },
      });
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

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

  // Clamp to valid range — flow has 10 stages.
  const rawStage: number = (caseItem as any).current_stage ?? 1;
  const currentStage: number = Math.min(10, Math.max(1, rawStage));
  const stagesCompleted: number[] = ((caseItem as any).stages_completed ?? []).filter(
    (n: number) => n >= 1 && n <= 10,
  );
  const rag = calculateRag(caseItem as any);
  const planSupported = isSupportedPlanType(caseItem.plan_type);

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
    updateMutation.mutate({ updates: { current_stage: n, last_activity_at: new Date().toISOString() } });
  };

  const completeAndNext = () => {
    const newCompleted = Array.from(new Set([...stagesCompleted, currentStage])).sort((a, b) => a - b);
    const next = Math.min(currentStage + 1, 10);
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
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1.5 text-xs mt-2">
                <HeaderField label="Provider" value={caseItem.Provider_group} />
                <HeaderField label="Plan type" value={caseItem.plan_type} />
                <HeaderField label="Policy ref" value={caseItem.plan_number} mono />
                <HeaderField label="Owner" value={caseItem.owner_name ?? "—"} />
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
              </div>
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
          {(caseItem as any).zoho_task_id && (
            <div className="space-y-2">
              <ZohoCrmTaskPanel
                taskId={(caseItem as any).zoho_task_id}
                deepLink={(caseItem as any).zoho_deep_link ?? undefined}
              />
              {(!caseItem.Provider_group || !(caseItem as any).plan_number) && (
                <Button size="sm" variant="outline" onClick={syncFromZoho} className="text-xs">
                  Sync provider &amp; policy ref from Zoho
                </Button>
              )}
            </div>
          )}

          {planSupported && <StageComponent caseItem={caseItem as any} />}

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
              <Button onClick={completeAndNext} className="gap-2" disabled={!planSupported}>
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

export default CaseDetail;
