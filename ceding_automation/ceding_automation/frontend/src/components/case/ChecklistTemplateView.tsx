// frontend/src/components/case/ChecklistTemplateView.tsx
//
// Excel-template-styled alternative renderer for Stage 4's checklist.
// Enabled via the layout toggle in ChecklistPanel — the CA can flip between
// the default card grid and this "template" view which mirrors the Furnley
// Ceding Checklist Excel layout (section header rows, question in column A,
// wide answer cell in columns B-G).
//
// Editing model: click any answer cell → converts to a type-appropriate
// input (Select for yesno/select fields, native <input> otherwise). Blur or
// Enter saves via the same `onFieldChange` used by the default view;
// Escape reverts. This mirrors the FundDetailsTable inline-edit UX so CAs
// see one consistent pattern across the stage.
//
// Fund Details are rendered inline inside the section that contains them,
// via the existing <FundDetailsTable> component (same behaviour in both
// views — the toggle only swaps how the scalar fields render).

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, CircleDashed, CircleAlert, FileSearch, Sparkles } from "lucide-react";
import type { ChecklistFieldDef } from "@/lib/checklistTemplates";
import type { ChecklistFieldState, Confidence } from "./ChecklistField";
import type { ChecklistRow } from "@/hooks/useChecklistFields";
import { FundDetailsTable } from "./FundDetailsTable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  /** Sections in template order, each with its ordered fields. Comes from
   *  the same groupBySection() call ChecklistPanel already runs — the
   *  parent passes the already-filtered version so the layout toggle
   *  respects the field-confidence filter chips above it. */
  grouped: Array<{ section: string; fields: ChecklistFieldDef[] }>;
  byKey: Map<string, ChecklistRow>;
  /** Which section should render the Fund Details block inline below its
   *  scalar rows. Case-insensitive match. */
  fundSectionName: string;
  /** Read-only mode disables click-to-edit and hides FundDetailsTable edit
   *  affordances. Currently just `!canEditChecklist`. */
  readOnly: boolean;
  /** Called for value edits. Same signature ChecklistPanel already uses. */
  onFieldChange: (
    def: ChecklistFieldDef,
    patch: Partial<ChecklistFieldState>,
  ) => void;
  /** Optional evidence-source jump handler (identical wiring to the default
   *  view). When absent, no source-jump icon is rendered. */
  onJumpToSource?: (
    sourcePage: number | null,
    fieldLabel: string,
    evidenceSource: string | null,
    sourceDocumentId: string | null,
    sourceQuote: string | null,
  ) => void;
  caseId: string;
}

const CONF_META: Record<Confidence, { label: string; cls: string; icon: React.ElementType }> = {
  HIGH: { label: "High confidence", cls: "text-success", icon: CheckCircle2 },
  MEDIUM: { label: "Medium confidence", cls: "text-warning", icon: AlertTriangle },
  LOW: { label: "Low confidence", cls: "text-overdue", icon: CircleAlert },
  MISSING: { label: "Missing", cls: "text-muted-foreground", icon: CircleDashed },
  CONFLICT: { label: "Conflicting sources", cls: "text-overdue", icon: AlertTriangle },
};

