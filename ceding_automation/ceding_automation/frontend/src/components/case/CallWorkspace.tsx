import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useChecklistFields } from "@/hooks/useChecklistFields";
import { getTemplate } from "@/lib/checklistTemplates";
import { useRole } from "@/hooks/useRole";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Phone,
  PhoneOff,
  Sparkles,
  RefreshCw,
  Loader2,
  ListChecks,
  Mic,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  FileText,
  PlayCircle,
  Clock,
  PhoneCall,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";

interface Props {
  caseId: string;
  planType: string;
  clientName: string;
  providerName: string;
  planNumber: string;
  providerPhone?: string; // pre-populated from Provider Directory
}

interface CallScript {
  opener: string;
  sections: Array<{
    title: string;
    questions: Array<{ field_key: string; question: string; purpose: "obtain" | "verify" }>;
  }>;
  objection_handlers: Array<{ objection: string; response: string }>;
  closing: string;
}

interface ExtractedItem {
  key: string;
  value: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  evidence_quote: string;
  reasoning?: string;
}

type CallPhase =
  | "idle"
  | "dialling"
  | "connected"
  | "ended";

const SAMPLE_TRANSCRIPT = `[CA — Priya] Good morning, this is Priya Ramesh calling from Furnley House on behalf of our client Eleanor Whitmore regarding plan AV-PP-55021. We have an LOA on file dated 2 April. Can you confirm a few outstanding items please?

[Aviva — Mark] Yes, I can see the LOA. Go ahead.

[CA] Could you confirm the current value of the plan?
[Aviva] As of close of business yesterday, the current value is £127,450.32.

[CA] Thank you. And the transfer value?
[Aviva] Transfer value is the same — £127,450.32. No MVR or penalty applies.

[CA] What's the annual management charge?
[Aviva] AMC is 0.45%. There's no separate platform charge on this plan.

[CA] And the funds held?
[Aviva] It's invested 100% in the Aviva Pension MyM My Future Focus Growth fund.

[CA] What's the selected retirement age on file?
[Aviva] Selected retirement age is 65.

[CA] Are there any safeguarded or guaranteed benefits?
[Aviva] No safeguarded benefits. No GMP, no GAR.

[CA] And expression of wishes?
[Aviva] Yes — completed 12 March 2024, sole beneficiary is the spouse.

[CA] Perfect. I'll get that emailed across. Thank you Mark.`;

