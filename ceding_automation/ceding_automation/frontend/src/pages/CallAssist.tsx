import { SectionHeader } from "@/components/shared/StatusComponents";
import { Phone, FileText, Cpu, CheckCircle, Clock, Mic, Plus, Loader2, MessageSquareText, Send, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Tables } from "@/integrations/supabase/types";

type CallLog = Tables<"call_logs">;
type CaseRow = Tables<"cases">;

const CallAssist = () => {
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [showNewLog, setShowNewLog] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // New log form
  const [newCaseId, setNewCaseId] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newDuration, setNewDuration] = useState("");
  const [newTranscript, setNewTranscript] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [savingLog, setSavingLog] = useState(false);

  // AI Q&A
  const [question, setQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  // Transcript edit
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [editTranscriptValue, setEditTranscriptValue] = useState("");

  const fetchCallLogs = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("call_logs")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setCallLogs(data);
    setLoading(false);
  }, []);

  const fetchCases = useCallback(async () => {
    const { data } = await supabase
      .from("cases")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setCases(data);
  }, []);

  useEffect(() => {
    fetchCallLogs();
    fetchCases();
  }, [fetchCallLogs, fetchCases]);

  const selectedLog = callLogs.find(l => l.id === selectedLogId);
  const selectedCase = selectedLog?.case_id ? cases.find(c => c.id === selectedLog.case_id) : null;

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Save new call log
  const handleSaveLog = async () => {
    const user = (await supabase.auth.getUser()).data.user;
    if (!user) { toast.error("Please log in first"); return; }
    if (!newPhone.trim()) { toast.error("Phone number is required"); return; }

    setSavingLog(true);
    const theCase = cases.find(c => c.id === newCaseId);

    const { data, error } = await supabase.from("call_logs").insert({
      user_id: user.id,
      case_id: newCaseId || null,
      provider_name: theCase?.provider_name || "Unknown",
      department: null,
      phone_number: newPhone.trim(),
      plan_number: theCase?.plan_number || null,
      client_name: theCase?.client_name || null,
      duration_seconds: newDuration ? parseInt(newDuration) * 60 : null,
      transcript: newTranscript.trim() || null,
      notes: newNotes.trim() || null,
      status: "completed",
    }).select().single();

    if (error) {
      toast.error("Failed to save call log");
    } else if (data) {
      toast.success("Call log saved");
      setCallLogs(prev => [data, ...prev]);
      setSelectedLogId(data.id);
      setShowNewLog(false);
      setNewCaseId("");
      setNewPhone("");
      setNewDuration("");
      setNewTranscript("");
      setNewNotes("");
    }
    setSavingLog(false);
  };

  // Update transcript
  const handleSaveTranscript = async () => {
    if (!selectedLog) return;
    const { error } = await supabase
      .from("call_logs")
      .update({ transcript: editTranscriptValue.trim() || null })
      .eq("id", selectedLog.id);
    if (error) {
      toast.error("Failed to update transcript");
    } else {
      toast.success("Transcript updated");
      setCallLogs(prev => prev.map(l => l.id === selectedLog.id ? { ...l, transcript: editTranscriptValue.trim() || null } : l));
      setEditingTranscript(false);
    }
  };

  // AI Q&A on transcript
  const askAI = async () => {
    if (!selectedLog?.transcript || !question.trim()) return;
    setAiLoading(true);
    setAiAnswer(null);
    try {
      const { data, error } = await supabase.functions.invoke("analyze-transcript", {
        body: { transcript: selectedLog.transcript, question: question.trim() },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setAiAnswer(data.answer);
    } catch (e: any) {
      toast.error(e.message || "AI analysis failed");
    } finally {
      setAiLoading(false);
    }
  };

  // Delete log
  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("call_logs").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete");
    } else {
      toast.success("Call log deleted");
      setCallLogs(prev => prev.filter(l => l.id !== id));
      if (selectedLogId === id) setSelectedLogId(null);
    }
  };

  const formatDuration = (secs: number | null) => {
    if (!secs) return "—";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  };

  return (
    <div className="animate-slide-in">
      <SectionHeader
        title="Call Assist"
        subtitle="Call logs, transcripts & AI-powered analysis"
        action={
          <button
            onClick={() => setShowNewLog(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" /> Log a Call
          </button>
        }
      />

      {/* New call log form */}
      {showNewLog && (
        <div className="mb-6 rounded-xl border border-border bg-card p-5 animate-fade-in">
          <h3 className="text-sm font-semibold text-foreground mb-4">New Call Log</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Link to Case (optional)</label>
              <Select value={newCaseId} onValueChange={v => {
                setNewCaseId(v);
                const c = cases.find(cs => cs.id === v);
                if (c) setNewPhone(c.provider_name); // Will be overridden by routing
              }}>
                <SelectTrigger><SelectValue placeholder="Select case…" /></SelectTrigger>
                <SelectContent>
                  {cases.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.client_name} — {c.provider_name} {c.plan_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Phone Number *</label>
              <Input value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="0800 068 6800" className="font-mono" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Duration (minutes)</label>
              <Input value={newDuration} onChange={e => setNewDuration(e.target.value)} placeholder="5" type="number" />
            </div>
          </div>
          <div className="mt-4">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Transcript (paste or type)</label>
            <Textarea
              value={newTranscript}
              onChange={e => setNewTranscript(e.target.value)}
              placeholder="Paste the call transcript here, or type notes line by line…"
              className="min-h-[120px] text-sm"
            />
          </div>
          <div className="mt-3">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Notes</label>
            <Input value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Quick notes about the call…" />
          </div>
          <div className="mt-4 flex gap-2">
            <button
              onClick={handleSaveLog}
              disabled={savingLog}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {savingLog ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              Save Call Log
            </button>
            <button
              onClick={() => setShowNewLog(false)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Call Log List */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="border-b border-border bg-muted/30 px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Phone className="h-4 w-4 text-primary" /> Call History
            </h2>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : callLogs.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <Phone className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No calls logged yet</p>
                <p className="text-xs text-muted-foreground mt-1">Click "Log a Call" to add your first entry</p>
              </div>
            ) : (
              callLogs.map(log => (
                <button
                  key={log.id}
                  onClick={() => { setSelectedLogId(log.id); setAiAnswer(null); setQuestion(""); setEditingTranscript(false); }}
                  className={`w-full text-left px-4 py-3 border-b border-border transition-colors ${
                    selectedLogId === log.id ? "bg-primary/10" : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {log.client_name || log.provider_name}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {log.provider_name} · {log.phone_number}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-muted-foreground">{formatDate(log.created_at)}</p>
                      <div className="flex items-center gap-1 mt-0.5 justify-end">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">{formatDuration(log.duration_seconds)}</span>
                      </div>
                    </div>
                  </div>
                  {log.transcript && (
                    <span className="inline-flex items-center gap-1 mt-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      <FileText className="h-3 w-3" /> Transcript
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Detail + Transcript + AI */}
        <div className="lg:col-span-2 space-y-6">
          {!selectedLog ? (
            <div className="rounded-xl border border-border bg-card p-12 text-center">
              <Mic className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Select a call from the history, or log a new call</p>
            </div>
          ) : (
            <>
              {/* Call details */}
              <div className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">{selectedLog.client_name || selectedLog.provider_name}</h2>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {selectedLog.provider_name}{selectedLog.department && ` — ${selectedLog.department}`} · {selectedLog.phone_number}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(selectedLog.id)}
                    className="rounded p-1.5 text-muted-foreground hover:text-overdue hover:bg-overdue/10 transition-colors"
                    title="Delete call log"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-3 mt-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Date</p>
                    <p className="text-sm font-medium text-foreground">{formatDate(selectedLog.created_at)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Duration</p>
                    <p className="text-sm font-medium text-foreground">{formatDuration(selectedLog.duration_seconds)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Plan</p>
                    <p className="text-sm font-mono font-medium text-foreground">{selectedLog.plan_number || "—"}</p>
                  </div>
                </div>
                {selectedLog.notes && (
                  <div className="mt-3 rounded-lg bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Notes</p>
                    <p className="text-sm text-foreground whitespace-pre-line">{selectedLog.notes}</p>
                  </div>
                )}
              </div>

              {/* Transcript */}
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="border-b border-border bg-muted/30 px-5 py-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" /> Transcript
                  </h3>
                  {!editingTranscript && (
                    <button
                      onClick={() => { setEditingTranscript(true); setEditTranscriptValue(selectedLog.transcript || ""); }}
                      className="text-xs text-primary hover:underline"
                    >
                      {selectedLog.transcript ? "Edit" : "Add transcript"}
                    </button>
                  )}
                </div>
                <div className="p-5">
                  {editingTranscript ? (
                    <div>
                      <Textarea
                        value={editTranscriptValue}
                        onChange={e => setEditTranscriptValue(e.target.value)}
                        placeholder="Paste or type the call transcript…"
                        className="min-h-[200px] text-sm"
                        autoFocus
                      />
                      <div className="flex gap-2 mt-3">
                        <button onClick={handleSaveTranscript} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
                          <CheckCircle className="h-3.5 w-3.5" /> Save
                        </button>
                        <button onClick={() => setEditingTranscript(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : selectedLog.transcript ? (
                    <p className="text-sm text-foreground whitespace-pre-line leading-relaxed max-h-[300px] overflow-y-auto">
                      {selectedLog.transcript}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No transcript available. Click "Add transcript" to paste one.</p>
                  )}
                </div>
              </div>

              {/* AI Q&A on transcript */}
              {selectedLog.transcript && (
                <div className="rounded-xl border border-border bg-card overflow-hidden">
                  <div className="border-b border-border bg-muted/30 px-5 py-3">
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <Cpu className="h-4 w-4 text-primary" /> Ask AI about this call
                    </h3>
                  </div>
                  <div className="p-5">
                    <div className="flex gap-2">
                      <Input
                        value={question}
                        onChange={e => setQuestion(e.target.value)}
                        placeholder="e.g. What was confirmed about drawdown? Did they mention exit charges?"
                        className="text-sm"
                        onKeyDown={e => { if (e.key === "Enter") askAI(); }}
                      />
                      <button
                        onClick={askAI}
                        disabled={aiLoading || !question.trim()}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
                      >
                        {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {["What fields were confirmed?", "Any charges mentioned?", "Summarize the key outcomes", "What was left unresolved?"].map(q => (
                        <button
                          key={q}
                          onClick={() => { setQuestion(q); }}
                          className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted transition-colors"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                    {aiAnswer && (
                      <div className="mt-4 rounded-lg border border-border bg-info/5 p-4 animate-fade-in">
                        <p className="text-xs font-semibold text-primary mb-2 flex items-center gap-1">
                          <MessageSquareText className="h-3.5 w-3.5" /> AI Answer
                        </p>
                        <p className="text-sm text-foreground whitespace-pre-line leading-relaxed">{aiAnswer}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CallAssist;
