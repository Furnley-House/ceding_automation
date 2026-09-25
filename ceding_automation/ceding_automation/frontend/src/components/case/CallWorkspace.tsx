import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getProviders } from "@/services/api";
import { useChecklistFields, isMissing, fundDetailsStatus } from "@/hooks/useChecklistFields";
import { useFundLines } from "@/hooks/useFundLines";
import { getTemplate } from "@/lib/checklistTemplates";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CallEditableField } from "./CallEditableField";
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
  Copy,
  Volume2,
  CloudUpload,
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
  providerPhone?: string;
  providerPhoneMain?: string;
  providerPhoneCeding?: string;
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

interface ProviderOption {
  id: string;
  name: string;
  phone_main?: string;
  phone_ceding_dept?: string;
}

export function CallWorkspace({
  caseId,
  planType,
  clientName,
  providerName,
  planNumber,
  providerPhone = "",
  providerPhoneMain = "",
}: Props) {
  const template = useMemo(() => getTemplate(planType), [planType]);
  const { rows, refresh, updateField, loading: checklistLoading } = useChecklistFields({
    caseId,
    template,
  });

  // ── RingCentral config state ──────────────────────────────────────────
  const [rcConfigured, setRcConfigured] = useState<boolean | null>(null);
  const [agentPhone, setAgentPhone] = useState<string | null>(null);
  const [selectedPhone, setSelectedPhone] = useState(providerPhoneMain || providerPhone);

  // ── Provider directory ────────────────────────────────────────────────
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");

  useEffect(() => {
    getProviders()
      .then((data) => {
        const list = (data as Record<string, unknown>[])
          .map((p) => ({
            id: p.id as string,
            name: (p.name as string) || "",
            phone_main: p.phone_main as string | undefined,
            phone_ceding_dept: p.phone_ceding_dept as string | undefined,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setProviders(list);
        if (providerName) {
          const match = list.find(
            (p) => p.name.toLowerCase() === providerName.toLowerCase()
          );
          if (match) {
            setSelectedProviderId(match.id);
            setSelectedPhone(match.phone_main || providerPhoneMain || "");
          }
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeProvider = providers.find((p) => p.id === selectedProviderId);

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

  // ── Palindrome transcription ──────────────────────────────────────────
  // The CA picks the call recording; the backend puts it in the client's
  // WorkDrive folder, triggers Palindrome, and a poller collects the
  // transcript. We poll our own API — not Zoho — and drop the finished text
  // into the same textarea the manual flow uses, so "Analyse & propose
  // updates" works unchanged from there.
  type PalPhase = "idle" | "uploading" | "waiting" | "done" | "failed";
  const [palPhase, setPalPhase] = useState<PalPhase>("idle");
  const [palTranscriptId, setPalTranscriptId] = useState<string | null>(null);
  const [palMessage, setPalMessage] = useState<string | null>(null);
  const [palWaitedSec, setPalWaitedSec] = useState(0);
  const palPollRef = useRef<number | null>(null);
  // Whether TRANSCRIPT_VIA_PALINDROME is on server-side. Decides which engine
  // the Transcribe buttons use; when off they keep the Azure Speech path.
  const [palEnabled, setPalEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/cases/${caseId}/calls/palindrome-status`)
      .then((r) => {
        const d = r.data as { enabled?: boolean; configured?: boolean };
        if (!cancelled) setPalEnabled(Boolean(d.enabled && d.configured));
      })
      .catch(() => {
        // Probe failure just means we stay on Azure Speech.
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  // Transcripts already stored against this case.
  //
  // Palindrome is asynchronous and the in-page poll only survives as long as
  // the tab does. Without this, a transcript that arrived after the CA
  // navigated away — or was submitted from anywhere other than this screen —
  // sits in the database with no way to reach it. So on mount we look for
  // finished ones and offer them.
  interface StoredTranscript {
    id: string;
    source: string;
    createdAt: string;
    completedAt: string | null;
    chars: number;
    hasText: boolean;
    palindromeStatus: string | null;
  }
  const [storedTranscripts, setStoredTranscripts] = useState<StoredTranscript[]>([]);

  const refreshStoredTranscripts = async (): Promise<StoredTranscript[] | null> => {
    try {
      const r = await api.get(`/cases/${caseId}/calls/transcripts`);
      // Server returns newest first; keep only ones that actually have text.
      const all = r.data as StoredTranscript[];
      // A row with no completedAt is a Palindrome job still running — that is
      // what keeps the poll alive.
      setHasPendingJob(all.some((t) => !t.completedAt));
      const withText = all.filter((t) => t.hasText);
      setStoredTranscripts(withText);
      return withText;
    } catch {
      // Non-critical — the manual paste path still works.
      return null;
    }
  };

  // Keep watching for transcripts that land while this page is open.
  //
  // Palindrome takes minutes and jobs can be started from anywhere — the
  // Transcribe buttons, a file dropped into WorkDrive, another tab. Loading
  // only on mount meant a CA who submitted and waited here saw nothing until
  // they refreshed.
  //
  // When a newer transcript appears we swap it in, but only if the editor
  // still holds a stored transcript we put there (palTranscriptId is set) or
  // is empty. Anything hand-typed or edited is left alone and the CA is told
  // instead — losing someone's typing to a background poll would be worse
  // than making them click.
  const [newerTranscriptId, setNewerTranscriptId] = useState<string | null>(null);

  // Only poll while something is actually in flight. The list endpoint tells
  // us: a row with completedAt === null is a job still running. Once every
  // job has settled there is nothing to wait for, so we stop rather than
  // hitting the API every 30s for the rest of the session.
  const [hasPendingJob, setHasPendingJob] = useState(false);

  // Two cadences rather than one. Polling every 30s forever was wasteful, but
  // stopping entirely meant a transcript submitted elsewhere — the folder
  // watcher, another tab — never appeared without a manual refresh.
  //
  // Also re-check when the tab regains focus: a CA who starts a transcription
  // and goes to do something else expects it waiting when they come back.
  useEffect(() => {
    const onFocus = () => void refreshStoredTranscripts();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  useEffect(() => {
    const active = hasPendingJob || palPhase === "waiting";
    const everyMs = active ? 15_000 : 90_000;

    const id = window.setInterval(async () => {
      const list = await refreshStoredTranscripts();
      const newest = list?.[0];
      if (!newest || newest.id === palTranscriptId) return;

      const editorIsOurs = Boolean(palTranscriptId) || !transcript.trim();
      if (editorIsOurs) {
        try {
          const r = await api.get(`/cases/${caseId}/calls/transcripts/${newest.id}`);
          const text = (r.data as { rawText?: string }).rawText ?? "";
          if (text) {
            setTranscript(text);
            setPalTranscriptId(newest.id);
            setPalPhase("done");
            setNewerTranscriptId(null);
            toast.success("New transcript ready", {
              description: "Loaded into the editor below.",
            });
          }
        } catch {
          /* try again next tick */
        }
      } else {
        setNewerTranscriptId(newest.id);
      }
    }, everyMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, palTranscriptId, transcript, hasPendingJob, palPhase]);

  // On first load, drop the most recent transcript straight into the editor.
  // That is almost always the call the CA just made, so making them pick it
  // out of a list is a step for nothing. Older ones stay listed below.
  //
  // Guarded on the editor being empty so we never overwrite something the CA
  // has pasted or edited by hand.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    autoLoadedRef.current = false;
    void (async () => {
      const list = await refreshStoredTranscripts();
      if (autoLoadedRef.current) return;
      const newest = list?.[0];
      if (newest && !transcript.trim()) {
        autoLoadedRef.current = true;
        try {
          const r = await api.get(`/cases/${caseId}/calls/transcripts/${newest.id}`);
          const text = (r.data as { rawText?: string }).rawText ?? "";
          if (text) {
            setTranscript(text);
            setPalPhase("done");
            setPalTranscriptId(newest.id);
          }
        } catch {
          // Leave it in the list for a manual load.
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const loadStoredTranscript = async (id: string) => {
    const t = toast.loading("Loading transcript…");
    try {
      const r = await api.get(`/cases/${caseId}/calls/transcripts/${id}`);
      const text = (r.data as { rawText?: string }).rawText ?? "";
      if (!text) {
        toast.warning("That transcript is empty", { id: t });
        return;
      }
      setTranscript(text);
      setPhase("ended");
      setPalPhase("done");
      setPalTranscriptId(id);
      toast.success("Transcript loaded", {
        id: t,
        description: "Review it below, then click Analyse & propose updates.",
      });
    } catch {
      toast.error("Could not load transcript", { id: t });
    }
  };

  // ── RC Embeddable widget state ────────────────────────────────────────
  const [rcLoggedIn, setRcLoggedIn] = useState(false);
  const [rcTranscriptStatus, setRcTranscriptStatus] = useState<
    "idle" | "fetching" | "done" | "unavailable"
  >("idle");

  // Stop polling when the component goes away, or a closed case keeps a
  // timer alive against a transcript nobody is watching.
  useEffect(() => {
    return () => {
      if (palPollRef.current) window.clearInterval(palPollRef.current);
    };
  }, []);

  /**
   * Watch one transcript row until the poller fills in rawText.
   *
   * Palindrome usually lands in 2–3 minutes. We give it 15 before calling it
   * failed — long enough for a queue backlog (ceding shares the Creator form
   * with the meeting pipeline), short enough that a CA isn't left staring at
   * a spinner forever.
   */
  const watchPalindromeTranscript = (transcriptId: string) => {
    if (palPollRef.current) window.clearInterval(palPollRef.current);
    const startedAt = Date.now();
    const LIMIT_MS = 15 * 60_000;

    palPollRef.current = window.setInterval(async () => {
      setPalWaitedSec(Math.round((Date.now() - startedAt) / 1000));

      if (Date.now() - startedAt > LIMIT_MS) {
        window.clearInterval(palPollRef.current!);
        setPalPhase("failed");
        setPalMessage("Still waiting after 15 minutes — check the case audit trail.");
        return;
      }

      try {
        const res = await api.get(`/cases/${caseId}/calls/transcripts/${transcriptId}`);
        const row = res.data as {
          rawText?: string;
          palindromeStatus?: string | null;
          palindromeError?: string | null;
          completedAt?: string | null;
        };

        if (row.palindromeError) {
          window.clearInterval(palPollRef.current!);
          setPalPhase("failed");
          setPalMessage(row.palindromeError);
          toast.error("Transcription failed", { description: row.palindromeError });
          return;
        }

        if (row.rawText && row.rawText.length > 20) {
          window.clearInterval(palPollRef.current!);
          setTranscript(row.rawText);
          setPalPhase("done");
          setPalMessage(null);
          void refreshStoredTranscripts();
          toast.success("Transcript ready", {
            description: "Review it below, then click Analyse & propose updates.",
          });
          return;
        }

        // Surface Palindrome's own wording while we wait. It is unreliable —
        // rows have been observed finishing while the field still reads
        // "Ready For Processing" — so it is shown as progress only and never
        // used to decide completion.
        setPalMessage(row.palindromeStatus ?? null);
      } catch {
        // Transient failures are fine; the next tick retries.
      }
    }, 10_000);
  };

  /**
   * Provider_Client_YYYY-MM-DD_HH-MM.mp3 — matches the naming the existing
   * "Save to WorkDrive" button uses, so recordings filed by either route sort
   * together and read the same way in the client's folder.
   */
  const rcRecordingFileName = (rec: RcRecording): string => {
    const sanitize = (s: string) =>
      (s || "")
        .trim()
        .replace(/[\s/\\:*?"<>|]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    const dt = new Date(rec.startTime || Date.now());
    const pad = (n: number) => String(n).padStart(2, "0");
    const datePart =
      `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}` +
      `_${pad(dt.getHours())}-${pad(dt.getMinutes())}`;
    return `${sanitize(providerName) || "Provider"}_${sanitize(clientName) || "Client"}_${datePart}.mp3`;
  };

  /**
   * Send a recording to Palindrome and wait for the transcript.
   *
   * Backs the existing Transcribe buttons — the RC Recordings panel passes a
   * contentUri, the WorkDrive panel passes a file id. Either way the backend
   * files the audio in the client's WorkDrive folder, triggers Palindrome and
   * the poller collects the result.
   *
   * Returns true when the submission was accepted, so callers can fall back to
   * Azure Speech if Palindrome is unavailable.
   */
  const submitToPalindrome = async (
    body: { workdriveFileId?: string; contentUri?: string; fileName?: string },
  ): Promise<boolean> => {
    setPalPhase("uploading");
    setPalMessage(null);
    setPalWaitedSec(0);
    const t = toast.loading("Sending recording for transcription…");

    try {
      const payload = { ...body, ...(rcConfigured ? {} : { rcToken: rcToken.trim() }) };
      const res = await api.post(`/cases/${caseId}/calls/palindrome-submit`, payload);
      const { transcriptId } = res.data as { transcriptId: string };
      setPalTranscriptId(transcriptId);
      setPalPhase("waiting");
      toast.success("Sent to Palindrome", {
        id: t,
        description: "Transcript usually arrives in 2–3 minutes.",
      });
      watchPalindromeTranscript(transcriptId);
      return true;
    } catch (err: unknown) {
      const e = err as {
        response?: { status?: number; data?: { error?: string; message?: string } };
      };
      const detail = e.response?.data?.message ?? e.response?.data?.error ?? "Submission failed";
      setPalPhase("failed");
      setPalMessage(detail);
      toast.error(
        e.response?.status === 422
          ? "No WorkDrive folder for this client"
          : "Could not send for transcription",
        { id: t, description: detail },
      );
      return false;
    }
  };

  // ── RC Recordings panel ───────────────────────────────────────────────
  interface RcRecording {
    id: string;
    sessionId: string;
    startTime: string;
    duration: number;
    direction: string;
    from: { phoneNumber: string; name?: string };
    to: { phoneNumber: string; name?: string };
    hasRecording: boolean;
    contentUri?: string;
  }
  const [rcRecordings, setRcRecordings] = useState<RcRecording[]>([]);
  const [rcRecordingsLoading, setRcRecordingsLoading] = useState(false);
  const [recordingsPanelOpen, setRecordingsPanelOpen] = useState(false);
  const [rcViewMode, setRcViewMode] = useState<"latest" | "all">("latest");
  const [fetchingTranscriptFor, setFetchingTranscriptFor] = useState<string | null>(null);
  const [manualSessionId, setManualSessionId] = useState("");
  const [rcToken, setRcToken] = useState(() => localStorage.getItem("rc-access-token") ?? "");
  const [rcTokenPanelOpen, setRcTokenPanelOpen] = useState(false);

  // ── WorkDrive recordings (saved calls) ────────────────────────────────
  interface WorkDriveFile {
    id: string;
    name: string;
    sizeBytes?: number;
    /** Display string only — "Aug 19, 16:01". Never pass to new Date(). */
    createdTime?: string;
    /** Epoch ms. Safe to compare and format. */
    createdTimeMs?: number;
    permalink?: string;
  }
  const [wdFiles, setWdFiles] = useState<WorkDriveFile[]>([]);
  const [wdLoading, setWdLoading] = useState(false);
  const [wdPanelOpen, setWdPanelOpen] = useState(true);
  const [wdTranscribingId, setWdTranscribingId] = useState<string | null>(null);

  // ── Per-user RingCentral OAuth connection state ─────────────────────────
  const [rcUserConnected, setRcUserConnected] = useState<boolean>(false);
  const [rcUserName, setRcUserName] = useState<string | null>(null);
  const [rcConnecting, setRcConnecting] = useState(false);
  // Captured from the RC widget's login event — used to auto-map the Ceding user
  // to whichever extension is currently signed in on the widget. Persisted to
  // localStorage so Connect still works even when the widget isn't visible on
  // a manual-call case (no provider selected).
  const [rcWidgetLoginNumber, setRcWidgetLoginNumber] = useState<string | null>(
    () => localStorage.getItem("rc-widget-login-number")
  );

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

  // Iterate the TEMPLATE (with showIf conditional filter) rather than the
  // raw DB rows. Two reasons:
  //   - Aligns the count with Stage 4 + Stage 6 — was off-by-one before
  //     because the backend seeds a placeholder ChecklistField row for the
  //     `fund_lines` table-typed template, which is filtered out of the
  //     template builder. The vestigial row is now also stripped at the
  //     normaliseRows layer, but template-driven iteration is the correct
  //     conceptual model anyway.
  //   - Respects conditional fields: a field hidden by `showIf` shouldn't
  //     be asked about on the call.
  const byKey = useMemo(() => {
    const m = new Map<string, (typeof rows)[number]>();
    rows.forEach((r) => { if (r.field_key) m.set(r.field_key, r); });
    return m;
  }, [rows]);
  const visibleTemplate = useMemo(
    () =>
      template.filter((f) => {
        if (!f.showIf) return true;
        const dependent = byKey.get(f.showIf.key)?.value;
        return dependent ? f.showIf.in.includes(dependent) : false;
      }),
    [template, byKey],
  );

  // Fund Details — pull rows so we can ask the agent about funds when the
  // table is empty / incomplete.
  const { rows: fundLines } = useFundLines(caseId);
  const fundStatus = useMemo(() => fundDetailsStatus(fundLines), [fundLines]);

  const missingFields = useMemo(() => {
    const list = visibleTemplate
      .filter((t) => isMissing(byKey.get(t.key)))
      .map((t) => ({
        key: t.key,
        label: t.label,
        section: t.section,
        type: t.type,
        options: t.options,
        hint: t.hint ?? null,
      }));
    // Synthetic Fund Details entry — appears once when the sub-table is
    // empty (or every row blank). Lets the agent be asked about funds in
    // the same call without bolting on a separate UI.
    if (fundStatus === "missing") {
      list.push({
        key: "__fund_details__",
        label: "Fund Details",
        section: "Fund Details",
        type: "text",
        options: undefined,
        hint: "Edit fund rows on Stage 4 (Fund Details table) — this section can't be captured inline.",
      });
    }
    return list;
  }, [visibleTemplate, byKey, fundStatus]);

  const reviewFields = useMemo(() => {
    // Switched to template iteration + uppercase confidence match. Status
    // comes back lowercased via the useChecklistFields adapter.
    const list = visibleTemplate
      .map((t) => ({ t, r: byKey.get(t.key) }))
      .filter(({ r }) => {
        if (!r || !r.value || isMissing(r)) return false;
        const c = (r.confidence ?? "").toString().toUpperCase();
        return c === "LOW" || c === "MEDIUM" || c === "CONFLICT" || r.status === "review_requested";
      })
      .map(({ t, r }) => ({
        key: t.key,
        label: t.label,
        section: t.section,
        type: t.type,
        options: t.options,
        value: r!.value ?? "",
        confidence: ((r!.confidence as string) ?? "LOW").toUpperCase(),
      }));
    if (fundStatus === "review") {
      list.push({
        key: "__fund_details__",
        label: "Fund Details",
        section: "Fund Details",
        type: "text",
        options: undefined,
        value: "(some rows incomplete or low-confidence)",
        confidence: "LOW",
      });
    }
    return list;
  }, [visibleTemplate, byKey, fundStatus]);

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

  // ── Check whether the logged-in user has connected their own RC account ─
  const refreshRcUserStatus = async () => {
    try {
      const res = await api.get(`/auth/rc/status`);
      const data = res.data as { connected: boolean; ownerName?: string };
      setRcUserConnected(data.connected);
      setRcUserName(data.ownerName ?? null);
      // If the user isn't connected to RC, make sure no stale recordings are shown
      if (!data.connected) setRcRecordings([]);
    } catch {
      setRcUserConnected(false);
      setRcRecordings([]);
    }
  };
  useEffect(() => {
    void refreshRcUserStatus();
    // If the OAuth landing page sent us back here, refresh status again
    const handler = (e: StorageEvent) => {
      if (e.key === "rc-just-connected") void refreshRcUserStatus();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  interface RcExtensionInfo {
    id: string;
    extensionNumber?: string;
    name: string;
    email?: string;
  }

  const connectRingCentral = async () => {
    if (!rcWidgetLoginNumber) {
      toast.error("Sign in to the RingCentral widget first", {
        description: "Open any case with a provider selected, sign in to the widget once — then Connect works everywhere.",
        duration: 8000,
      });
      return;
    }
    setRcConnecting(true);
    // Clear any stale recordings — they may belong to a previously-mapped extension
    setRcRecordings([]);
    try {
      // We pass the RC widget's signed-in extension info so the backend maps THIS user
      // to whichever extension is currently active on the widget. This means the user
      // can only map themselves to an account they have RC credentials for — secure.
      const res = await api.post(`/auth/rc/connect`, {
        widgetLoginNumber: rcWidgetLoginNumber,
      });
      const data = res.data as { matched: boolean; extension?: RcExtensionInfo };
      if (data.matched && data.extension) {
        setRcUserConnected(true);
        setRcUserName(data.extension.name);
        toast.success(`Connected as ${data.extension.name}`, { description: "Click Load Recordings to see your calls." });
      }
    } catch (err: unknown) {
      const status = (err as any)?.response?.status;
      const msg = (err as any)?.response?.data?.error ?? (err as Error).message;
      if (status === 404) {
        toast.error("Could not match your RC widget login to any extension", {
          description: msg,
          duration: 8000,
        });
      } else {
        toast.error("Connect failed", { description: msg });
      }
    } finally {
      setRcConnecting(false);
    }
  };

  const disconnectRingCentral = async () => {
    try {
      await api.post(`/auth/rc/disconnect`);
      setRcUserConnected(false);
      setRcUserName(null);
      setRcRecordings([]); // Clear data on disconnect
      toast.success("RingCentral disconnected");
    } catch (err: unknown) {
      toast.error("Disconnect failed", { description: (err as any)?.response?.data?.error ?? (err as Error).message });
    }
  };

  // Auto-generate a script when the outstanding-fields set changes.
  //
  // Gates:
  //  1. Wait for the checklist to finish loading. On mount `rows` is
  //     `[]` and `isMissing(undefined)` returns true, so EVERY template
  //     field looks missing — a script generated in that split-second
  //     is based on empty-shell data and gets overwritten anyway when
  //     the real data lands. Skipping until `checklistLoading=false`
  //     eliminates the race that produced the "correct script → 3-5s
  //     later switches to a generic one" bug.
  //  2. Signature dedupe so a re-render with the same field counts
  //     doesn't refire pointlessly.
  //  3. AbortController per invocation so the auto-effect can cancel
  //     an older in-flight request when the field counts change again.
  useEffect(() => {
    if (checklistLoading) return;
    if (totalQuestions === 0) {
      // Nothing to ask about — clear any stale script so a case that
      // becomes fully-answered doesn't keep showing an out-of-date one.
      setScript(null);
      setScriptError(null);
      autoScriptSig.current = null;
      return;
    }
    const sig = `${caseId}-${missingFields.length}-${reviewFields.length}`;
    if (autoScriptSig.current === sig) return;
    autoScriptSig.current = sig;
    const controller = new AbortController();
    void generateScript({ signal: controller.signal });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, checklistLoading, missingFields.length, reviewFields.length, totalQuestions]);

  // ── Persist RC token to localStorage whenever it changes ─────────────
  useEffect(() => {
    if (rcToken.trim()) {
      localStorage.setItem("rc-access-token", rcToken.trim());
    } else {
      localStorage.removeItem("rc-access-token");
    }
  }, [rcToken]);


  // ── Call timer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "connected" || !callStartedAt) return;
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - callStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, callStartedAt]);

  // ── RC Embeddable widget — load once, hide/show via CSS ──────────────────
  useEffect(() => {
    // Inject a style rule that hides the widget until Start call is clicked.
    // We give it a known id so we can remove it (= show widget) on demand.
    if (!document.getElementById("rc-hide-style")) {
      const s = document.createElement("style");
      s.id = "rc-hide-style";
      s.textContent =
        "#rc-widget, #rc-widget-adapter-frame, [id^='rc-widget']:not(#rc-widget-script) { display: none !important; }";
      document.head.appendChild(s);
    }

    // Load the adapter script once; subsequent mounts skip this.
    if (!document.getElementById("rc-widget-script")) {
      const script = document.createElement("script");
      script.id = "rc-widget-script";
      script.src =
        "https://apps.ringcentral.com/integration/ringcentral-embeddable/latest/adapter.js";
      script.async = true;
      document.body.appendChild(script);
    }

    const handleRcMessage = (e: MessageEvent) => {
      const data = e.data as Record<string, unknown> | null;
      if (!data?.type) return;
      switch (data.type) {
        case "rc-login-status-notify":
          setRcLoggedIn(!!(data.loggedIn));
          // loginNumber format: "+44116218XXXX*777" where 777 is the extension number
          if (data.loggedIn && data.loginNumber && typeof data.loginNumber === "string") {
            const ln = data.loginNumber as string;
            setRcWidgetLoginNumber(ln);
            localStorage.setItem("rc-widget-login-number", ln);
          }
          if (data.loggedIn === false) {
            // Don't clear stored loginNumber on widget sign-out — it's still
            // valid info we can reuse to connect later. Only the DB mapping
            // matters for actual recording access.
          }
          break;
        // These events only fire when the user is logged in — use them as a
        // fallback to catch the logged-in state when rc-login-status-notify
        // fired before our listener was registered (race on first mount).
        case "rc-dialer-status-notify":
          if (data.ready !== false) setRcLoggedIn(true);
          break;
        case "rc-webphone-connection-status-notify": {
          const status = data.connectionStatus as string | undefined;
          if (status === "connectionStatus-connected" || status === "connectionStatus-connecting") {
            setRcLoggedIn(true);
          }
          break;
        }
        case "rc-call-init-notify":
          setPhase("dialling");
          setElapsedSec(0);
          break;
        case "rc-call-start-notify": {
          const call = data.call as Record<string, unknown> | undefined;
          const sid = call?.telephonySessionId as string | undefined;
          setPhase("connected");
          setCallStartedAt(Date.now());
          if (sid) setSessionId(sid);
          toast.success("Call connected", { description: "Both parties are on the line." });
          break;
        }
        case "rc-call-end-notify": {
          const call = data.call as Record<string, unknown> | undefined;
          const sid = call?.telephonySessionId as string | undefined;
          setPhase("ended");
          if (sid) {
            setSessionId(sid);
            void fetchRcTranscript(sid);
          } else {
            toast.info("Call ended", {
              description: "Paste the transcript below, then click Analyse.",
            });
          }
          break;
        }
        // Fired continuously while a call is active — use it to capture session IDs
        // even when the call wasn't initiated via our "Start call" button.
        case "rc-active-call-notify": {
          const call = data.call as Record<string, unknown> | undefined;
          const sid = call?.telephonySessionId as string | undefined;
          const callStatus = call?.callStatus as string | undefined;
          if (sid) setSessionId(sid);
          if (callStatus === "CallConnected" && phase === "idle") {
            setPhase("connected");
            setCallStartedAt(Date.now());
          }
          break;
        }
        // RC widget announces every route change — use it to:
        // 1. Auto-open the panel when user browses to Recordings tab
        // 2. Auto-fetch transcript when user clicks a specific recording
        //    (path becomes /history/recordings/<telephonySessionId>)
        case "rc-route-changed-notify": {
          const path = data.path as string | undefined;
          if (!path) break;
          if (path === "/history/recordings") {
            setRecordingsPanelOpen(true);
            setRcRecordingsLoading(false);
          }
          // Specific recording selected — extract session ID from path
          const match = path.match(/^\/history\/recordings\/(.+)$/);
          if (match) {
            const sid = decodeURIComponent(match[1]);
            setSessionId(sid);
            setRecordingsPanelOpen(true);
            toast.info("Loading transcript…", { description: `Session: ${sid}` });
            void fetchRcTranscript(sid);
          }
          break;
        }
        // rc-call-log-sync-notify: only fires for new calls needing CRM logging,
        // not for browsing historical recordings. Keep handler in case it does fire.
        case "rc-call-log-sync-notify": {
          const calls = data.calls as Array<Record<string, unknown>> | undefined;
          if (!calls?.length) break;
          const recs: RcRecording[] = calls
            .filter((c) => c.recording)
            .map((c) => {
              const rec = c.recording as Record<string, unknown> | undefined;
              const startMs = c.startTime as number | string | undefined;
              return {
                id: (c.id as string) || "",
                sessionId: (c.telephonySessionId as string) || (c.sessionId as string) || (c.id as string) || "",
                startTime: startMs ? new Date(startMs as number).toISOString() : "",
                duration: (c.duration as number) ?? 0,
                direction: (c.direction as string) ?? "Outbound",
                from: (c.from as { phoneNumber: string; name?: string }) ?? { phoneNumber: "" },
                to: (c.to as { phoneNumber: string; name?: string }) ?? { phoneNumber: "" },
                hasRecording: !!(rec?.contentUri || rec?.uri),
              };
            });
          if (recs.length > 0) {
            setRcRecordings((prev) => {
              const existing = new Set(prev.map((r) => r.id));
              return [...recs.filter((r) => !existing.has(r.id)), ...prev];
            });
            setRcRecordingsLoading(false);
          }
          break;
        }
      }
    };

    window.addEventListener("message", handleRcMessage);
    return () => {
      window.removeEventListener("message", handleRcMessage);
      // Re-hide the widget when leaving Call Assist.
      if (!document.getElementById("rc-hide-style")) {
        const s = document.createElement("style");
        s.id = "rc-hide-style";
        s.textContent =
          "#rc-widget, #rc-widget-adapter-frame, [id^='rc-widget']:not(#rc-widget-script) { display: none !important; }";
        document.head.appendChild(s);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-populate dial number in widget whenever it changes ───────────
  useEffect(() => {
    if (!selectedPhone) return;
    window.postMessage(
      { type: "rc-adapter-auto-populate-dial-numbers", dialNumbers: [{ phoneNumber: selectedPhone }] },
      "*"
    );
  }, [selectedPhone]);

  // ── Ring-out status polling (until connected or terminal state) ───────
  // Only used in non-widget mode (ring-out backend API fallback).
  useEffect(() => {
    if (phase !== "dialling" || !sessionId || rcConfigured) return;

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

  // ── Fetch transcript from RC AI after call ends ───────────────────────
  const fetchRcTranscript = async (telephonySessionId: string) => {
    setRcTranscriptStatus("fetching");
    const t = toast.loading("Fetching transcript from RingCentral…");
    try {
      const res = await api.get(`/cases/${caseId}/calls/rc-transcript`, {
        params: { telephonySessionId },
      });
      const { transcript: text, hasRecording, jobPending } = res.data as {
        transcript: string | null;
        hasRecording: boolean;
        jobPending: boolean;
      };

      if (text) {
        setTranscript(text);
        setRcTranscriptStatus("done");
        toast.success("Transcript ready", { id: t, description: "Review and click Analyse." });
      } else if (jobPending) {
        setRcTranscriptStatus("unavailable");
        toast.info("Transcript processing", {
          id: t,
          description: "RingCentral is still transcribing. Retry in ~30 seconds.",
        });
      } else if (hasRecording) {
        setRcTranscriptStatus("unavailable");
        toast.warning("Auto-transcription unavailable", {
          id: t,
          description: "Recording found but AI transcription isn't enabled on your RC plan. Paste manually.",
        });
      } else {
        setRcTranscriptStatus("unavailable");
        toast.info("Call ended", {
          id: t,
          description: "No recording found yet — wait a moment and retry, or paste the transcript manually.",
        });
      }
    } catch {
      setRcTranscriptStatus("unavailable");
      toast.info("Call ended", { id: t, description: "Paste the transcript below, then click Analyse." });
    }
  };

  // ── Load recordings — calls RC API directly from browser (token auto-captured) ──
  const fetchRcRecordings = async () => {
    setRcRecordingsLoading(true);
    setRecordingsPanelOpen(true);
    try {
      let res: { data: unknown };
      if (rcConfigured) {
        // Server has JWT credentials — no user token needed
        res = await api.get(`/cases/${caseId}/calls/rc-recordings`);
      } else {
        // Fall back to manual user token
        const token = rcToken.trim();
        if (!token) {
          setRcRecordingsLoading(false);
          setRcTokenPanelOpen(true);
          toast.info("RC token required", { description: "Paste your Bearer token below." });
          return;
        }
        res = await api.get(`/cases/${caseId}/calls/rc-recordings-token`, { params: { rcToken: token } });
      }
      const recordings = (res.data as { recordings: RcRecording[] }).recordings;
      if (recordings.length === 0) {
        toast.info("No recordings found", { description: "No calls with recordings in your RC account." });
      } else {
        setRcRecordings(recordings);
        setRcTokenPanelOpen(false);
        toast.success(rcViewMode === "latest" ? "Latest call loaded" : `${recordings.length} call${recordings.length === 1 ? "" : "s"} loaded`);
      }
    } catch (err: unknown) {
      const status = (err as any)?.response?.status;
      const needsConnect = (err as any)?.response?.data?.needsRcConnect;
      if (status === 403 && needsConnect) {
        setRcUserConnected(false);
        toast.error("Connect your RingCentral account first", { description: "Click 'Connect RingCentral' so your own recordings show here." });
      } else if (status === 403) {
        setRcToken("");
        localStorage.removeItem("rc-access-token");
        setRcTokenPanelOpen(true);
        toast.error("RC token expired — paste a fresh one from DevTools");
      } else {
        toast.error("Failed to load recordings", { description: (err as any)?.response?.data?.error ?? (err as Error).message });
      }
    } finally {
      setRcRecordingsLoading(false);
    }
  };

  // ── WorkDrive: list MP3s already saved in the folder ────────────────────
  // Backend caches the response per folder for 60s to avoid Zoho's F7008
  // burst-rate-limit. Pass `fresh: true` to bypass the cache when the user
  // explicitly clicks "Refresh".
  const fetchWorkDriveFiles = async (opts: { fresh?: boolean } = {}) => {
    setWdLoading(true);
    try {
      const url = opts.fresh
        ? `/cases/${caseId}/calls/workdrive-recordings?fresh=1`
        : `/cases/${caseId}/calls/workdrive-recordings`;
      const res = await api.get(url);
      const files = (res.data as { files: WorkDriveFile[] }).files ?? [];
      // Show newest first
      // Sort on the numeric timestamp — the display string sorts
      // alphabetically ("Aug" before "Jul"), which is not chronological.
      files.sort((a, b) => (b.createdTimeMs ?? 0) - (a.createdTimeMs ?? 0));
      setWdFiles(files);
    } catch (err: unknown) {
      const status = (err as any)?.response?.status;
      const body = (err as any)?.response?.data;
      // Friendlier messages for the two known failure modes — Zoho rate
      // limit (transient, just wait) and missing per-client folder ID
      // (data hygiene issue, needs CRM fix).
      if (status === 429) {
        toast.error("Zoho is rate-limiting WorkDrive — try Refresh in about a minute.");
      } else if (status === 422 && body?.code === "FOLDER_FIELD_EMPTY") {
        toast.error("No WorkDrive folder set on this client's Zoho Contact", {
          description: "Set Client_Record_Folder_ID on the Contact and click Refresh.",
        });
      } else {
        toast.error("Failed to load WorkDrive files", { description: body?.error ?? (err as Error).message });
      }
    } finally {
      setWdLoading(false);
    }
  };

  // Auto-load WorkDrive files when the panel opens (no-op if already loaded)
  useEffect(() => {
    if (wdPanelOpen && wdFiles.length === 0 && !wdLoading) {
      void fetchWorkDriveFiles();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wdPanelOpen]);

  // ── Play a WorkDrive file ───────────────────────────────────────────────
  const playWorkDriveFile = async (file: WorkDriveFile) => {
    try {
      const r = await api.get(`/cases/${caseId}/calls/workdrive-audio`, {
        params: { fileId: file.id },
        responseType: "blob",
      });
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast.error("Could not load audio");
    }
  };

  // ── Transcribe a WorkDrive file ─────────────────────────────────────────
  const transcribeWorkDriveFile = async (file: WorkDriveFile) => {
    // Palindrome path: async, so hand off and let the poller finish.
    if (palEnabled) {
      setWdTranscribingId(file.id);
      const ok = await submitToPalindrome({ workdriveFileId: file.id, fileName: file.name });
      setWdTranscribingId(null);
      if (ok) return;
      // Fall through to Azure Speech if the submission was rejected.
    }

    setWdTranscribingId(file.id);
    const t = toast.loading("Transcribing with Azure Whisper…");
    try {
      const res = await api.post(`/cases/${caseId}/calls/workdrive-transcribe`, {
        fileId: file.id,
        filename: file.name,
      });
      const { transcript: text, error } = res.data as { transcript: string | null; error?: string };
      if (text) {
        setTranscript(text);
        setPhase("ended");
        toast.success("Transcript ready", { id: t, description: "Review and click Analyse." });
      } else if (error?.includes("not configured")) {
        toast.warning("Azure Whisper not configured", { id: t, description: "Ask admin to set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env." });
      } else {
        toast.warning("Transcription failed", { id: t, description: error ?? "Paste manually." });
      }
    } catch (err: unknown) {
      toast.error("Transcription failed", { id: t, description: (err as any)?.response?.data?.error ?? (err as Error).message });
    } finally {
      setWdTranscribingId(null);
    }
  };

  // Transcribe a recording via Azure Whisper (backend downloads MP3 + sends to Whisper)
  const handleUseRecording = async (rec: RcRecording) => {
    setFetchingTranscriptFor(rec.sessionId);

    // ── Palindrome path ────────────────────────────────────────────────────
    // Pulls the audio from RingCentral, files it in the client's WorkDrive
    // folder and transcribes it. Async, unlike Azure Speech below, so we hand
    // off to the poller and return.
    if (palEnabled && rec.contentUri && (rcConfigured || rcToken.trim())) {
      const ok = await submitToPalindrome({
        contentUri: rec.contentUri,
        fileName: rcRecordingFileName(rec),
      });
      setSessionId(rec.sessionId);
      setFetchingTranscriptFor(null);
      if (ok) {
        setPhase("ended");
        return;
      }
      // Submission rejected — fall through to Azure Speech.
      setFetchingTranscriptFor(rec.sessionId);
    }

    // ── Path A: We have the audio file URL — use Azure Whisper ──────────────
    if (rec.contentUri && (rcConfigured || rcToken.trim())) {
      const t = toast.loading("Transcribing with Azure Whisper…");
      try {
        const res = rcConfigured
          ? await api.post(`/cases/${caseId}/calls/rc-transcribe`, { contentUri: rec.contentUri })
          : await api.post(`/cases/${caseId}/calls/rc-transcribe-recording`, { contentUri: rec.contentUri, rcToken: rcToken.trim() });
        const { transcript: text, error } = res.data as { transcript: string | null; error?: string };
        if (text) {
          setTranscript(text);
          setSessionId(rec.sessionId);
          setPhase("ended");
          setRcTranscriptStatus("done");
          toast.success("Transcript ready", { id: t, description: "Review and click Analyse." });
        } else {
          // Azure not configured — tell the user clearly, don't try RC AI STT
          toast.warning("Azure Whisper not configured", {
            id: t,
            description: error?.includes("not configured")
              ? "Ask your admin to set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env — then transcription will be automatic."
              : (error ?? "Transcription failed — paste the transcript manually."),
          });
        }
      } catch {
        toast.error("Transcription failed", { id: t, description: "Paste the transcript manually below." });
      } finally {
        setFetchingTranscriptFor(null);
      }
      return;
    }

    // ── Path B: No audio URL — fall back to RC AI STT by session ID ──────────
    const t = toast.loading("Fetching transcript from RingCentral…");
    try {
      const res = await api.get(`/cases/${caseId}/calls/rc-transcript`, {
        params: { telephonySessionId: rec.sessionId },
      });
      const { transcript: text, hasRecording, jobPending } = res.data as {
        transcript: string | null;
        hasRecording: boolean;
        jobPending: boolean;
      };
      if (text) {
        setTranscript(text);
        setSessionId(rec.sessionId);
        setPhase("ended");
        setRcTranscriptStatus("done");
        toast.success("Transcript loaded", { id: t, description: "Review and click Analyse." });
      } else if (jobPending) {
        toast.info("Still transcribing", { id: t, description: "RC is processing. Wait ~30s and try again." });
      } else if (hasRecording) {
        toast.warning("No AI transcript available", {
          id: t,
          description: "Configure Azure Whisper in .env, or paste the transcript manually.",
        });
      } else {
        toast.info("No recording yet", { id: t, description: "Wait a moment and try again, or paste manually." });
      }
    } catch {
      toast.error("Failed to fetch transcript", { id: t, description: "Paste the transcript manually." });
    } finally {
      setFetchingTranscriptFor(null);
    }
  };

  // ── Script generation ─────────────────────────────────────────────────
  //
  // AbortSignal support: the auto-generate effect passes a signal that
  // aborts if a new invocation supersedes it (missingFields.length
  // changes mid-flight, or the component unmounts). Without this, a
  // slow AI response from an EARLIER call could arrive and overwrite
  // the correct script for the LATEST state — which is exactly the
  // "3-5 seconds later the script changes" bug users saw on Stage 5.
  const generateScript = async (opts?: { signal?: AbortSignal }) => {
    if (totalQuestions === 0) return;
    setScriptLoading(true);
    setScriptError(null);
    try {
      const res = await api.post(
        `/cases/${caseId}/calls/script`,
        {
          missingFields,
          reviewFields,
          clientName,
          providerName,
          planNumber,
          planType,
          providerPhone: selectedPhone || undefined,
        },
        { signal: opts?.signal },
      );
      // Skip commit if this call was superseded — otherwise a stale
      // response would overwrite the newer one.
      if (opts?.signal?.aborted) return;
      setScript((res.data as any).script as CallScript);
    } catch (e: any) {
      // Axios reports aborted requests as either e.name === "CanceledError"
      // or e.code === "ERR_CANCELED". Treat cancellation as a no-op
      // (the newer call owns the UI state now).
      if (
        e?.name === "CanceledError" ||
        e?.code === "ERR_CANCELED" ||
        opts?.signal?.aborted
      ) {
        return;
      }
      const msg = e?.response?.data?.error ?? e?.message ?? "Failed to generate script";
      setScriptError(msg);
      toast.error("Script generation failed", { description: msg });
    } finally {
      if (!opts?.signal?.aborted) setScriptLoading(false);
    }
  };

  // ── Start call — via RC Embeddable widget (or demo fallback) ─────────
  const handleStartCall = () => {
    if (!selectedPhone.trim()) {
      toast.error("Select a provider phone number to dial");
      return;
    }

    const number = selectedPhone.trim();
    // Show the widget (remove the CSS hide rule), then navigate to dialer and dial.
    document.getElementById("rc-hide-style")?.remove();
    window.postMessage({ type: "rc-adapter-navigate-to", path: "/dialer" }, "*");
    window.postMessage(
      { type: "rc-adapter-auto-populate-dial-numbers", dialNumbers: [{ phoneNumber: number }] },
      "*"
    );
    window.postMessage({ type: "rc-adapter-new-call", phoneNumber: number, toCall: true }, "*");
    setElapsedSec(0);
    setRcTranscriptStatus("idle");
    if (!rcLoggedIn) {
      toast.info("Sign in to RingCentral", {
        description: "Sign in via the widget (bottom-right), then click Start call again.",
      });
    }
  };

  // ── End / cancel call ─────────────────────────────────────────────────
  const handleEndCall = () => {
    if (rcConfigured && sessionId) {
      // Ask the widget to hang up; rc-call-end-notify will fire and handle state.
      window.postMessage(
        { type: "rc-adapter-control-call", callAction: "hangup", telephonySessionId: sessionId },
        "*"
      );
      return;
    }
    // Demo / non-widget fallback
    setPhase("ended");
    toast.info("Call ended", { description: "Paste or review the transcript below, then click Analyse." });
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
    <div className="space-y-4">
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

        <div className="p-3 space-y-3 max-h-[720px] overflow-y-auto">
          {totalQuestions === 0 ? (
            <p className="text-xs text-muted-foreground italic text-center py-6">
              No outstanding fields — checklist is complete, no call needed.
            </p>
          ) : (
            <>
              {/* Editable outstanding fields — type answers straight in as
                 the provider dictates them during the call. Saves route
                 through the same PATCH used elsewhere, tagged
                 source: "CALL_EDIT" so the audit trail marks them as
                 call-time edits (visible on Stage 7 audit view). */}
              {missingFields.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-destructive font-semibold mb-1.5">
                    Missing ({missingFields.length})
                  </p>
                  <div className="divide-y divide-border/60">
                    {missingFields.map((f) => (
                      <CallEditableField
                        key={f.key}
                        fieldKey={f.key}
                        label={f.label}
                        section={f.section}
                        type={f.type}
                        options={f.options}
                        currentValue=""
                        leading={<AlertCircle className="h-3 w-3 text-destructive" />}
                        disabled={f.key === "__fund_details__"}
                        onSave={async (v) =>
                          updateField(
                            f.key,
                            { value: v || null },
                            { source: "CALL_EDIT" },
                          )
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
              {reviewFields.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-yellow-600 font-semibold mb-1.5 mt-2">
                    To verify ({reviewFields.length})
                  </p>
                  <div className="divide-y divide-border/60">
                    {reviewFields.map((f) => (
                      <CallEditableField
                        key={f.key}
                        fieldKey={f.key}
                        label={f.label}
                        section={f.section}
                        type={f.type}
                        options={f.options}
                        currentValue={f.value}
                        leading={<AlertCircle className="h-3 w-3 text-yellow-600" />}
                        trailing={
                          <Badge
                            variant="outline"
                            className="text-[9px] px-1 h-4 font-normal"
                          >
                            {f.confidence}
                          </Badge>
                        }
                        disabled={f.key === "__fund_details__"}
                        onSave={async (v) =>
                          updateField(
                            f.key,
                            { value: v || null },
                            { source: "CALL_EDIT" },
                          )
                        }
                      />
                    ))}
                  </div>
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
              onClick={() => {
                // Manual regenerate — bypass the auto-effect's signature
                // dedupe by clearing it, so a follow-up auto-run (if any)
                // won't skip. No abort signal here: this is the intended
                // final call once the CA presses the button.
                autoScriptSig.current = null;
                void generateScript();
              }}
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
            {/* Provider selector + phone numbers */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Provider
                </p>
                {rcConfigured && agentPhone && (
                  <span className="text-[10px] text-muted-foreground">calling from {agentPhone}</span>
                )}
              </div>
              <select
                value={selectedProviderId}
                onChange={(e) => {
                  const pid = e.target.value;
                  setSelectedProviderId(pid);
                  const prov = providers.find((p) => p.id === pid);
                  setSelectedPhone(prov?.phone_main || "");
                }}
                disabled={isCallActive || providers.length === 0}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 cursor-pointer"
              >
                <option value="">
                  {providers.length === 0 ? "Loading providers…" : "— Select provider —"}
                </option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              {/* Phone number cards for selected provider */}
              {activeProvider && (activeProvider.phone_main || activeProvider.phone_ceding_dept) ? (
                <div className="flex flex-col gap-1.5 pt-0.5">
                  {(["phone_main", "phone_ceding_dept"] as const).map((field) => {
                    const number = activeProvider[field];
                    if (!number) return null;
                    const label = field === "phone_main" ? "Main" : "Ceding Dept";
                    return (
                      <div
                        key={field}
                        role="button"
                        tabIndex={0}
                        onClick={() => !isCallActive && setSelectedPhone(number)}
                        onKeyDown={(e) => e.key === "Enter" && !isCallActive && setSelectedPhone(number)}
                        className={`flex items-center justify-between px-3 py-2 rounded-md border transition-colors select-none ${
                          isCallActive ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                        } ${
                          selectedPhone === number
                            ? "border-primary/60 bg-primary/5"
                            : "border-border bg-background hover:border-primary/30"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <div>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider leading-none mb-0.5">
                              {label}
                            </p>
                            <p className="text-sm font-mono font-medium text-foreground">{number}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void navigator.clipboard
                              .writeText(number)
                              .then(() => toast.success("Copied to clipboard"));
                          }}
                          className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : activeProvider ? (
                <p className="text-xs text-muted-foreground italic pt-0.5">
                  No phone numbers on file for {activeProvider.name}.
                </p>
              ) : null}
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
                  {rcConfigured
                    ? rcLoggedIn
                      ? "Dial via RingCentral"
                      : "Start call (sign in to RC widget)"
                    : "Start call (demo)"}
                </Button>
              ) : (
                <Button size="sm" variant="destructive" onClick={handleEndCall}>
                  <PhoneOff className="h-3.5 w-3.5 mr-1.5" />
                  End call
                </Button>
              )}

              {/* Open RC dialpad — for manual calls where the provider isn't in the directory */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  document.getElementById("rc-hide-style")?.remove();
                  window.postMessage({ type: "rc-adapter-navigate-to", path: "/dialer" }, "*");
                }}
                title="Open the RC dialpad to manually enter a number"
              >
                <Phone className="h-3.5 w-3.5 mr-1.5" />
                Open dialpad
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

            {rcTranscriptStatus === "fetching" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Fetching transcript from RingCentral…
              </div>
            )}

            {/* Palindrome runs asynchronously (2–3 min) rather than returning
                inline like Azure Speech did, so the Transcribe buttons need a
                progress line — otherwise the CA clicks and nothing appears to
                happen for minutes. */}
            {palPhase === "waiting" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Transcribing with Palindrome — usually 2–3 minutes
                {palWaitedSec > 0 && ` · ${Math.floor(palWaitedSec / 60)}m ${palWaitedSec % 60}s`}
                {palMessage && ` · ${palMessage}`}
              </div>
            )}
            {palPhase === "failed" && (
              <div className="text-xs text-destructive py-1">
                {palMessage ?? "Transcription failed."} You can paste the transcript manually below.
              </div>
            )}

            {/* Transcripts already stored for this case. Shown whenever the
                editor is empty or holds something different, so a transcript
                that arrived while the CA was elsewhere is never stranded. */}
            {storedTranscripts.length > 1 && palPhase !== "waiting" && (
              <details className="rounded-md border border-border bg-muted/40 p-2.5">
                <summary className="flex items-center gap-1.5 cursor-pointer list-none">
                  <FileText className="h-3.5 w-3.5 text-primary" />
                  <span className="text-xs font-medium">
                    {storedTranscripts.length - 1} earlier transcript
                    {storedTranscripts.length > 2 ? "s" : ""} for this case
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      void refreshStoredTranscripts();
                    }}
                    title="Refresh"
                    className="ml-auto text-muted-foreground hover:text-foreground"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                </summary>
                <ul className="space-y-1 mt-2">
                  {/* Skip index 0 — that one is already in the editor. */}
                  {storedTranscripts.slice(1, 6).map((t) => (
                    <li key={t.id} className="flex items-center gap-2 text-[11px]">
                      <span className="text-muted-foreground">
                        {new Date(t.completedAt ?? t.createdAt).toLocaleString(undefined, {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <Badge variant="outline" className="h-4 px-1 text-[9px]">
                        {t.source}
                      </Badge>
                      <span className="text-muted-foreground">
                        {t.chars.toLocaleString()} chars
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[10px] ml-auto"
                        onClick={() => void loadStoredTranscript(t.id)}
                      >
                        Load into editor
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {/* A newer transcript arrived but the editor holds hand-entered
                text, so we ask rather than overwrite it. */}
            {newerTranscriptId && (
              <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-[11px]">
                <Sparkles className="h-3 w-3 text-primary shrink-0" />
                <span>A newer transcript has arrived for this case.</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px] ml-auto"
                  onClick={() => {
                    void loadStoredTranscript(newerTranscriptId);
                    setNewerTranscriptId(null);
                  }}
                >
                  Load it
                </Button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setNewerTranscriptId(null)}
                  title="Dismiss"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Say which transcript is in the editor. Without this the CA
                cannot tell whether they are looking at the call they just
                made, one loaded from the list, or something they pasted. */}
            {(() => {
              const loaded = storedTranscripts.find((t) => t.id === palTranscriptId);
              if (loaded) {
                return (
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                    <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
                    <span>
                      Showing transcript from{" "}
                      <strong className="text-foreground">
                        {new Date(loaded.completedAt ?? loaded.createdAt).toLocaleString(undefined, {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </strong>
                    </span>
                    <Badge variant="outline" className="h-4 px-1 text-[9px]">
                      {loaded.source}
                    </Badge>
                    <span>{loaded.chars.toLocaleString()} chars</span>
                  </div>
                );
              }
              if (transcript.trim()) {
                return (
                  <div className="text-[11px] text-muted-foreground">
                    Showing a manually entered transcript — not saved against this case.
                  </div>
                );
              }
              return null;
            })()}

            <Textarea
              value={transcript}
              onChange={(e) => {
                setTranscript(e.target.value);
                // Once edited by hand it is no longer that stored transcript.
                if (palTranscriptId) setPalTranscriptId(null);
              }}
              placeholder={
                rcLoggedIn
                  ? "Transcript will appear here automatically after the call ends.\nYou can also paste or edit it manually."
                  : "Paste the call transcript here, then click 'Analyse & propose updates'."
              }
              className="min-h-[180px] text-xs font-mono"
              disabled={phase === "dialling" || rcTranscriptStatus === "fetching"}
            />

            <div className="flex items-center justify-between gap-2 flex-wrap">
              {rcLoggedIn && rcTranscriptStatus === "idle" && phase !== "ended" && (
                <p className="text-[10px] text-muted-foreground">
                  <span className="text-success font-medium">● Connected</span> — transcript fetched
                  automatically from RingCentral after hang-up.
                </p>
              )}
              {rcTranscriptStatus === "done" && (
                <p className="text-[10px] text-success font-medium">
                  ✓ Transcript generated from recording
                </p>
              )}
              {/* Show fetch button if RC widget is logged in and we have a session ID,
                  regardless of whether the call was started via our button */}
              {rcLoggedIn && sessionId && rcTranscriptStatus !== "fetching" && rcTranscriptStatus !== "done" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => void fetchRcTranscript(sessionId)}
                >
                  <RefreshCw className="h-3 w-3 mr-1.5" />
                  Fetch transcript from RC
                </Button>
              )}
              {/* Fallback: RC logged in but no session yet — prompt user to make a call */}
              {rcLoggedIn && !sessionId && phase === "ended" && (
                <p className="text-[10px] text-muted-foreground">
                  No RC session captured — paste the transcript manually above.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>{/* end grid */}

    {/* ── RC Recordings panel ─── */}
    <div className="rounded-md border border-border bg-card overflow-hidden">
        <div
          className="px-3 py-2 border-b border-border bg-muted/40 flex items-center justify-between cursor-pointer"
          onClick={() => setRecordingsPanelOpen((v) => !v)}
        >
          <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground flex items-center gap-1.5">
            <PhoneCall className="h-3.5 w-3.5 text-primary" />
            RC Recordings
            <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
              ({rcViewMode === "latest" ? "latest call" : `all calls${rcRecordings.length > 0 ? " · " + rcRecordings.length : ""}`})
            </span>
          </h4>
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {rcUserConnected ? (
              <span className="flex items-center gap-1.5 text-[10px] text-success font-semibold normal-case tracking-normal" title={rcUserName ? `Connected as ${rcUserName}` : "Connected"}>
                <Wifi className="h-3 w-3" />
                {rcUserName ? rcUserName.split(" ")[0] : "Connected"}
                <button
                  type="button"
                  onClick={() => void disconnectRingCentral()}
                  className="ml-0.5 text-[9px] text-muted-foreground hover:text-overdue underline"
                  title="Disconnect RingCentral"
                >
                  disconnect
                </button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={rcConnecting}
                onClick={() => void connectRingCentral()}
              >
                {rcConnecting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Wifi className="h-3 w-3 mr-1" />}
                Connect RingCentral
              </Button>
            )}
            <select
              value={rcViewMode}
              onChange={(e) => setRcViewMode(e.target.value as "latest" | "all")}
              className="h-7 text-xs px-2 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
              title="Choose how many recordings to show"
            >
              <option value="latest">Latest call</option>
              <option value="all">All calls</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={rcRecordingsLoading || !rcUserConnected}
              onClick={() => void fetchRcRecordings()}
              title={rcUserConnected ? "Load your RC recordings" : "Connect RingCentral first"}
            >
              {rcRecordingsLoading ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Load Recordings
            </Button>
            <ChevronRight
              className={`h-3.5 w-3.5 text-muted-foreground transition-transform cursor-pointer ${recordingsPanelOpen ? "rotate-90" : ""}`}
              onClick={() => setRecordingsPanelOpen((v) => !v)}
            />
          </div>
        </div>

        {recordingsPanelOpen && (
          <div className="p-3 space-y-3">
            {/* Token status / input — only shown when server JWT is not configured */}
            {!rcConfigured && (
              rcToken && !rcTokenPanelOpen ? (
                <div className="flex items-center justify-between px-3 py-1.5 rounded-md border border-border bg-muted/20">
                  <span className="text-[11px] text-success font-semibold">● RC token saved</span>
                  <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground underline" onClick={() => setRcTokenPanelOpen(true)}>
                    Change
                  </button>
                </div>
              ) : rcTokenPanelOpen ? (
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={rcToken}
                    onChange={(e) => setRcToken(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && rcToken.trim()) { setRcTokenPanelOpen(false); void fetchRcRecordings(); } }}
                    placeholder="Paste RC Bearer token (DevTools → Network → any platform.ringcentral.com request → Authorization header)"
                    className="flex-1 px-3 py-1.5 text-xs rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                    autoFocus
                  />
                  <Button size="sm" className="h-7 text-xs shrink-0" disabled={!rcToken.trim()} onClick={() => { setRcTokenPanelOpen(false); void fetchRcRecordings(); }}>
                    Load
                  </Button>
                </div>
              ) : null
            )}

            {/* Manual session ID fallback */}
            {/* <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Or fetch by session ID</p>
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  value={manualSessionId}
                  onChange={(e) => setManualSessionId(e.target.value)}
                  placeholder="Paste RC telephony session ID…"
                  className="flex-1 px-3 py-1.5 text-xs rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs shrink-0"
                  disabled={!manualSessionId.trim() || fetchingTranscriptFor === manualSessionId}
                  onClick={() => {
                    const sid = manualSessionId.trim();
                    setSessionId(sid);
                    setFetchingTranscriptFor(sid);
                    void handleUseRecording({ id: sid, sessionId: sid, startTime: "", duration: 0, direction: "Outbound", from: { phoneNumber: "" }, to: { phoneNumber: "" }, hasRecording: true });
                  }}
                >
                  {fetchingTranscriptFor === manualSessionId ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <FileText className="h-3 w-3 mr-1" />
                  )}
                  Fetch transcript
                </Button>
              </div>
            </div> */}

            {rcRecordingsLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Loading recordings from RingCentral…
              </div>
            )}
            {rcRecordings.length > 0 && (
              <ul className={`space-y-1.5 ${rcViewMode === "all" ? "max-h-[320px] overflow-y-auto" : ""}`}>
                <li className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold pb-0.5">
                  {rcViewMode === "latest" ? "Most recent call" : `All calls (${rcRecordings.length})`}
                </li>
                {(rcViewMode === "latest" ? rcRecordings.slice(0, 1) : rcRecordings).map((rec) => {
                  const dt = new Date(rec.startTime);
                  const dateStr = dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
                  const timeStr = dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                  const mins = Math.floor(rec.duration / 60);
                  const secs = rec.duration % 60;
                  const durStr = `${mins}:${String(secs).padStart(2, "0")}`;
                  const isFetching = fetchingTranscriptFor === rec.sessionId;
                  const callerLabel = rec.direction === "Outbound"
                    ? rec.to.name || rec.to.phoneNumber
                    : rec.from.name || rec.from.phoneNumber;

                  return (
                    <li
                      key={rec.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-border bg-background hover:border-primary/30 transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{callerLabel}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {dateStr} · {timeStr} · {durStr}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {/* Play audio — proxied through backend so RC token is never exposed */}
                        {rec.contentUri && (rcConfigured || rcToken) && (
                          <button
                            type="button"
                            title="Play recording in browser"
                            onClick={async () => {
                              try {
                                const params = rcConfigured
                                  ? { contentUri: rec.contentUri }
                                  : { contentUri: rec.contentUri, rcToken: rcToken.trim() };
                                const r = await api.get(`/cases/${caseId}/calls/rc-recording-audio`, { params, responseType: "blob" });
                                const url = URL.createObjectURL(r.data as Blob);
                                const a = document.createElement("a");
                                a.href = url; a.target = "_blank"; a.rel = "noopener"; a.click();
                                setTimeout(() => URL.revokeObjectURL(url), 60_000);
                              } catch {
                                toast.error("Could not load audio");
                              }
                            }}
                            className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <Volume2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {/* Save recording to Zoho WorkDrive */}
                        {rec.contentUri && (rcConfigured || rcToken) && (
                          <button
                            type="button"
                            title="Save recording to Zoho WorkDrive"
                            onClick={async () => {
                              const t = toast.loading("Uploading to WorkDrive…");
                              try {
                                // Build a human-readable filename: Provider_Client_YYYY-MM-DD_HH-MM.mp3
                                const sanitize = (s: string) => (s || "").trim().replace(/[\s\/\\:*?"<>|]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
                                const dt = new Date(rec.startTime || Date.now());
                                const pad = (n: number) => String(n).padStart(2, "0");
                                const datePart = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}_${pad(dt.getHours())}-${pad(dt.getMinutes())}`;
                                const provider = sanitize(providerName) || "Provider";
                                const client = sanitize(clientName) || "Client";
                                const fileName = `${provider}_${client}_${datePart}.mp3`;
                                const body = rcConfigured
                                  ? { contentUri: rec.contentUri, fileName }
                                  : { contentUri: rec.contentUri, fileName, rcToken: rcToken.trim() };
                                const r = await api.post(`/cases/${caseId}/calls/upload-recording-to-workdrive`, body);
                                const file = (r.data as { file?: { name: string; permalink?: string } }).file;
                                toast.success("Saved to WorkDrive", {
                                  id: t,
                                  description: file?.permalink ? `${file.name} — open in WorkDrive` : file?.name,
                                  action: file?.permalink ? { label: "Open", onClick: () => window.open(file.permalink, "_blank") } : undefined,
                                });
                              } catch (err: unknown) {
                                const d = (err as any)?.response?.data ?? {};
                                console.error("[workdrive upload error]", d);
                                toast.error("WorkDrive upload failed", {
                                  id: t,
                                  description: `${d.zohoStatus ?? ""} ${d.zohoError ?? d.error ?? (err as Error).message}`.trim(),
                                });
                              }
                            }}
                            className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <CloudUpload className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={isFetching}
                          onClick={() => void handleUseRecording(rec)}
                          title="Transcribe with Azure Whisper and load into editor"
                        >
                          {isFetching ? (
                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          ) : (
                            <FileText className="h-3 w-3 mr-1" />
                          )}
                          {isFetching ? "Transcribing…" : "Transcribe"}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ── WorkDrive Recordings panel — calls already saved to Zoho WorkDrive ── */}
      <div className="rounded-md border border-border bg-card overflow-hidden mt-3">
        <div
          className="px-3 py-2 border-b border-border bg-muted/40 flex items-center justify-between cursor-pointer"
          onClick={() => setWdPanelOpen((v) => !v)}
        >
          <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground flex items-center gap-1.5">
            <CloudUpload className="h-3.5 w-3.5 text-primary" />
            WorkDrive Recordings
            {wdFiles.length > 0 && (
              <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                ({wdFiles.length})
              </span>
            )}
          </h4>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={wdLoading}
              onClick={(e) => {
                e.stopPropagation();
                // Refresh button bypasses the backend's 60s cache.
                void fetchWorkDriveFiles({ fresh: true });
              }}
            >
              {wdLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              Refresh
            </Button>
            <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${wdPanelOpen ? "rotate-90" : ""}`} />
          </div>
        </div>

        {wdPanelOpen && (
          <div className="p-3">
            {wdLoading && wdFiles.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Loading saved recordings from WorkDrive…
              </div>
            )}
            {!wdLoading && wdFiles.length === 0 && (
              <p className="text-xs text-muted-foreground">No recordings saved yet. Click ☁ on an RC recording to save it here.</p>
            )}
            {wdFiles.length > 0 && (
              <ul className="space-y-1.5 max-h-[320px] overflow-y-auto">
                {wdFiles.map((file) => {
                  // Use the epoch-millisecond field, never createdTime.
                  // WorkDrive sends createdTime as a display string like
                  // "Aug 19, 16:01", and new Date() reads the "19" as a YEAR —
                  // every file then renders as 2001. Fall back to the string
                  // only when the millisecond field is absent.
                  const dt = file.createdTimeMs
                    ? new Date(file.createdTimeMs)
                    : null;
                  const dateStr = dt ? dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : (file.createdTime ?? "");
                  const timeStr = dt ? dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
                  const sizeKb =
                    typeof file.sizeBytes === "number" && Number.isFinite(file.sizeBytes)
                      ? `${Math.round(file.sizeBytes / 1024).toLocaleString()} KB`
                      : "";
                  const isTranscribing = wdTranscribingId === file.id;
                  return (
                    <li
                      key={file.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-border bg-background hover:border-primary/30 transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground truncate" title={file.name}>{file.name.replace(/\.mp3$/i, "")}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {[dateStr, timeStr, sizeKb].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          title="Play recording"
                          onClick={() => void playWorkDriveFile(file)}
                          className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Volume2 className="h-3.5 w-3.5" />
                        </button>
                        {file.permalink && (
                          <button
                            type="button"
                            title="Open in WorkDrive"
                            onClick={() => window.open(file.permalink, "_blank")}
                            className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <CloudUpload className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={isTranscribing}
                          onClick={() => void transcribeWorkDriveFile(file)}
                          title="Transcribe with Azure Whisper"
                        >
                          {isTranscribing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <FileText className="h-3 w-3 mr-1" />}
                          {isTranscribing ? "Transcribing…" : "Transcribe"}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
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