export function CallWorkspace({
  caseId,
  planType,
  clientName,
  providerName,
  planNumber,
  providerPhone = "",
}: Props) {
  const { role } = useRole();
  const template = useMemo(() => getTemplate(planType), [planType]);
  const { rows, refresh } = useChecklistFields({ caseId, template });

  // ── RingCentral config state ──────────────────────────────────────────
  const [rcConfigured, setRcConfigured] = useState<boolean | null>(null);
  const [agentPhone, setAgentPhone] = useState<string | null>(null);
  const [dialNumber, setDialNumber] = useState(providerPhone);

  // ── Script state ──────────────────────────────────────────────────────
  const [script, setScript] = useState<CallScript | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);

  // ── Call state ────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [transcript, setTranscript] = useState("");

  // ── Analysis state ────────────────────────────────────────────────────
  const [analyzing, setAnalyzing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [aiSummary, setAiSummary] = useState("");
  const [extractedItems, setExtractedItems] = useState<ExtractedItem[]>([]);
  const [acceptedKeys, setAcceptedKeys] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);

  const autoScriptSig = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Derived field lists ───────────────────────────────────────────────
  const labelByKey = useMemo(() => {
    const m = new Map<string, { label: string; section: string; type?: string; hint?: string }>();
    template.forEach((t) => m.set(t.key, { label: t.label, section: t.section, type: t.type, hint: t.hint }));
    return m;
  }, [template]);

  const missingFields = useMemo(
    () =>
      rows
        .filter((r) => r.field_key && (!r.value || r.status === "missing"))
        .map((r) => ({
          key: r.field_key!,
          label: labelByKey.get(r.field_key!)?.label ?? r.field_key!,
          section: labelByKey.get(r.field_key!)?.section ?? "",
          hint: labelByKey.get(r.field_key!)?.hint ?? null,
        })),
    [rows, labelByKey],
  );

  const reviewFields = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            r.field_key &&
            r.value &&
            (r.confidence === "LOW" || r.status === "review_requested"),
        )
        .map((r) => ({
          key: r.field_key!,
          label: labelByKey.get(r.field_key!)?.label ?? r.field_key!,
          section: labelByKey.get(r.field_key!)?.section ?? "",
          value: r.value ?? "",
          confidence: (r.confidence as string) ?? "LOW",
        })),
    [rows, labelByKey],
  );

  const totalQuestions = missingFields.length + reviewFields.length;

  // ── On mount: check RingCentral config + auto-generate script ─────────
  useEffect(() => {
    api.get(`/cases/${caseId}/calls/rc-status`)
      .then((res) => {
        setRcConfigured((res.data as any).configured ?? false);
        setAgentPhone((res.data as any).agentPhone ?? null);
      })
      .catch(() => setRcConfigured(false));
  }, [caseId]);

  useEffect(() => {
    if (totalQuestions === 0) return;
    const sig = `${caseId}-${missingFields.length}-${reviewFields.length}`;
    if (autoScriptSig.current === sig) return;
    autoScriptSig.current = sig;
    void generateScript();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, missingFields.length, reviewFields.length]);

  // ── Call timer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "connected" || !callStartedAt) return;
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - callStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, callStartedAt]);

  // ── Ring-out status polling (until connected or terminal state) ───────
  useEffect(() => {
    if (phase !== "dialling" || !sessionId) return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await api.get(`/cases/${caseId}/calls/ring-out/${sessionId}/status`);
        const status = (res.data as any).status as string;

        if (status === "CallConnected" || status === "Success") {
          clearInterval(pollRef.current!);
          setPhase("connected");
          setCallStartedAt(Date.now());
          toast.success("Call connected", { description: "Both parties are on the line." });
        } else if (
          ["NoAnswer", "Rejected", "HangUp", "IPPhoneOffline", "NotActivated"].includes(status)
        ) {
          clearInterval(pollRef.current!);
          setPhase("idle");
          setSessionId(null);
          toast.error(`Call ended: ${status}`);
        }
      } catch {
        // swallow — will retry on next tick
      }
    }, 3000);

    return () => clearInterval(pollRef.current!);
  }, [phase, sessionId, caseId]);

  // ── Script generation ─────────────────────────────────────────────────
  const generateScript = async () => {
    if (totalQuestions === 0) return;
    setScriptLoading(true);
    setScriptError(null);
    try {
      const res = await api.post(`/cases/${caseId}/calls/script`, {
        missingFields,
        reviewFields,
        clientName,
        providerName,
        planNumber,
        planType,
        providerPhone: dialNumber || undefined,
      });
      setScript((res.data as any).script as CallScript);
    } catch (e: any) {
      const msg = e?.response?.data?.error ?? e?.message ?? "Failed to generate script";
      setScriptError(msg);
      toast.error("Script generation failed", { description: msg });
    } finally {
      setScriptLoading(false);
    }
  };

  // ── Start RingCentral call ────────────────────────────────────────────
  const handleStartCall = async () => {
    if (!dialNumber.trim()) {
      toast.error("Enter the provider phone number to dial");
      return;
    }

    if (!rcConfigured) {
      // Dev / demo mode — simulate call
      setPhase("connected");
      setCallStartedAt(Date.now());
      setElapsedSec(0);
      toast.info("Demo mode: simulating call", {
        description:
          "Configure RINGCENTRAL_JWT + RINGCENTRAL_AGENT_PHONE in .env for production dialling.",
      });
      return;
    }

    setPhase("dialling");
    setElapsedSec(0);
    try {
      const res = await api.post(`/cases/${caseId}/calls/ring-out`, { toPhone: dialNumber });
      setSessionId((res.data as any).id);
      toast.info("Dialling…", {
        description: `Your phone (***${agentPhone}) will ring first, then connect to ${providerName}.`,
      });
    } catch (e: any) {
      setPhase("idle");
      const msg = e?.response?.data?.error ?? e?.message ?? "Failed to start call";
      toast.error("Call failed", { description: msg });
    }
  };

  // ── End / cancel call ─────────────────────────────────────────────────
  const handleEndCall = async () => {
    setPhase("ended");
    if (sessionId) {
      try {
        await api.delete(`/cases/${caseId}/calls/ring-out/${sessionId}`);
      } catch {
        // best-effort
      }
    }
    toast.info("Call ended", { description: "Paste or review the transcript below, then click Analyse." });
  };

  // ── Insert sample transcript ──────────────────────────────────────────
  const insertSampleTranscript = () => {
    setTranscript(SAMPLE_TRANSCRIPT);
    toast.info("Sample transcript inserted");
  };

  // ── AI transcript analysis ────────────────────────────────────────────
  const handleAnalyse = async () => {
    if (!transcript.trim()) {
      toast.error("Add a transcript first");
      return;
    }
    setAnalyzing(true);
    try {
      const targetSet = new Map<string, { key: string; label: string; type?: string; hint?: string }>();
      missingFields.forEach((f) =>
        targetSet.set(f.key, {
          key: f.key,
          label: f.label,
          type: labelByKey.get(f.key)?.type,
          hint: f.hint ?? undefined,
        }),
      );
      reviewFields.forEach((f) =>
        targetSet.set(f.key, { key: f.key, label: f.label, type: labelByKey.get(f.key)?.type }),
      );
      if (targetSet.size === 0) {
        template.forEach((t) =>
          targetSet.set(t.key, { key: t.key, label: t.label, type: t.type, hint: t.hint }),
        );
      }

      const res = await api.post(`/cases/${caseId}/calls/analyse`, {
        transcript,
        targets: Array.from(targetSet.values()),
        clientName,
        providerName,
        planNumber,
      });

      const data = res.data as { extracted: ExtractedItem[]; summary: string };
      const items = data.extracted.filter((it) => it.confidence !== "MISSING" && it.value);
      setExtractedItems(items);
      setAiSummary(data.summary ?? "");
      setAcceptedKeys(
        new Set(items.filter((it) => it.confidence !== "LOW").map((it) => it.key)),
      );
      setReviewOpen(true);
    } catch (e: any) {
      toast.error("Analysis failed", {
        description: e?.response?.data?.error ?? e?.message ?? "Unknown error",
      });
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Confirm merge ─────────────────────────────────────────────────────
  const handleConfirmMerge = async () => {
    setMerging(true);
    try {
      const accepted = extractedItems
        .filter((it) => acceptedKeys.has(it.key))
        .map((it) => ({
          fieldKey: it.key,
          value: it.value,
          confidence: it.confidence,
          evidenceQuote: it.evidence_quote,
        }));

      const res = await api.post(`/cases/${caseId}/calls/log`, {
        transcript: transcript.trim(),
        ringCentralId: sessionId ?? undefined,
        durationSeconds: elapsedSec || undefined,
        summary: aiSummary || undefined,
        acceptedFields: accepted,
      });

      const { fieldsUpdated } = res.data as { fieldsUpdated: number };

      toast.success(
        `Merged ${fieldsUpdated} field${fieldsUpdated === 1 ? "" : "s"} from the call`,
        {
          description:
            accepted.length - fieldsUpdated > 0
              ? `${accepted.length - fieldsUpdated} kept (manual edits / approvals preserved)`
              : "Call logged and checklist updated",
        },
      );

      // Reset
      setReviewOpen(false);
      setExtractedItems([]);
      setAiSummary("");
      setTranscript("");
      setElapsedSec(0);
      setCallStartedAt(null);
      setPhase("idle");
      setSessionId(null);
      await refresh();
    } catch (e: any) {
      toast.error("Failed to save call results", {
        description: e?.response?.data?.error ?? e?.message ?? "Unknown error",
      });
    } finally {
      setMerging(false);
    }
  };

  const fmtTime = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const isCallActive = phase === "dialling" || phase === "connected";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr,1.4fr]">
      {/* ── LEFT: Outstanding fields ─── */}
      <div className="rounded-md border border-border bg-card overflow-hidden">
        <div className="px-3 py-2 border-b border-border bg-muted/40 flex items-center justify-between">
          <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground flex items-center gap-1.5">
            <ListChecks className="h-3.5 w-3.5" />
            Outstanding fields ({totalQuestions})
          </h4>
          {/* RingCentral config badge */}
          {rcConfigured !== null && (
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                rcConfigured
                  ? "bg-success/15 text-success"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {rcConfigured ? (
                <>
                  <Wifi className="h-2.5 w-2.5" /> RingCentral live
                </>
              ) : (
                <>
                  <WifiOff className="h-2.5 w-2.5" /> RC demo mode
                </>
              )}
            </span>
          )}
        </div>

        <div className="p-3 space-y-3 max-h-[480px] overflow-y-auto">
          {totalQuestions === 0 ? (
            <p className="text-xs text-muted-foreground italic text-center py-6">
              No outstanding fields — checklist is complete, no call needed.
            </p>
          ) : (
            <>
              {missingFields.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-destructive font-semibold mb-1.5">
                    Missing ({missingFields.length})
                  </p>
                  <ul className="space-y-1">
                    {missingFields.map((f) => (
                      <li key={f.key} className="text-xs flex items-center gap-1.5">
                        <AlertCircle className="h-3 w-3 text-destructive shrink-0" />
                        <span className="text-foreground">{f.label}</span>
                        <span className="text-muted-foreground">· {f.section}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {reviewFields.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-yellow-600 font-semibold mb-1.5">
                    To verify ({reviewFields.length})
                  </p>
                  <ul className="space-y-1">
                    {reviewFields.map((f) => (
                      <li key={f.key} className="text-xs flex items-center gap-1.5">
                        <AlertCircle className="h-3 w-3 text-yellow-600 shrink-0" />
                        <span className="text-foreground">{f.label}</span>
                        <span className="text-muted-foreground">— "{f.value}"</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── RIGHT: Script + call controls ─── */}
      <div className="space-y-3">
        {/* AI Script panel */}
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-muted/40 flex items-center justify-between">
            <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              AI Call Script
            </h4>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={generateScript}
              disabled={scriptLoading || totalQuestions === 0}
            >
              {scriptLoading ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Regenerate
            </Button>
          </div>

          <div className="p-3 max-h-[260px] overflow-y-auto text-sm">
            {scriptLoading && !script && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating tailored script…
              </div>
            )}
            {scriptError && !script && (
              <p className="text-xs text-destructive">{scriptError}</p>
            )}
            {!scriptLoading && !script && !scriptError && totalQuestions === 0 && (
              <p className="text-xs text-muted-foreground italic">
                No questions to ask — checklist is fully resolved.
              </p>
            )}
            {script && (
              <div className="space-y-3">
                {script.opener && (
                  <p className="text-foreground leading-relaxed italic">"{script.opener}"</p>
                )}
                {(script.sections ?? []).map((s, i) => (
                  <div key={i}>
                    <p className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-1">
                      {s.title}
                    </p>
                    <ul className="space-y-1">
                      {(s.questions ?? []).map((q, j) => (
                        <li key={j} className="text-xs flex gap-1.5">
                          <ChevronRight className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
                          <span className="text-foreground">{q.question}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {(script.objection_handlers ?? []).length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-yellow-600 font-semibold">
                      Objection handlers ({script.objection_handlers.length})
                    </summary>
                    <ul className="mt-1 space-y-1.5">
                      {script.objection_handlers.map((o, i) => (
                        <li key={i}>
                          <span className="font-semibold">"{o.objection}"</span>{" "}
                          →{" "}
                          <span className="italic text-muted-foreground">{o.response}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {script.closing && (
                  <p className="text-foreground leading-relaxed italic border-t border-border pt-2">
                    "{script.closing}"
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Call controls + transcript */}
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-muted/40 flex items-center justify-between">
            <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground flex items-center gap-1.5">
              <Mic className="h-3.5 w-3.5 text-blue-500" />
              Call & Transcript
            </h4>
            {phase === "dialling" && (
              <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/30 animate-pulse">
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                Dialling…
              </Badge>
            )}
            {phase === "connected" && (
              <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">
                <span className="h-1.5 w-1.5 rounded-full bg-destructive mr-1.5 animate-pulse" />
                LIVE · {fmtTime(elapsedSec)}
              </Badge>
            )}
            {phase === "ended" && elapsedSec > 0 && (
              <Badge variant="outline">
                <Clock className="h-3 w-3 mr-1" /> {fmtTime(elapsedSec)}
              </Badge>
            )}
          </div>

          <div className="p-3 space-y-3">
            {/* Dial number input */}
            <div className="flex gap-2 items-center">
              <div className="relative flex-1">
                <Phone className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="tel"
                  value={dialNumber}
                  onChange={(e) => setDialNumber(e.target.value)}
                  placeholder="+44 provider phone number"
                  disabled={isCallActive}
                  className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                />
              </div>
              {rcConfigured && agentPhone && (
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                  from {agentPhone}
                </span>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              {!isCallActive ? (
                <Button
                  size="sm"
                  onClick={handleStartCall}
                  disabled={totalQuestions === 0 && phase !== "ended"}
                  className={rcConfigured ? "" : "opacity-90"}
                >
                  {rcConfigured ? (
                    <PhoneCall className="h-3.5 w-3.5 mr-1.5" />
                  ) : (
                    <Phone className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {rcConfigured ? "Start call via RingCentral" : "Start call (demo)"}
                </Button>
              ) : (
                <Button size="sm" variant="destructive" onClick={handleEndCall}>
                  <PhoneOff className="h-3.5 w-3.5 mr-1.5" />
                  End call
                </Button>
              )}

              <Button
                size="sm"
                variant="outline"
                onClick={insertSampleTranscript}
                disabled={isCallActive}
              >
                <FileText className="h-3.5 w-3.5 mr-1.5" />
                Sample transcript
              </Button>

              <Button
                size="sm"
                onClick={handleAnalyse}
                disabled={!transcript.trim() || analyzing || isCallActive}
                className="ml-auto"
              >
                {analyzing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <PlayCircle className="h-3.5 w-3.5 mr-1.5" />
                )}
                Analyse & propose updates
              </Button>
            </div>

            <Textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder={
                rcConfigured
                  ? "Transcript will appear here automatically once the call ends (via Palindrome STT).\nYou can also paste or edit it manually."
                  : "Paste the call transcript here, then click 'Analyse & propose updates'."
              }
              className="min-h-[180px] text-xs font-mono"
              disabled={phase === "dialling"}
            />

            {rcConfigured && (
              <p className="text-[10px] text-muted-foreground">
                <span className="text-success font-medium">● Live</span> — RingCentral records the
                call → Palindrome transcribes → transcript appears here automatically after hang-up.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Review & merge modal ─── */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              AI extracted {extractedItems.length} field
              {extractedItems.length === 1 ? "" : "s"} from the call
            </DialogTitle>
            <DialogDescription>
              Tick the values you want to merge into the checklist. Manually edited and approved
              fields are protected automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {aiSummary && (
              <div className="rounded-md border border-border bg-muted/30 p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                  AI summary
                </p>
                <p className="text-xs text-foreground leading-relaxed whitespace-pre-line">
                  {aiSummary}
                </p>
              </div>
            )}

            {extractedItems.length === 0 ? (
              <p className="text-xs text-muted-foreground italic text-center py-6">
                No field values found in the transcript. Close and edit the checklist manually.
              </p>
            ) : (
              <ul className="space-y-2">
                {extractedItems.map((it) => {
                  const tpl = labelByKey.get(it.key);
                  const existing = rows.find((r) => r.field_key === it.key);
                  const isProtected =
                    (existing as any)?.is_manually_overridden ||
                    (existing as any)?.isManuallyOverridden ||
                    existing?.status === "approved" ||
                    existing?.status === "review_requested" ||
                    existing?.status === "APPROVED";
                  const checked = acceptedKeys.has(it.key);
                  const confCls =
                    it.confidence === "HIGH"
                      ? "bg-success/15 text-success border-success/30"
                      : it.confidence === "MEDIUM"
                      ? "bg-yellow-500/15 text-yellow-600 border-yellow-500/30"
                      : "bg-destructive/15 text-destructive border-destructive/30";

                  return (
                    <li
                      key={it.key}
                      className={`rounded-md border p-2.5 ${
                        isProtected
                          ? "border-yellow-500/40 bg-yellow-500/5"
                          : checked
                          ? "border-primary/40 bg-primary/5"
                          : "border-border bg-card"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={checked}
                          disabled={isProtected}
                          onCheckedChange={(v) => {
                            setAcceptedKeys((prev) => {
                              const next = new Set(prev);
                              if (v) next.add(it.key);
                              else next.delete(it.key);
                              return next;
                            });
                          }}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-foreground">
                              {tpl?.label ?? it.key}
                            </span>
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider ${confCls}`}
                            >
                              {it.confidence}
                            </span>
                            {isProtected && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-yellow-600">
                                <AlertCircle className="h-3 w-3" /> Protected — will skip
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-foreground mt-0.5 break-words">
                            {existing?.value && existing.value !== it.value && (
                              <span className="text-muted-foreground line-through mr-1.5">
                                {existing.value}
                              </span>
                            )}
                            <span className="font-medium">{it.value}</span>
                          </p>
                          {it.evidence_quote && (
                            <p className="text-[10px] text-muted-foreground italic mt-1 leading-relaxed">
                              "{it.evidence_quote}"
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
            <Button variant="outline" onClick={() => setReviewOpen(false)} disabled={merging}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirmMerge}
              disabled={merging || acceptedKeys.size === 0}
            >
              {merging ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              )}
              Merge {acceptedKeys.size} field{acceptedKeys.size === 1 ? "" : "s"} & save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
