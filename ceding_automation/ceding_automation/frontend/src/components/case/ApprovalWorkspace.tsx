import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ThumbsUp,
  AlertTriangle,
  CircleDashed,
  MessageSquare,
  Search,
  Loader2,
  ShieldCheck,
  ChevronRight,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/useRole";
import { useChecklistFields } from "@/hooks/useChecklistFields";
import { getTemplate, groupBySection } from "@/lib/checklistTemplates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { CaseRow } from "@/lib/caseHelpers";
import type { Tables } from "@/integrations/supabase/types";

type ChecklistRow = Tables<"checklist_fields">;

type FilterTab = "all" | "pending" | "review" | "approved" | "missing";

interface Props {
  caseItem: CaseRow;
}

export function ApprovalWorkspace({ caseItem }: Props) {
  const qc = useQueryClient();
  const { role, userName, canApprove } = useRole();
  const template = useMemo(() => getTemplate(caseItem.plan_type), [caseItem.plan_type]);
  const { rows, loading, refresh } = useChecklistFields({ caseId: caseItem.id, template });

  const [filter, setFilter] = useState<FilterTab>("pending");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewDialog, setReviewDialog] = useState<{ row: ChecklistRow } | null>(null);
  const [reviewText, setReviewText] = useState("");
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [bulkReviewText, setBulkReviewText] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const stats = useMemo(() => {
    let approved = 0,
      review = 0,
      pending = 0,
      missing = 0;
    rows.forEach((r) => {
      if (r.status === "approved") approved++;
      else if (r.status === "review_requested") review++;
      else if (!r.value) missing++;
      else pending++;
    });
    return { approved, review, pending, missing, total: rows.length };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "approved" && r.status !== "approved") return false;
      if (filter === "review" && r.status !== "review_requested") return false;
      if (filter === "missing" && r.value) return false;
      if (filter === "pending") {
        if (r.status === "approved" || r.status === "review_requested" || !r.value) return false;
      }
      if (q) {
        return (
          r.label.toLowerCase().includes(q) ||
          (r.value ?? "").toLowerCase().includes(q) ||
          (r.section ?? "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [rows, filter, search]);

  const grouped = useMemo(() => {
    const m = new Map<string, ChecklistRow[]>();
    filtered.forEach((r) => {
      if (!m.has(r.section)) m.set(r.section, []);
      m.get(r.section)!.push(r);
    });
    return Array.from(m.entries()).map(([section, items]) => ({ section, items }));
  }, [filtered]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((r) => r.id)));
    }
  };

  const writeAudit = async (
    targetRows: ChecklistRow[],
    action: "approve" | "request_review",
    notes?: string,
  ) => {
    if (targetRows.length === 0) return;
    await supabase.from("field_audit").insert(
      targetRows.map((r) => ({
        case_id: caseItem.id,
        field_key: r.field_key,
        field_label: r.label,
        action,
        source: "manual",
        old_value: r.value,
        new_value: r.value,
        confidence: r.confidence,
        actor_role: role ?? null,
        actor_name: userName ?? null,
        notes: notes ?? null,
      })),
    );
  };

  const bulkApprove = useMutation({
    mutationFn: async () => {
      const targets = rows.filter(
        (r) => selected.has(r.id) && !!r.value && r.status !== "approved",
      );
      if (targets.length === 0) {
        throw new Error("No eligible fields selected (must have a value and not already approved).");
      }
      const { error } = await supabase
        .from("checklist_fields")
        .update({ status: "approved" })
        .in(
          "id",
          targets.map((r) => r.id),
        );
      if (error) throw error;
      await writeAudit(targets, "approve", `Bulk approve · ${targets.length} field${targets.length === 1 ? "" : "s"}`);
      return targets.length;
    },
    onSuccess: (n) => {
      toast.success(`Approved ${n} field${n === 1 ? "" : "s"}`);
      setSelected(new Set());
      refresh();
    },
    onError: (e: Error) => toast.error("Approve failed", { description: e.message }),
  });

  const singleAction = useMutation({
    mutationFn: async ({
      row,
      action,
      notes,
    }: {
      row: ChecklistRow;
      action: "approve" | "request_review";
      notes?: string;
    }) => {
      const newStatus = action === "approve" ? "approved" : "review_requested";
      const { error } = await supabase
        .from("checklist_fields")
        .update({ status: newStatus, notes: notes ?? row.notes })
        .eq("id", row.id);
      if (error) throw error;
      await writeAudit([row], action, notes);
    },
    onSuccess: (_, vars) => {
      toast.success(vars.action === "approve" ? "Field approved" : "Review requested");
      refresh();
    },
    onError: (e: Error) => toast.error("Action failed", { description: e.message }),
  });

  const bulkRequestReview = useMutation({
    mutationFn: async (notes: string) => {
      const targets = rows.filter((r) => selected.has(r.id) && r.status !== "review_requested");
      if (targets.length === 0) throw new Error("No fields selected.");
      if (!notes.trim()) throw new Error("Please add a comment for the CA team.");
      const { error } = await supabase
        .from("checklist_fields")
        .update({ status: "review_requested", notes: notes.trim() })
        .in(
          "id",
          targets.map((r) => r.id),
        );
      if (error) throw error;
      await writeAudit(targets, "request_review", `Bulk review request: ${notes.trim()}`);
      return targets.length;
    },
    onSuccess: (n) => {
      toast.success(`Sent ${n} field${n === 1 ? "" : "s"} back for review`);
      setSelected(new Set());
      setBulkReviewOpen(false);
      setBulkReviewText("");
      refresh();
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const markCaseApproved = useMutation({
    mutationFn: async () => {
      // Gate: every templated field must be approved
      const requiredKeys = template.map((t) => t.key);
      const byKey = new Map(rows.map((r) => [r.field_key, r]));
      const notApproved = requiredKeys.filter((k) => byKey.get(k)?.status !== "approved");
      if (notApproved.length > 0) {
        throw new Error(`${notApproved.length} field${notApproved.length === 1 ? " is" : "s are"} not yet approved.`);
      }
      const { error } = await supabase
        .from("cases")
        .update({
          status: "approved",
          last_activity_at: new Date().toISOString(),
        })
        .eq("id", caseItem.id);
      if (error) throw error;

      await supabase.from("field_audit").insert({
        case_id: caseItem.id,
        action: "case_approved",
        source: "manual",
        field_label: "Case sign-off",
        old_value: caseItem.status,
        new_value: "approved",
        actor_role: role ?? null,
        actor_name: userName ?? null,
        notes: "All fields approved · case marked complete by reviewer.",
      });

      // Notify CA team owner if known.
      await supabase.from("notifications").insert({
        recipient_user_id: "00000000-0000-0000-0000-000000000000",
        recipient_role: "ca_team",
        type: "case_approved",
        title: `Case approved: ${caseItem.client_name}`,
        body: `${userName ?? "Reviewer"} signed off all fields. Ready for export.`,
        case_id: caseItem.id,
        link: `/cases/${caseItem.id}`,
        actor_name: userName,
        actor_role: role,
      });
    },
    onSuccess: () => {
      toast.success("Case marked approved", {
        description: "Status updated · CA team notified · audit entry written.",
      });
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: ["case", caseItem.id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      refresh();
    },
    onError: (e: Error) => toast.error("Cannot approve case", { description: e.message }),
  });

  if (!canApprove) {
    return (
      <div className="rounded-md border border-warning/30 bg-warning/5 p-4 text-sm">
        <p className="font-semibold text-foreground flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-warning" /> Reviewer access required
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Switch to the Paraplanner or Adviser role to approve fields and sign off this case.
        </p>
      </div>
    );
  }

  const allFieldsApproved = stats.approved === stats.total && stats.total > 0;
  const caseAlreadyApproved = caseItem.status === "approved" || caseItem.status === "complete";

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatCard label="Total" value={stats.total} tone="muted" icon={CheckCircle2} />
        <StatCard label="Approved" value={stats.approved} tone="success" icon={ThumbsUp} />
        <StatCard label="Pending" value={stats.pending} tone="info" icon={CheckCircle2} />
        <StatCard label="Review" value={stats.review} tone="warning" icon={AlertTriangle} />
        <StatCard label="Missing" value={stats.missing} tone="overdue" icon={CircleDashed} />
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="text-muted-foreground font-medium">Sign-off progress</span>
          <span className="text-foreground font-bold">
            {stats.approved} / {stats.total}{" "}
            <span className="text-muted-foreground font-normal">approved</span>
          </span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-success transition-all"
            style={{ width: `${stats.total ? (stats.approved / stats.total) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2">
        <div className="flex gap-1">
          <FilterButton current={filter} value="pending" onClick={setFilter} count={stats.pending}>
            Pending
          </FilterButton>
          <FilterButton current={filter} value="review" onClick={setFilter} count={stats.review}>
            Review
          </FilterButton>
          <FilterButton current={filter} value="approved" onClick={setFilter} count={stats.approved}>
            Approved
          </FilterButton>
          <FilterButton current={filter} value="missing" onClick={setFilter} count={stats.missing}>
            Missing
          </FilterButton>
          <FilterButton current={filter} value="all" onClick={setFilter} count={stats.total}>
            All
          </FilterButton>
        </div>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search field, value, section…"
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-md border border-teal/40 bg-teal/5 p-3">
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={selected.size === filtered.length && filtered.length > 0}
              onCheckedChange={toggleSelectAllFiltered}
            />
            <span className="font-semibold text-foreground">{selected.size} selected</span>
            <button
              className="text-xs text-muted-foreground hover:text-foreground underline"
              onClick={() => setSelected(new Set())}
            >
              clear
            </button>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBulkReviewOpen(true)}
              className="gap-1"
            >
              <MessageSquare className="h-3.5 w-3.5" /> Request review
            </Button>
            <Button
              size="sm"
              onClick={() => bulkApprove.mutate()}
              disabled={bulkApprove.isPending}
              className="gap-1"
            >
              {bulkApprove.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ThumbsUp className="h-3.5 w-3.5" />
              )}{" "}
              Approve selected
            </Button>
          </div>
        </div>
      )}

      {/* Field list */}
      {loading ? (
        <p className="text-sm text-muted-foreground text-center py-6">Loading checklist…</p>
      ) : grouped.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center">
          <CheckCircle2 className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-semibold text-foreground">Nothing to show</p>
          <p className="text-xs text-muted-foreground mt-1">
            {filter === "pending"
              ? "All filled fields have been actioned. Switch tabs to see approved or review-requested items."
              : "No fields match this filter."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map(({ section, items }) => (
            <div key={section} className="rounded-md border border-border bg-card overflow-hidden">
              <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
                <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
                  {section}
                </h4>
                <span className="text-[10px] text-muted-foreground">
                  {items.length} field{items.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="divide-y divide-border">
                {items.map((row) => (
                  <FieldRow
                    key={row.id}
                    row={row}
                    selected={selected.has(row.id)}
                    onToggleSelect={() => toggleSelect(row.id)}
                    onApprove={() => singleAction.mutate({ row, action: "approve" })}
                    onRequestReview={() => {
                      setReviewText(row.notes ?? "");
                      setReviewDialog({ row });
                    }}
                    busy={singleAction.isPending}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Sign-off gate */}
      <div
        className={`rounded-md border p-4 ${
          caseAlreadyApproved
            ? "border-success/40 bg-success/5"
            : allFieldsApproved
            ? "border-teal/40 bg-teal/5"
            : "border-border bg-muted/30"
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-md shrink-0 ${
              caseAlreadyApproved
                ? "bg-success/15 text-success"
                : allFieldsApproved
                ? "bg-teal/15 text-teal"
                : "bg-muted text-muted-foreground"
            }`}
          >
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-bold text-foreground">
              {caseAlreadyApproved
                ? "Case approved"
                : allFieldsApproved
                ? "Ready for sign-off"
                : "Sign-off gate"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {caseAlreadyApproved
                ? "All fields signed off. Move to Step 10 to export and upload to WorkDrive."
                : allFieldsApproved
                ? "Every field is approved. Mark the case approved to lock it and notify the CA team."
                : `${stats.total - stats.approved} field${
                    stats.total - stats.approved === 1 ? "" : "s"
                  } remaining (${stats.missing} missing, ${stats.review} in review, ${stats.pending} pending).`}
            </p>
          </div>
          <Button
            size="sm"
            disabled={!allFieldsApproved || markCaseApproved.isPending || caseAlreadyApproved}
            onClick={() => setConfirmOpen(true)}
            className="gap-1 shrink-0"
          >
            {caseAlreadyApproved ? "Approved" : "Mark case approved"}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Single-row request review dialog */}
      <Dialog open={!!reviewDialog} onOpenChange={(o) => !o && setReviewDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request review</DialogTitle>
            <DialogDescription>
              Send <strong className="text-foreground">{reviewDialog?.row.label}</strong> back to CA team with a comment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label className="text-xs">Comment</Label>
            <Textarea
              rows={3}
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              placeholder="What needs to be checked or corrected?"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!reviewDialog) return;
                if (!reviewText.trim()) {
                  toast.error("Please add a comment");
                  return;
                }
                singleAction.mutate(
                  { row: reviewDialog.row, action: "request_review", notes: reviewText.trim() },
                  { onSuccess: () => setReviewDialog(null) },
                );
              }}
              disabled={singleAction.isPending}
            >
              Send back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk review dialog */}
      <Dialog open={bulkReviewOpen} onOpenChange={setBulkReviewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request review on {selected.size} field{selected.size === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>
              Send these back to CA team with a single comment applied to each.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label className="text-xs">Comment for CA team</Label>
            <Textarea
              rows={3}
              value={bulkReviewText}
              onChange={(e) => setBulkReviewText(e.target.value)}
              placeholder="e.g. AMC values look wrong — please re-check the policy schedule."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkReviewOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => bulkRequestReview.mutate(bulkReviewText)}
              disabled={bulkRequestReview.isPending}
            >
              {bulkRequestReview.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send back"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm sign-off */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark case approved?</DialogTitle>
            <DialogDescription>
              You are signing off <strong className="text-foreground">{caseItem.client_name}</strong>.
              The case status will change to <span className="font-mono text-foreground">approved</span>,
              the CA team will be notified, and an immutable audit entry will be written.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={markCaseApproved.isPending}>
              Cancel
            </Button>
            <Button onClick={() => markCaseApproved.mutate()} disabled={markCaseApproved.isPending} className="gap-2">
              {markCaseApproved.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm sign-off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: "muted" | "success" | "info" | "warning" | "overdue";
  icon: React.ElementType;
}) {
  const cls = {
    muted: "bg-muted/40 border-border text-muted-foreground",
    success: "bg-success/10 border-success/30 text-success",
    info: "bg-info/10 border-info/30 text-info",
    warning: "bg-warning/10 border-warning/30 text-warning",
    overdue: "bg-overdue/10 border-overdue/30 text-overdue",
  }[tone];
  return (
    <div className={`rounded-md border p-2.5 ${cls}`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider font-bold opacity-80">{label}</span>
        <Icon className="h-3.5 w-3.5 opacity-70" />
      </div>
      <p className="text-xl font-bold text-foreground mt-0.5">{value}</p>
    </div>
  );
}

function FilterButton({
  current,
  value,
  onClick,
  count,
  children,
}: {
  current: FilterTab;
  value: FilterTab;
  onClick: (v: FilterTab) => void;
  count: number;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(value)}
      className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors flex items-center gap-1.5 ${
        active
          ? "bg-teal text-white"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
    >
      {children}
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded ${
          active ? "bg-white/20" : "bg-muted-foreground/15"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function FieldRow({
  row,
  selected,
  onToggleSelect,
  onApprove,
  onRequestReview,
  busy,
}: {
  row: ChecklistRow;
  selected: boolean;
  onToggleSelect: () => void;
  onApprove: () => void;
  onRequestReview: () => void;
  busy: boolean;
}) {
  const status = row.status;
  const statusMeta =
    status === "approved"
      ? { label: "Approved", cls: "bg-success/15 text-success border-success/30", icon: ThumbsUp }
      : status === "review_requested"
      ? { label: "Review requested", cls: "bg-warning/15 text-warning border-warning/30", icon: AlertTriangle }
      : !row.value
      ? { label: "Missing", cls: "bg-overdue/15 text-overdue border-overdue/30", icon: CircleDashed }
      : { label: "Pending", cls: "bg-info/15 text-info border-info/30", icon: CheckCircle2 };
  const conf = (row.confidence ?? "").toUpperCase();
  const confCls =
    conf === "HIGH"
      ? "bg-success/10 text-success"
      : conf === "MEDIUM"
      ? "bg-warning/10 text-warning"
      : conf === "LOW"
      ? "bg-overdue/10 text-overdue"
      : "bg-muted text-muted-foreground";

  return (
    <li className="px-3 py-2.5 hover:bg-muted/30 transition-colors">
      <div className="flex items-start gap-3">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          disabled={!row.value}
          className="mt-1 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-foreground">{row.label}</p>
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${statusMeta.cls}`}>
              {statusMeta.label}
            </span>
            {conf && conf !== "MISSING" && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${confCls}`}>
                {conf}
              </span>
            )}
            {row.manually_edited && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                Manual
              </span>
            )}
          </div>
          <p
            className={`text-sm mt-0.5 break-words ${
              row.value ? "text-foreground font-mono" : "text-muted-foreground italic"
            }`}
          >
            {row.value || "— no value —"}
          </p>
          {row.notes && (
            <p className="text-[11px] text-muted-foreground mt-1 flex items-start gap-1">
              <MessageSquare className="h-3 w-3 mt-0.5 shrink-0" />
              <span className="italic">{row.notes}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <Button
            size="sm"
            variant={status === "approved" ? "outline" : "default"}
            onClick={onApprove}
            disabled={busy || !row.value || status === "approved"}
            className="h-7 px-2 gap-1 text-xs"
          >
            <ThumbsUp className="h-3 w-3" /> Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onRequestReview}
            disabled={busy}
            className="h-7 px-2 gap-1 text-xs"
          >
            <MessageSquare className="h-3 w-3" /> Review
          </Button>
        </div>
      </div>
    </li>
  );
}
