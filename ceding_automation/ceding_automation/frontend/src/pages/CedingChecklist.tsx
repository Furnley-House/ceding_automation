import { ConfidenceBadge, EvidenceBadge, FieldStatusIcon, SectionHeader } from "@/components/shared/StatusComponents";
import { useState, useEffect, useCallback } from "react";
import { MessageSquare, Check, RotateCcw, Save, X, FileText, Loader2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import type { Tables } from "@/integrations/supabase/types";
import type { Confidence, EvidenceSource } from "@/data/seedData";

type ChecklistRow = Tables<"checklist_fields">;
type CaseRow = Tables<"cases">;

const CedingChecklist = () => {
  const [mode, setMode] = useState<"edit" | "review">("review");
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [fields, setFields] = useState<ChecklistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [commentFieldId, setCommentFieldId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "complete" | "needs_review" | "missing">("all");

  // Fetch cases that have checklist fields
  const fetchCases = useCallback(async () => {
    const { data, error } = await supabase
      .from("cases")
      .select("*")
      .order("created_at", { ascending: false });
    if (!error && data) setCases(data);
  }, []);

  // Also check documents with extracted_data but no case (standalone extractions)
  const [standaloneDocs, setStandaloneDocs] = useState<Tables<"documents">[]>([]);

  const fetchStandaloneDocs = useCallback(async () => {
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .is("case_id", null)
      .eq("status", "extracted")
      .order("created_at", { ascending: false });
    if (!error && data) setStandaloneDocs(data);
  }, []);

  // Fetch checklist fields for selected case
  const fetchFields = useCallback(async (caseId: string) => {
    setLoading(true);
    const { data, error } = await supabase
      .from("checklist_fields")
      .select("*")
      .eq("case_id", caseId)
      .order("section", { ascending: true });
    if (!error && data) setFields(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchCases();
    fetchStandaloneDocs();
  }, [fetchCases, fetchStandaloneDocs]);

  // Auto-select first case that has fields
  useEffect(() => {
    if (selectedCaseId) return;
    if (cases.length > 0) {
      // Prefer cases with extraction done
      const withExtraction = cases.find(c => c.ai_extraction_date);
      setSelectedCaseId(withExtraction?.id ?? cases[0].id);
    }
  }, [cases, selectedCaseId]);

  useEffect(() => {
    if (selectedCaseId) fetchFields(selectedCaseId);
  }, [selectedCaseId, fetchFields]);

  const selectedCase = cases.find(c => c.id === selectedCaseId);
  const sections = [...new Set(fields.map(f => f.section))];
  const complete = fields.filter(f => f.status === "complete").length;
  const needsReview = fields.filter(f => f.status === "needs_review").length;
  const missing = fields.filter(f => f.status === "missing").length;
  const total = fields.length;
  const pct = total > 0 ? Math.round((complete / total) * 100) : 0;

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
    setSaving(true);
    const newValue = editValue.trim();
    const updates: Partial<ChecklistRow> = {
      value: newValue || null,
      status: newValue ? "complete" : "missing",
      confidence: newValue ? "high" : null,
      evidence_source: newValue ? "manual" : null,
      evidence_ref: newValue ? "Manually entered" : null,
    };

    const { error } = await supabase
      .from("checklist_fields")
      .update(updates)
      .eq("id", field.id);

    if (error) {
      toast.error("Failed to save");
    } else {
      toast.success(`"${field.label}" updated`);
      setFields(prev =>
        prev.map(f => (f.id === field.id ? { ...f, ...updates } : f))
      );
    }
    setSaving(false);
    setEditingFieldId(null);
  };

  // ── Review actions ──
  const handleApprove = async (field: ChecklistRow) => {
    setActionLoading(field.id);
    const user = (await supabase.auth.getUser()).data.user;
    const { error } = await supabase
      .from("checklist_fields")
      .update({
        status: "complete",
        reviewed_by: user?.id ?? null,
        notes: field.notes ? `${field.notes}\n✅ Approved by reviewer` : "✅ Approved by reviewer",
      })
      .eq("id", field.id);
    if (error) {
      toast.error("Failed to approve");
    } else {
      toast.success(`"${field.label}" approved`);
      setFields(prev =>
        prev.map(f =>
          f.id === field.id
            ? { ...f, status: "complete", reviewed_by: user?.id ?? null, notes: field.notes ? `${field.notes}\n✅ Approved by reviewer` : "✅ Approved by reviewer" }
            : f
        )
      );
    }
    setActionLoading(null);
  };

  const handleRequestFollowUp = async (field: ChecklistRow) => {
    setActionLoading(field.id);
    const { error } = await supabase
      .from("checklist_fields")
      .update({
        status: "needs_review",
        notes: field.notes ? `${field.notes}\n🔄 Follow-up requested` : "🔄 Follow-up requested",
      })
      .eq("id", field.id);
    if (error) {
      toast.error("Failed to update");
    } else {
      toast.success(`Follow-up requested for "${field.label}"`);
      setFields(prev =>
        prev.map(f =>
          f.id === field.id
            ? { ...f, status: "needs_review", notes: field.notes ? `${field.notes}\n🔄 Follow-up requested` : "🔄 Follow-up requested" }
            : f
        )
      );
    }
    setActionLoading(null);
  };

  const handleSaveComment = async (field: ChecklistRow) => {
    if (!commentText.trim()) return;
    setActionLoading(field.id);
    const existingNotes = field.notes ?? "";
    const newNotes = existingNotes
      ? `${existingNotes}\n💬 ${commentText.trim()}`
      : `💬 ${commentText.trim()}`;
    const { error } = await supabase
      .from("checklist_fields")
      .update({ notes: newNotes })
      .eq("id", field.id);
    if (error) {
      toast.error("Failed to save comment");
    } else {
      toast.success("Comment saved");
      setFields(prev =>
        prev.map(f => (f.id === field.id ? { ...f, notes: newNotes } : f))
      );
    }
    setCommentFieldId(null);
    setCommentText("");
    setActionLoading(null);
  };

  return (
    <div className="animate-slide-in">
      <SectionHeader
        title="Ceding Checklist"
        subtitle={
          selectedCase
            ? `${selectedCase.client_name} — ${selectedCase.provider_name} ${selectedCase.plan_number} · ${selectedCase.plan_type}`
            : "Select a case to view its checklist"
        }
        action={
          <div className="flex gap-2">
            <button
              onClick={() => setMode("edit")}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                mode === "edit"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              Edit Mode
            </button>
            <button
              onClick={() => setMode("review")}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                mode === "review"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              Adviser Review
            </button>
          </div>
        }
      />

      {/* Case selector */}
      <div className="mb-6">
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Select Case</label>
        <Select
          value={selectedCaseId ?? ""}
          onValueChange={id => setSelectedCaseId(id)}
        >
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

      {/* Standalone extracted docs notice */}
      {standaloneDocs.length > 0 && (
        <div className="mb-6 rounded-xl border border-border bg-muted/30 p-4">
          <p className="text-sm font-medium text-foreground mb-2">
            <FileText className="inline h-4 w-4 mr-1 text-primary" />
            {standaloneDocs.length} extracted document{standaloneDocs.length > 1 ? "s" : ""} not linked to a case
          </p>
          <p className="text-xs text-muted-foreground">
            These documents were extracted but have no associated case. Create a case and link the document to populate its checklist.
          </p>
          <ul className="mt-2 space-y-1">
            {standaloneDocs.map(d => (
              <li key={d.id} className="text-xs text-muted-foreground">
                • {d.file_name} — {d.fields_extracted ?? 0} fields extracted
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* No case selected or no fields */}
      {!selectedCaseId && cases.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            No cases found. Create a case and run AI extraction on a document to populate the checklist.
          </p>
        </div>
      )}

      {selectedCaseId && fields.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            No checklist fields for this case yet. Upload a document and run AI extraction to populate the checklist.
          </p>
        </div>
      )}

      {/* Progress bar */}
      {total > 0 && (
        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-foreground">
              Completion: {complete}/{total} fields
            </span>
            <span className="text-sm font-semibold text-primary">{pct}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 flex gap-2 text-xs">
            <button
              onClick={() => setStatusFilter("all")}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium transition-colors cursor-pointer ${statusFilter === "all" ? "bg-primary/15 text-primary ring-1 ring-primary/30" : "text-muted-foreground hover:bg-muted"}`}
            >
              All ({total})
            </button>
            <button
              onClick={() => setStatusFilter(statusFilter === "complete" ? "all" : "complete")}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium transition-colors cursor-pointer ${statusFilter === "complete" ? "bg-success/15 text-success ring-1 ring-success/30" : "text-muted-foreground hover:bg-muted"}`}
            >
              <span className="inline-block h-2 w-2 rounded-full bg-success" />
              {complete} Complete
            </button>
            <button
              onClick={() => setStatusFilter(statusFilter === "needs_review" ? "all" : "needs_review")}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium transition-colors cursor-pointer ${statusFilter === "needs_review" ? "bg-warning/15 text-warning ring-1 ring-warning/30" : "text-muted-foreground hover:bg-muted"}`}
            >
              <span className="inline-block h-2 w-2 rounded-full bg-warning" />
              {needsReview} Needs Review
            </button>
            <button
              onClick={() => setStatusFilter(statusFilter === "missing" ? "all" : "missing")}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium transition-colors cursor-pointer ${statusFilter === "missing" ? "bg-overdue/15 text-overdue ring-1 ring-overdue/30" : "text-muted-foreground hover:bg-muted"}`}
            >
              <span className="inline-block h-2 w-2 rounded-full bg-overdue" />
              {missing} Missing
            </button>
          </div>
        </div>
      )}

      {/* Sections */}
      <div className="space-y-6">
        {sections.map(section => {
          const sectionFields = fields
            .filter(f => f.section === section)
            .filter(f => statusFilter === "all" || f.status === statusFilter);
          if (sectionFields.length === 0) return null;
          return (
          <div
            key={section}
            className="rounded-xl border border-border bg-card overflow-hidden"
          >
            <div className="border-b border-border bg-muted/30 px-5 py-3">
              <h2 className="text-sm font-semibold text-foreground">{section}</h2>
            </div>
            <div className="divide-y divide-border">
              {sectionFields
                .map(field => {
                  const isEditing = editingFieldId === field.id;

                  return (
                    <div
                      key={field.id}
                      className="flex items-start gap-4 px-5 py-3 hover:bg-muted/20 transition-colors"
                    >
                      <FieldStatusIcon
                        status={field.status as "complete" | "missing" | "needs_review"}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">{field.label}</p>

                        {isEditing ? (
                          <div className="flex items-center gap-2 mt-1">
                            <Input
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              className="h-8 text-sm"
                              autoFocus
                              onKeyDown={e => {
                                if (e.key === "Enter") saveEdit(field);
                                if (e.key === "Escape") cancelEdit();
                              }}
                            />
                            <button
                              onClick={() => saveEdit(field)}
                              disabled={saving}
                              className="rounded p-1 text-success hover:bg-success/10 transition-colors"
                              title="Save"
                            >
                              <Save className="h-4 w-4" />
                            </button>
                            <button
                              onClick={cancelEdit}
                              className="rounded p-1 text-muted-foreground hover:bg-muted transition-colors"
                              title="Cancel"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <p
                              className={`text-sm mt-0.5 ${
                                field.value
                                  ? "text-muted-foreground"
                                  : "italic text-overdue"
                              } ${mode === "edit" ? "cursor-pointer hover:text-foreground" : ""}`}
                              onClick={() => mode === "edit" && startEdit(field)}
                            >
                              {field.value || "Missing — click to enter value"}
                            </p>
                            {field.evidence_ref && (
                              <p className="text-xs text-muted-foreground mt-1">
                                📄 {field.evidence_ref}
                              </p>
                            )}
                            {field.notes && (
                              <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">
                                {field.notes}
                              </p>
                            )}

                            {/* Comment input */}
                            {commentFieldId === field.id && (
                              <div className="mt-2 flex items-start gap-2">
                                <Textarea
                                  value={commentText}
                                  onChange={e => setCommentText(e.target.value)}
                                  placeholder="Add a comment…"
                                  className="h-16 text-xs"
                                  autoFocus
                                />
                                <button
                                  onClick={() => handleSaveComment(field)}
                                  disabled={!commentText.trim() || actionLoading === field.id}
                                  className="rounded p-1.5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                                  title="Save comment"
                                >
                                  <Save className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() => { setCommentFieldId(null); setCommentText(""); }}
                                  className="rounded p-1.5 text-muted-foreground hover:bg-muted transition-colors"
                                  title="Cancel"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {field.confidence && (
                          <ConfidenceBadge level={field.confidence as Confidence} />
                        )}
                        {field.evidence_source && (
                          <EvidenceBadge source={field.evidence_source as EvidenceSource} />
                        )}
                      </div>
                      {mode === "review" && field.status !== "missing" && (
                        <div className="flex gap-1 shrink-0">
                          <button
                            onClick={() => handleApprove(field)}
                            disabled={actionLoading === field.id}
                            className="rounded p-1 text-success hover:bg-success/10 transition-colors disabled:opacity-50"
                            title="Approve"
                          >
                            {actionLoading === field.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          </button>
                          <button
                            onClick={() => handleRequestFollowUp(field)}
                            disabled={actionLoading === field.id}
                            className="rounded p-1 text-warning hover:bg-warning/10 transition-colors disabled:opacity-50"
                            title="Request follow-up"
                          >
                            <RotateCcw className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => { setCommentFieldId(field.id); setCommentText(""); }}
                            className="rounded p-1 text-muted-foreground hover:bg-muted transition-colors"
                            title="Comment"
                          >
                            <MessageSquare className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
};

export default CedingChecklist;
