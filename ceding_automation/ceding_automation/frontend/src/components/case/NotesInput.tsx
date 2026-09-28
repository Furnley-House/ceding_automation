// Auto-growing editor for free-text checklist fields. Grows with its content
// so long answers (e.g. Death Benefits) stay fully visible while editing
// instead of scrolling sideways out of a single-line input.
//
// Notes fields (allowNewlines) let the team structure notes over lines:
//   Shift+Enter or Alt+Enter → new line
//   Enter                    → save
// Every other text field stays one paragraph (it lands in a single export
// cell): any Enter saves, and pasted line breaks become spaces.
//   Escape                   → cancel (when the caller supports it)

import { forwardRef, useLayoutEffect, useRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import type { ChecklistFieldDef } from "@/lib/checklistTemplates";

/** True for free-text notes fields — the only ones that accept line breaks. */
export function isNotesField(def: Pick<ChecklistFieldDef, "key" | "label" | "type">): boolean {
  if (def.type !== "text") return false;
  return def.key === "other_notes" || /_notes$/.test(def.key) || /\bnotes\b/i.test(def.label);
}

/** Insert a newline at the caret. Alt+Enter has no native behaviour in a
 *  <textarea>, so it is done by hand; Shift+Enter is native. */
export function insertNewlineAtCaret(el: HTMLTextAreaElement, onChange: (v: string) => void) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = `${el.value.slice(0, start)}\n${el.value.slice(end)}`;
  onChange(next);
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = start + 1;
  });
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Plain Enter. Receives the current text. */
  onCommit: (v: string) => void;
  onBlur?: (v: string) => void;
  onCancel?: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Shift/Alt+Enter insert a line break. Default true (notes fields). */
  allowNewlines?: boolean;
}

export const NotesInput = forwardRef<HTMLTextAreaElement, Props>(function NotesInput(
  { value, onChange, onCommit, onBlur, onCancel, disabled, placeholder = "—", className = "", allowNewlines = true },
  forwardedRef,
) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const setRefs = (el: HTMLTextAreaElement | null) => {
    localRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  // Auto-grow to fit the content.
  useLayoutEffect(() => {
    const el = localRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div className="w-full">
      <Textarea
        ref={setRefs}
        value={value}
        disabled={disabled}
        rows={allowNewlines ? 2 : 1}
        placeholder={placeholder}
        onChange={(e) =>
          onChange(allowNewlines ? e.target.value : e.target.value.replace(/\r?\n/g, " "))
        }
        onBlur={(e) => onBlur?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !allowNewlines) {
            e.preventDefault();
            onCommit(e.currentTarget.value);
          } else if (e.key === "Enter" && e.altKey) {
            e.preventDefault();
            insertNewlineAtCaret(e.currentTarget, onChange);
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onCommit(e.currentTarget.value);
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
          // Shift+Enter falls through: the textarea inserts the newline.
        }}
        className={`min-h-[36px] resize-none overflow-hidden text-sm leading-snug ${className}`}
      />
      {!disabled && allowNewlines && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          Shift+Enter or Alt+Enter for a new line · Enter to save
        </p>
      )}
    </div>
  );
});