export function ChecklistTemplateView({
  grouped,
  byKey,
  fundSectionName,
  readOnly,
  onFieldChange,
  onJumpToSource,
  caseId,
}: Props) {
  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      {/* Legend row mirrors the reference Excel's top banner style. */}
      <div className="border-b border-border bg-muted/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-teal" />
        Template view — click any answer cell to edit
      </div>

      {grouped.map(({ section, fields }) => {
        const isFundSection =
          section.toLowerCase() === fundSectionName.toLowerCase();
        return (
          <div key={section}>
            <SectionHeaderRow title={section} />
            {fields.map((def) => (
              <TemplateRow
                key={def.key}
                def={def}
                row={byKey.get(def.key)}
                readOnly={readOnly}
                onFieldChange={onFieldChange}
                onJumpToSource={onJumpToSource}
              />
            ))}
            {isFundSection && (
              <div className="border-t border-border bg-muted/10 p-3">
                {/* FundDetailsTable already handles readOnly vs editable
                   modes internally; we just forward the flag so the template
                   view inherits the same behaviour as the default view. */}
                <FundDetailsTable caseId={caseId} readOnly={readOnly} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SectionHeaderRow({ title }: { title: string }) {
  return (
    <div className="border-t border-border bg-teal/10 px-4 py-2">
      <p className="text-xs font-bold uppercase tracking-wider text-foreground">
        {title}
      </p>
    </div>
  );
}

interface RowProps {
  def: ChecklistFieldDef;
  row: ChecklistRow | undefined;
  readOnly: boolean;
  onFieldChange: (
    def: ChecklistFieldDef,
    patch: Partial<ChecklistFieldState>,
  ) => void;
  onJumpToSource?: Props["onJumpToSource"];
}

function TemplateRow({ def, row, readOnly, onFieldChange, onJumpToSource }: RowProps) {
  const confidence = ((row?.confidence ?? "MISSING").toUpperCase() as Confidence);
  const conf = CONF_META[confidence] ?? CONF_META.MISSING;
  const ConfIcon = conf.icon;
  const value = row?.value ?? null;
  const displayValue = value && value.toUpperCase() !== "MISSING" ? value : "";
  const status = (row?.status ?? "").toLowerCase();
  const isApproved = status === "approved";
  const isReviewRequested = status === "review_requested";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(displayValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the draft in sync with server-side updates (undo/redo, other tabs).
  useEffect(() => {
    if (!editing) setDraft(displayValue);
  }, [displayValue, editing]);

  const startEdit = () => {
    if (readOnly) return;
    setDraft(displayValue);
    setEditing(true);
    // Focus + select happens after the input renders.
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commit = (nextValue: string) => {
    setEditing(false);
    const clean = nextValue.trim();
    if (clean === displayValue.trim()) return; // no-op
    onFieldChange(def, {
      value: clean || null,
      // Manual override — matches ChecklistField.commitValue's semantics.
      originalAiValue: row?.value ?? null,
      status: !value && clean ? "pending" : (row?.status as ChecklistFieldState["status"]) ?? "pending",
      confidence: !value && clean ? "MEDIUM" : confidence,
    });
  };

  const cancel = () => {
    setEditing(false);
    setDraft(displayValue);
  };

  const hasSourceJump =
    onJumpToSource &&
    row?.source_page !== undefined &&
    row?.source_page !== null;

  return (
    <div
      className={`grid grid-cols-[minmax(0,3fr)_minmax(0,5fr)] border-t border-border ${
        isApproved
          ? "bg-success/5"
          : isReviewRequested
            ? "bg-warning/5"
            : ""
      }`}
    >
      {/* Column A — question label */}
      <div className="border-r border-border px-3 py-2 flex items-start gap-2 group">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <ConfIcon className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${conf.cls}`} />
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {conf.label}
              {row?.evidence_source ? (
                <div className="text-[10px] opacity-80 mt-0.5">
                  Source: {row.evidence_source}
                  {row.evidence_ref ? ` · ${row.evidence_ref}` : ""}
                </div>
              ) : null}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <p className="flex-1 text-xs text-foreground leading-snug">
          {def.label}
          {def.required && <span className="text-destructive ml-0.5">*</span>}
        </p>
        {hasSourceJump && (
          <button
            type="button"
            onClick={() =>
              onJumpToSource?.(
                row?.source_page ?? null,
                def.label,
                row?.evidence_source ?? null,
                row?.source_document_id ?? null,
                row?.source_quote ?? null,
              )
            }
            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-teal shrink-0"
            title="Jump to source page"
          >
            <FileSearch className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Column B..G merged — answer cell */}
      <div
        className={`px-3 py-2 min-h-[36px] flex items-center ${
          readOnly ? "" : "cursor-text hover:bg-muted/40"
        }`}
        onClick={editing ? undefined : startEdit}
      >
        {editing ? (
          <EditControl
            def={def}
            value={draft}
            onDraftChange={setDraft}
            onCommit={commit}
            onCancel={cancel}
            inputRef={inputRef}
          />
        ) : (
          <span className={`text-xs ${displayValue ? "text-foreground" : "text-muted-foreground italic"}`}>
            {displayValue || "—"}
          </span>
        )}
      </div>
    </div>
  );
}

interface EditControlProps {
  def: ChecklistFieldDef;
  value: string;
  onDraftChange: (v: string) => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
}

function EditControl({
  def,
  value,
  onDraftChange,
  onCommit,
  onCancel,
  inputRef,
}: EditControlProps) {
  if (def.type === "yesno") {
    return (
      <Select
        defaultOpen
        value={value}
        onValueChange={(v) => {
          onDraftChange(v);
          onCommit(v);
        }}
      >
        <SelectTrigger className="h-8">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="Yes">Yes</SelectItem>
          <SelectItem value="No">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  if (def.type === "select") {
    return (
      <Select
        defaultOpen
        value={value}
        onValueChange={(v) => {
          onDraftChange(v);
          onCommit(v);
        }}
      >
        <SelectTrigger className="h-8">
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

  const placeholder =
    def.type === "currency"
      ? "£0.00"
      : def.type === "percent"
        ? "0.00%"
        : def.type === "number"
          ? "0"
          : def.type === "date"
            ? "YYYY-MM-DD"
            : "";

  return (
    <Input
      ref={inputRef}
      type={def.type === "date" ? "date" : "text"}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onDraftChange(e.target.value)}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit((e.target as HTMLInputElement).value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="h-8"
    />
  );
}
