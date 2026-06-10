import { useState, useEffect } from "react";
import {
  Check,
  CircleAlert,
  CircleHelp,
  CircleDashed,
  FileSearch,
  MessageSquare,
  Pencil,
  RotateCcw,
  ThumbsUp,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import type { ChecklistFieldDef } from "@/lib/checklistTemplates";
import { useRole } from "@/hooks/useRole";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

// Must mirror backend Prisma enum `ConfidenceLevel`. CONFLICT is set by the
// AI extractor when two source documents disagree on a field value.
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "MISSING" | "CONFLICT";
export type FieldStatus = "missing" | "pending" | "approved" | "review_requested";

export interface ChecklistFieldState {
  key: string;
  value: string | null;
  confidence: Confidence;
  status: FieldStatus;
  evidenceSource?: string | null;
  evidenceRef?: string | null;
  manuallyEditedBy?: string | null;
  originalAiValue?: string | null;
  comment?: string | null;
}

/** Two-candidate conflict pack passed down by ChecklistPanel for fields
 *  in CONFLICT state. ChecklistField stays pure — no API knowledge here;
 *  the parent supplies `onResolve` which closes over caseId + fieldId +
 *  the refetch, and routes through the existing api.resolveConflict
 *  wrapper. */
export interface ConflictResolution {
  existing: { value: string | null; docName: string | null; page: number | null };
  incoming: { value: string | null; docName: string | null; page: number | null };
  onResolve: (chosenValue: string) => Promise<void>;
}

interface Props {
  def: ChecklistFieldDef;
  state: ChecklistFieldState;
  onChange: (next: Partial<ChecklistFieldState>) => void;
  /** When provided, renders a "jump to source" button next to the field */
  onJumpToSource?: () => void;
  /** When the field is in CONFLICT, renders an inline resolver panel
   *  showing both candidate values + their provenance + "Use this value"
   *  buttons. Undefined for non-conflicted fields (or if the parent
   *  couldn't assemble the candidates — e.g. missing conflict_values). */
  conflict?: ConflictResolution;
}

const CONF_META: Record<Confidence, { label: string; icon: React.ElementType; cls: string }> = {
  HIGH: { label: "High confidence", icon: Check, cls: "bg-success/15 text-success border-success/30" },
  MEDIUM: { label: "Medium confidence", icon: CircleHelp, cls: "bg-warning/15 text-warning border-warning/30" },
  LOW: { label: "Low confidence", icon: CircleAlert, cls: "bg-overdue/15 text-overdue border-overdue/30" },
  MISSING: { label: "Missing", icon: CircleDashed, cls: "bg-muted text-muted-foreground border-border" },
  CONFLICT: { label: "Conflicting sources", icon: AlertTriangle, cls: "bg-overdue/15 text-overdue border-overdue/40" },
};

export function ChecklistField({ def, state, onChange, onJumpToSource, conflict }: Props) {
  const { canEditChecklist, canApprove, userName } = useRole();
  const [localValue, setLocalValue] = useState(state.value ?? "");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [reviewText, setReviewText] = useState("");
  const [commentText, setCommentText] = useState(state.comment ?? "");
  const [resolving, setResolving] = useState(false);

  useEffect(() => setLocalValue(state.value ?? ""), [state.value]);

  // Fall back to MISSING if the backend returns an unmapped enum value.
  // Without this guard, the whole Extract & Fill Gaps stage white-screens
  // because `conf.icon` would throw on undefined.
  const conf = CONF_META[state.confidence] ?? CONF_META.MISSING;
  const ConfIcon = conf.icon;
  const isApproved = state.status === "approved";
  const isReviewRequested = state.status === "review_requested";

  const commitValue = () => {
    if (localValue === (state.value ?? "")) return;
    const isManualOverride = canEditChecklist || canApprove;
    onChange({
      value: localValue || null,
      originalAiValue: state.originalAiValue ?? state.value ?? null,
      manuallyEditedBy: isManualOverride ? userName ?? "Unknown user" : state.manuallyEditedBy,
      status: !state.value && localValue ? "pending" : state.status,
      confidence: !state.value && localValue ? "MEDIUM" : state.confidence,
    });
  };

  const handleApprove = () => onChange({ status: "approved" });
  const handleRequestReview = () => {
    onChange({ status: "review_requested", comment: reviewText });
    setReviewOpen(false);
    setReviewText("");
  };
  const handleSaveComment = () => {
    onChange({ comment: commentText });
    setCommentOpen(false);
  };

  const renderInput = () => {
    const disabled = !canEditChecklist && !canApprove;
    const common = { disabled, onBlur: commitValue, value: localValue, className: "h-9" };

    if (def.type === "select") {
      return (
        <Select
          disabled={disabled}
          value={localValue}
          onValueChange={(v) => {
            setLocalValue(v);
            setTimeout(() => {
              const isManualOverride = canEditChecklist || canApprove;
              onChange({
                value: v || null,
                originalAiValue: state.originalAiValue ?? state.value ?? null,
                manuallyEditedBy: isManualOverride ? userName ?? "Unknown user" : state.manuallyEditedBy,
                status: !state.value && v ? "pending" : state.status,
              });
            }, 0);
          }}
        >
          <SelectTrigger className="h-9">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {def.options?.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    if (def.type === "yesno") {
      return (
        <Select
          disabled={disabled}
          value={localValue}
          onValueChange={(v) => {
            setLocalValue(v);
            setTimeout(() => {
              const isManualOverride = canEditChecklist || canApprove;
              onChange({
                value: v || null,
                originalAiValue: state.originalAiValue ?? state.value ?? null,
                manuallyEditedBy: isManualOverride ? userName ?? "Unknown user" : state.manuallyEditedBy,
                status: !state.value && v ? "pending" : state.status,
              });
            }, 0);
          }}
        >
          <SelectTrigger className="h-9">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Yes">Yes</SelectItem>
            <SelectItem value="No">No</SelectItem>
          </SelectContent>
        </Select>
      );
    }

    const placeholder =
      def.type === "currency"
        ? "£0.00"
        : def.type === "percent"
        ? "0.00%"
        : def.type === "number"
        ? "0"
        : def.type === "date"
        ? "YYYY-MM-DD"
        : "—";

    return (
      <Input
        {...common}
        type={def.type === "date" ? "date" : "text"}
        placeholder={placeholder}
        onChange={(e) => setLocalValue(e.target.value)}
      />
    );
  };

  return (
    <div
      className={`rounded-md border bg-background p-3 transition-colors ${
        isApproved
          ? "border-success/40 bg-success/5"
          : isReviewRequested
          ? "border-warning/40 bg-warning/5"
          : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Label className="text-xs font-semibold text-foreground">
              {def.label}
              {def.required && <span className="text-destructive ml-0.5">*</span>}
            </Label>

            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${conf.cls}`}
                  >
                    <ConfIcon className="h-2.5 w-2.5" />
                    {state.confidence}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">{conf.label}</p>
                  {state.evidenceSource && (
                    <p className="text-[10px] text-muted-foreground mt-1 max-w-[280px]">
                      Source: {state.evidenceSource}
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {state.manuallyEditedBy && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-info/10 text-info border border-info/30 text-[10px] font-semibold">
                      <Pencil className="h-2.5 w-2.5" />
                      Manually edited
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Edited by {state.manuallyEditedBy}</p>
                    {state.originalAiValue && (
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Original AI value: <span className="line-through">{state.originalAiValue}</span>
                      </p>
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {isApproved && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-success/15 text-success border border-success/30 text-[10px] font-semibold">
                <ThumbsUp className="h-2.5 w-2.5" /> Approved
              </span>
            )}
            {isReviewRequested && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30 text-[10px] font-semibold">
                <RotateCcw className="h-2.5 w-2.5" /> Review requested
              </span>
            )}

            {onJumpToSource && (
              // The parent (ChecklistPanel) only wires this callback when a
              // source page exists, so reaching here means we have something
              // to scroll to. The tooltip carries the optional `evidenceRef`
              // metadata when it's available; the button itself is gated on
              // the click handler alone.
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-[10px] gap-1 text-info hover:text-info"
                      onClick={onJumpToSource}
                    >
                      <FileSearch className="h-3 w-3" />
                      Source
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Jump to source in PDF</p>
                    {state.evidenceRef && (
                      <p className="text-[10px] text-muted-foreground">{state.evidenceRef}</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {def.hint && <p className="text-[10px] text-muted-foreground italic mt-0.5">{def.hint}</p>}
        </div>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr,auto]">
        {renderInput()}

        {canApprove && (
          <div className="flex items-center gap-1">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant={isApproved ? "default" : "outline"}
                    onClick={handleApprove}
                    className="h-9 px-2"
                  >
                    <ThumbsUp className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Approve field</TooltipContent>
              </Tooltip>

              <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
                <DialogTrigger asChild>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button size="sm" variant="outline" className="h-9 px-2">
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Request review</TooltipContent>
                  </Tooltip>
                </DialogTrigger>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Request review on “{def.label}”</DialogTitle>
                  </DialogHeader>
                  <Textarea
                    rows={4}
                    placeholder="What needs another look?"
                    value={reviewText}
                    onChange={(e) => setReviewText(e.target.value)}
                  />
                  <Button onClick={handleRequestReview} disabled={!reviewText.trim()}>
                    Send back to CA Team
                  </Button>
                </DialogContent>
              </Dialog>

              <Dialog open={commentOpen} onOpenChange={setCommentOpen}>
                <DialogTrigger asChild>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button size="sm" variant="outline" className="h-9 px-2">
                        <MessageSquare className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Add comment</TooltipContent>
                  </Tooltip>
                </DialogTrigger>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Comment on “{def.label}”</DialogTitle>
                  </DialogHeader>
                  <Textarea
                    rows={4}
                    placeholder="Add context for the team…"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                  />
                  <Button onClick={handleSaveComment}>Save comment</Button>
                </DialogContent>
              </Dialog>
            </TooltipProvider>
          </div>
        )}
      </div>

      {state.confidence === "CONFLICT" && conflict && (
        <div className="mt-3 pt-3 border-t border-overdue/30 space-y-2">
          <p className="text-[11px] font-semibold text-foreground flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 text-overdue" />
            Two sources disagree — pick a value
          </p>
          <ConflictCandidate
            label="Existing"
            candidate={conflict.existing}
            disabled={resolving}
            onPick={async (chosen) => {
              setResolving(true);
              try { await conflict.onResolve(chosen); } finally { setResolving(false); }
            }}
          />
          <ConflictCandidate
            label="New"
            candidate={conflict.incoming}
            disabled={resolving}
            onPick={async (chosen) => {
              setResolving(true);
              try { await conflict.onResolve(chosen); } finally { setResolving(false); }
            }}
          />
        </div>
      )}

      {(state.evidenceSource || state.comment || state.originalAiValue) && (
        <div className="mt-2 pt-2 border-t border-border/60 space-y-1">
          {state.evidenceSource && (
            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Sparkles className="h-2.5 w-2.5 text-teal" />
              {state.evidenceSource}
            </p>
          )}
          {state.originalAiValue && state.value !== state.originalAiValue && (
            <p className="text-[10px] text-muted-foreground">
              Original AI value: <span className="line-through">{state.originalAiValue}</span>
            </p>
          )}
          {state.comment && (
            <p className="text-[10px] text-foreground bg-muted/50 px-2 py-1 rounded">
              <MessageSquare className="inline h-2.5 w-2.5 mr-1 text-muted-foreground" />
              {state.comment}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface ConflictCandidateProps {
  label: string;
  candidate: { value: string | null; docName: string | null; page: number | null };
  disabled: boolean;
  onPick: (chosen: string) => Promise<void>;
}

function ConflictCandidate({ label, candidate, disabled, onPick }: ConflictCandidateProps) {
  const displayValue = candidate.value ?? "(empty)";
  const docLabel = candidate.docName ?? "another document";
  const pageSuffix = candidate.page != null ? `, p.${candidate.page}` : "";
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2 rounded border border-overdue/30 bg-overdue/5">
      <div className="min-w-0 flex-1">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
        <p className="text-sm font-semibold text-foreground break-words">{displayValue}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          from {docLabel}{pageSuffix}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 h-7 text-[11px]"
        disabled={disabled || candidate.value == null}
        onClick={() => onPick(candidate.value ?? "")}
      >
        Use this value
      </Button>
    </div>
  );
}
