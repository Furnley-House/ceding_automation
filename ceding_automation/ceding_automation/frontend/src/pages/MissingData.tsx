import { SectionHeader, ConfidenceBadge, EvidenceBadge } from "@/components/shared/StatusComponents";
import { AlertCircle, CheckCircle, Upload, Loader2, Phone, Sparkles, Copy, Save, X, ExternalLink, Edit3, ChevronDown, ChevronUp, MessageSquareText } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { Tables } from "@/integrations/supabase/types";
import type { Confidence, EvidenceSource } from "@/data/seedData";

type ChecklistRow = Tables<"checklist_fields">;
type CaseRow = Tables<"cases">;
type ProviderRow = Tables<"providers">;

interface RoutingMatch {
  department: string;
  phone: string;
  email?: string;
  planPrefix: string;
}

const RINGCENTRAL_EMBEDDABLE_URL = "https://apps.ringcentral.com/integration/ringcentral-embeddable/latest/adapter.js";

const MissingData = () => {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [fields, setFields] = useState<ChecklistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [script, setScript] = useState<string | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [dialerLoaded, setDialerLoaded] = useState(false);
  const [scriptExpanded, setScriptExpanded] = useState(true);
  const [provider, setProvider] = useState<ProviderRow | null>(null);
  const [routingMatch, setRoutingMatch] = useState<RoutingMatch | null>(null);
  const [callNumber, setCallNumber] = useState("");
  const [showCallPrompt, setShowCallPrompt] = useState(false);
  const [panelPos, setPanelPos] = useState({ x: 0, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  const hasDragged = useRef(false);

  // Initialize panel position to top-right
  useEffect(() => {
    setPanelPos({ x: window.innerWidth - 424, y: 80 });
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    // Don't start drag on action buttons
    if ((e.target as HTMLElement).closest('[role="button"]')) return;
    setIsDragging(true);
    hasDragged.current = false;
    const rect = panelRef.current?.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    hasDragged.current = true;
    const newX = Math.max(0, Math.min(window.innerWidth - 400, e.clientX - dragOffset.current.x));
    const newY = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - dragOffset.current.y));
    setPanelPos({ x: newX, y: newY });
  };

  const onPointerUp = () => {
    setIsDragging(false);
  };

  // Load RingCentral Embeddable widget
  useEffect(() => {
    if (document.getElementById("rc-widget-script")) {
      setDialerLoaded(true);
      return;
    }
    const script = document.createElement("script");
    script.id = "rc-widget-script";
    script.src = `${RINGCENTRAL_EMBEDDABLE_URL}?zIndex=9999`;
    script.async = true;
    script.onload = () => setDialerLoaded(true);
    document.body.appendChild(script);
  }, []);

  const fetchCases = useCallback(async () => {
    const { data } = await supabase
      .from("cases")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setCases(data);
  }, []);

  const fetchFields = useCallback(async (caseId: string) => {
    setLoading(true);
    const { data } = await supabase
      .from("checklist_fields")
      .select("*")
      .eq("case_id", caseId)
      .in("status", ["missing", "needs_review"])
      .order("section", { ascending: true });
    if (data) setFields(data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchCases(); }, [fetchCases]);

  useEffect(() => {
    if (!selectedCaseId && cases.length > 0) {
      const withMissing = cases.find(c => (c.missing_fields_count ?? 0) > 0);
      setSelectedCaseId(withMissing?.id ?? cases[0].id);
    }
  }, [cases, selectedCaseId]);

  // Fetch provider routing when case changes
  useEffect(() => {
    if (selectedCaseId) {
      fetchFields(selectedCaseId);
      setScript(null);
      setRoutingMatch(null);
      setProvider(null);
      setShowCallPrompt(false);

      const theCase = cases.find(c => c.id === selectedCaseId);
      if (theCase?.provider_id) {
        supabase.from("providers").select("*").eq("id", theCase.provider_id).single().then(({ data }) => {
          if (data) {
            setProvider(data);
            matchRouting(data, theCase.plan_number);
          }
        });
      } else if (theCase?.provider_name) {
        // Fallback: match by name
        supabase.from("providers").select("*").ilike("name", `%${theCase.provider_name}%`).limit(1).then(({ data }) => {
          if (data?.[0]) {
            setProvider(data[0]);
            matchRouting(data[0], theCase.plan_number);
          }
        });
      }
    }
  }, [selectedCaseId, fetchFields, cases]);

  const matchRouting = (prov: ProviderRow, planNumber: string) => {
    const rules = prov.routing_rules as any[];
    if (!rules || !Array.isArray(rules)) return;
    // Find the best matching prefix
    const sorted = [...rules].sort((a, b) => (b.planPrefix?.length ?? 0) - (a.planPrefix?.length ?? 0));
    const match = sorted.find(r => planNumber.toUpperCase().startsWith(r.planPrefix?.toUpperCase?.() ?? ""));
    if (match) {
      setRoutingMatch({ department: match.department, phone: match.phone, email: match.email, planPrefix: match.planPrefix });
      setCallNumber(match.phone);
    } else {
      // Fallback to provider general phone
      setCallNumber(prov.phone || "");
    }
  };

  const selectedCase = cases.find(c => c.id === selectedCaseId);
  const missingFields = fields.filter(f => f.status === "missing");
  const reviewFields = fields.filter(f => f.status === "needs_review");

  // ── AI Script (now includes both missing + review fields) ──
  const generateScript = async () => {
    if (missingFields.length === 0 && reviewFields.length === 0) {
      toast.info("No fields to generate a script for");
      return;
    }
    setScriptLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-script", {
        body: {
          fields: missingFields.map(f => ({ label: f.label, section: f.section })),
          reviewFields: reviewFields.map(f => ({ label: f.label, section: f.section, value: f.value, confidence: f.confidence })),
          clientName: selectedCase?.client_name,
          providerName: selectedCase?.provider_name,
          planNumber: selectedCase?.plan_number,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setScript(data.script);
      toast.success("Script generated");
    } catch (e: any) {
      toast.error(e.message || "Failed to generate script");
    } finally {
      setScriptLoading(false);
    }
  };

  // ── Inline edit ──
  const startEdit = (field: ChecklistRow) => {
    setEditingFieldId(field.id);
    setEditValue(field.value ?? "");
  };

  const cancelEdit = () => {
    setEditingFieldId(null);
    setEditValue("");
  };

  const saveEdit = async (field: ChecklistRow) => {
    const val = editValue.trim();
    if (!val) { toast.error("Please enter a value"); return; }
    setSaving(true);
    const user = (await supabase.auth.getUser()).data.user;
    const updates: Partial<ChecklistRow> = {
      value: val,
      status: "complete",
      confidence: "high",
      evidence_source: "call",
      evidence_ref: "Obtained via provider call",
      reviewed_by: user?.id ?? null,
      notes: field.notes ? `${field.notes}\n✅ Value entered: "${val}"` : `✅ Value entered: "${val}"`,
    };
    const { error } = await supabase.from("checklist_fields").update(updates).eq("id", field.id);
    if (error) {
      toast.error("Failed to save");
    } else {
      toast.success(`"${field.label}" updated to "${val}"`);
      setFields(prev => prev.filter(f => f.id !== field.id));
    }
    setSaving(false);
    setEditingFieldId(null);
  };

  // ── Confirm (for review fields) ──
  const handleConfirm = async (field: ChecklistRow) => {
    setConfirmingId(field.id);
    const user = (await supabase.auth.getUser()).data.user;
    const updates: Partial<ChecklistRow> = {
      status: "complete",
      confidence: "high",
      reviewed_by: user?.id ?? null,
      notes: field.notes ? `${field.notes}\n✅ Confirmed via Missing Data` : "✅ Confirmed via Missing Data",
    };
    const { error } = await supabase.from("checklist_fields").update(updates).eq("id", field.id);
    if (error) {
      toast.error("Failed to update");
    } else {
      toast.success(`"${field.label}" confirmed`);
      setFields(prev => prev.filter(f => f.id !== field.id));
    }
    setConfirmingId(null);
  };

  const copyScript = () => {
    if (script) {
      navigator.clipboard.writeText(script);
      toast.success("Script copied to clipboard");
    }
  };

  // Trigger RingCentral dialer or fallback to tel: link
  const handleCall = (phoneNumber?: string) => {
    const number = phoneNumber || callNumber || provider?.phone || "";
    if (!number) {
      toast.error("No phone number available");
      return;
    }
    if (dialerLoaded && (window as any).RCAdapter) {
      (window as any).RCAdapter.clickToCall(number, true);
    } else {
      window.open(`tel:${number}`, "_self");
    }
  };

  const promptAndCall = () => {
    setShowCallPrompt(true);
  };

  return (
    <div className="animate-slide-in">
      <SectionHeader
        title="Missing Data Resolution"
        subtitle={
          selectedCase
            ? `${selectedCase.client_name} — ${selectedCase.provider_name} ${selectedCase.plan_number} · ${missingFields.length} missing, ${reviewFields.length} needs review`
            : "Select a case to resolve missing data"
        }
        action={
          fields.length > 0 ? (
            <button
              onClick={promptAndCall}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Phone className="h-4 w-4" /> Call Provider
            </button>
          ) : undefined
        }
      />

      {/* Case selector */}
      <div className="mb-6">
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Select Case</label>
        <Select value={selectedCaseId ?? ""} onValueChange={id => setSelectedCaseId(id)}>
          <SelectTrigger className="w-full max-w-md">
            <SelectValue placeholder="Choose a case…" />
          </SelectTrigger>
          <SelectContent>
            {cases.map(c => (
              <SelectItem key={c.id} value={c.id}>
                {c.client_name} — {c.provider_name} {c.plan_number}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Call prompt with routing match */}
      {showCallPrompt && (
        <div className="mb-6 rounded-xl border border-border bg-card p-5 animate-fade-in">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Phone className="h-4 w-4 text-primary" />
                {routingMatch
                  ? `${selectedCase?.provider_name} — ${routingMatch.department}`
                  : `${selectedCase?.provider_name ?? "Provider"}`}
              </h3>
              {routingMatch && (
                <p className="text-xs text-muted-foreground mt-1">
                  Matched plan prefix <span className="font-mono font-semibold text-foreground">{routingMatch.planPrefix}</span> from plan {selectedCase?.plan_number}
                  {routingMatch.email && <> · {routingMatch.email}</>}
                </p>
              )}
              <div className="flex items-center gap-2 mt-3">
                <Input
                  value={callNumber}
                  onChange={e => setCallNumber(e.target.value)}
                  className="h-9 text-sm font-mono max-w-[200px]"
                  placeholder="Phone number…"
                />
                <button
                  onClick={() => { handleCall(callNumber); setShowCallPrompt(false); }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <Phone className="h-4 w-4" /> Call Now
                </button>
                <button
                  onClick={() => setShowCallPrompt(false)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && fields.length === 0 && selectedCaseId && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <CheckCircle className="mb-4 h-12 w-12 text-success/50" />
          <p className="text-sm text-muted-foreground">All fields are complete for this case. Nothing to resolve!</p>
        </div>
      )}

      {loading && selectedCaseId && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* AI Script — Generate button (inline) */}
      {(missingFields.length > 0 || reviewFields.length > 0) && !script && (
        <div className="mb-8 rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" /> AI Question Script
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                Covers {missingFields.length} missing and {reviewFields.length} review field{reviewFields.length !== 1 ? "s" : ""}.
              </p>
            </div>
            <button
              onClick={generateScript}
              disabled={scriptLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {scriptLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {scriptLoading ? "Generating…" : "Generate Script"}
            </button>
          </div>
        </div>
      )}

      {/* Floating sticky script panel */}
      {script && (
        <div
          ref={panelRef}
          className="fixed z-50 animate-fade-in"
          style={{ left: panelPos.x, top: panelPos.y, width: 400 }}
        >
          <div className="rounded-2xl border border-border bg-card shadow-2xl shadow-primary/10 overflow-hidden">
            {/* Draggable header */}
            <div
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onClick={() => { if (!hasDragged.current) setScriptExpanded(prev => !prev); }}
              className={`w-full flex items-center justify-between px-4 py-3 bg-primary/5 border-b border-border hover:bg-primary/10 transition-colors select-none ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <MessageSquareText className="h-4 w-4 text-primary" />
                Call Script
              </span>
              <div className="flex items-center gap-1">
                <span
                  role="button"
                  onClick={e => { e.stopPropagation(); copyScript(); }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted transition-colors"
                  title="Copy to clipboard"
                >
                  <Copy className="h-3.5 w-3.5" />
                </span>
                <span
                  role="button"
                  onClick={e => { e.stopPropagation(); generateScript(); }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted transition-colors"
                  title="Regenerate"
                >
                  {scriptLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                </span>
                <span
                  role="button"
                  onClick={e => { e.stopPropagation(); setScript(null); }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted transition-colors"
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
                {scriptExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
              </div>
            </div>
            {/* Collapsible body */}
            {scriptExpanded && (
              <div className="max-h-[50vh] overflow-y-auto p-4">
                <p className="text-sm text-foreground whitespace-pre-line leading-relaxed">{script}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Missing Fields */}
      {missingFields.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-overdue">
            <AlertCircle className="h-4 w-4" /> Missing Fields ({missingFields.length})
          </h2>
          <div className="space-y-3">
            {missingFields.map(field => {
              const isEditing = editingFieldId === field.id;
              return (
                <div key={field.id} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{field.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{field.section}</p>
                    </div>
                    <span className="inline-flex items-center rounded-full bg-overdue/15 px-2.5 py-0.5 text-xs font-semibold text-overdue">Missing</span>
                  </div>
                  {field.evidence_ref && (
                    <p className="text-xs text-muted-foreground mb-2">📄 {field.evidence_ref}</p>
                  )}
                  {field.notes && (
                    <p className="text-xs text-muted-foreground mb-2 whitespace-pre-line">{field.notes}</p>
                  )}

                  {isEditing ? (
                    <div className="flex items-center gap-2 mt-2">
                      <Input
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        className="h-8 text-sm flex-1"
                        placeholder={`Enter value for ${field.label}…`}
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === "Enter") saveEdit(field);
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                      <button
                        onClick={() => saveEdit(field)}
                        disabled={saving}
                        className="rounded p-1.5 text-success hover:bg-success/10 transition-colors disabled:opacity-50"
                        title="Save"
                      >
                        <Save className="h-4 w-4" />
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted transition-colors"
                        title="Cancel"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => startEdit(field)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                      >
                        <Edit3 className="h-3.5 w-3.5 text-primary" /> Enter Value
                      </button>
                      <button
                        onClick={promptAndCall}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                      >
                        <Phone className="h-3.5 w-3.5 text-primary" /> Call
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Needs Review */}
      {reviewFields.length > 0 && (
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-warning">
            <AlertCircle className="h-4 w-4" /> Needs Review ({reviewFields.length})
          </h2>
          <div className="space-y-3">
            {reviewFields.map(field => {
              const isEditing = editingFieldId === field.id;
              return (
                <div key={field.id} className="rounded-xl border border-border bg-card px-5 py-3">
                  <div className="flex items-center gap-4">
                    <span className="h-2 w-2 rounded-full bg-warning shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {field.label}: <span className="text-muted-foreground">{field.value}</span>
                      </p>
                      {field.notes && <p className="text-xs text-warning mt-0.5 whitespace-pre-line">{field.notes}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {field.confidence && <ConfidenceBadge level={field.confidence as Confidence} />}
                      {field.evidence_source && <EvidenceBadge source={field.evidence_source as EvidenceSource} />}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => startEdit(field)}
                        className="rounded p-1 text-primary hover:bg-primary/10 transition-colors"
                        title="Edit value"
                      >
                        <Edit3 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleConfirm(field)}
                        disabled={confirmingId === field.id}
                        className="rounded p-1 text-success hover:bg-success/10 transition-colors disabled:opacity-50"
                        title="Confirm value is correct"
                      >
                        {confirmingId === field.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  {isEditing && (
                    <div className="flex items-center gap-2 mt-3 ml-6">
                      <Input
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        className="h-8 text-sm flex-1"
                        placeholder={`Correct value for ${field.label}…`}
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === "Enter") saveEdit(field);
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                      <button
                        onClick={() => saveEdit(field)}
                        disabled={saving}
                        className="rounded p-1.5 text-success hover:bg-success/10 transition-colors disabled:opacity-50"
                        title="Save"
                      >
                        <Save className="h-4 w-4" />
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted transition-colors"
                        title="Cancel"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default MissingData;
