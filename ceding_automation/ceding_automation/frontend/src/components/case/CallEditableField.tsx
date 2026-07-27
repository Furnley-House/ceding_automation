// frontend/src/components/case/CallEditableField.tsx
//
// Stage 5 (Call Assist) — one editable row in the "Outstanding fields"
// panel. Renders label + type-appropriate input side-by-side so the CA
// can type answers as the provider dictates them during the call.
//
// Every save goes through the same PATCH /cases/:id/checklist/:fieldId
// path Stage 4 uses, but with source: "CALL_EDIT" so the audit log
// distinguishes call-time edits from regular manual edits.

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

export interface CallEditableFieldProps {
  fieldKey: string;
  label: string;
  section: string;
  /** Matches ChecklistFieldDef.type from src/lib/checklistTemplates.ts. */
  type: "text" | "number" | "currency" | "percent" | "yesno" | "date" | "select";
  /** For select fields. */
  options?: string[];
  /** Current value (empty for missing fields, existing value for
   *  to-verify fields). */
  currentValue: string;
  /** Optional visual hint (e.g. confidence badge) displayed after the
   *  input — Callers can render a coloured Badge here. */
  trailing?: React.ReactNode;
  /** Optional leading indicator (usually the missing/review icon). */
  leading?: React.ReactNode;
  /** Save callback — receives the trimmed new value (empty string clears)
   *  and returns a promise that resolves on server acknowledgement or
   *  rejects with an error. */
  onSave: (nextValue: string) => Promise<void>;
  /** Disable interaction (e.g. mid-call read-only mode, or the field is
   *  a synthetic entry like Fund Details that can't be edited inline). */
  disabled?: boolean;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function CallEditableField({
  fieldKey: _fieldKey,
  label,
  section,
  type,
  options,
  currentValue,
  trailing,
  leading,
  onSave,
  disabled,
}: CallEditableFieldProps) {
  const [value, setValue] = useState(currentValue);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Track the last-saved value so we don't re-save on identical blur.
  const lastSavedRef = useRef<string>(currentValue);
  // Fade the "Saved" chip after a brief pause.
  const clearTimerRef = useRef<number | null>(null);

  // Server-side changes (undo/redo elsewhere, another tab, refresh
  // after the parent's refetch) should sync into this row when we're not
  // actively editing.
  useEffect(() => {
    setValue(currentValue);
    lastSavedRef.current = currentValue;
  }, [currentValue]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    };
  }, []);

  const commit = async (nextValue: string) => {
    const clean = nextValue.trim();
    if (clean === lastSavedRef.current.trim()) {
      setSaveState("idle");
      return;
    }
    setSaveState("saving");
    try {
      await onSave(clean);
      lastSavedRef.current = clean;
      setSaveState("saved");
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = window.setTimeout(() => setSaveState("idle"), 2000);
    } catch (err) {
      setSaveState("error");
      toast.error(`Couldn't save "${label}"`, {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const renderInput = () => {
    if (disabled) {
      return (
        <div className="flex-1 min-w-0 text-[11px] italic text-muted-foreground truncate">
          {value || "—"}
        </div>
      );
    }
    if (type === "yesno") {
      return (
        <Select value={value} onValueChange={(v) => { setValue(v); commit(v); }}>
          <SelectTrigger className="h-8 flex-1">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Yes">Yes</SelectItem>
            <SelectItem value="No">No</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    if (type === "select") {
      return (
        <Select value={value} onValueChange={(v) => { setValue(v); commit(v); }}>
          <SelectTrigger className="h-8 flex-1">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(options ?? []).map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    const placeholder =
      type === "currency"
        ? "£0.00"
        : type === "percent"
          ? "0.00%"
          : type === "number"
            ? "0"
            : type === "date"
              ? "YYYY-MM-DD"
              : "—";
    return (
      <Input
        type={type === "date" ? "date" : "text"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        className="h-8 flex-1 text-xs"
      />
    );
  };

  return (
    <div className="flex items-center gap-1.5 py-1">
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="flex-1 min-w-0">
        <p className="text-[11px] leading-tight text-foreground truncate" title={label}>
          {label}
        </p>
        <p className="text-[9px] text-muted-foreground truncate">{section}</p>
      </div>
      <div className="flex items-center gap-1.5 w-[48%] min-w-[140px]">
        {renderInput()}
        {/* Save status chip — takes fixed space so the input width doesn't
           flicker as the state cycles. */}
        <div className="w-4 h-4 shrink-0 flex items-center justify-center">
          {saveState === "saving" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {saveState === "saved" && <Check className="h-3 w-3 text-success" />}
        </div>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
    </div>
  );
}
