import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

// Stage 4 field-value undo/redo. Session-only: the two stacks live in
// component state, so a full page reload clears history (by design — a
// stale entry could otherwise revert a colleague's edit made in another
// browser). Scope is deliberately limited to field VALUE changes; status
// flips (Approve, Request-review), the "Mark N missing as N/A" batch, and
// evidence-link edits are NOT tracked (see docstring comments in the
// caller for the reasoning).

export interface EditHistoryEntry {
  fieldKey: string;
  /** Human-friendly label for toast messages. */
  fieldLabel: string;
  prev: string | null;
  next: string | null;
}

interface UseEditHistoryArgs {
  /**
   * Persist a value change (typically wraps `useChecklistFields.updateField`
   * with `{ value }` in the patch). Called during undo/redo — errors are
   * caught here and roll the stack back so the button state matches the
   * server state.
   */
  applyValue: (fieldKey: string, value: string | null) => Promise<void>;
  /** Cap stack depth. 50 is plenty for a single review session. */
  maxEntries?: number;
}

export interface UseEditHistoryReturn {
  record: (entry: EditHistoryEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
  /** Reset both stacks — call when the case id changes. */
  reset: () => void;
}

export function useEditHistory({
  applyValue,
  maxEntries = 50,
}: UseEditHistoryArgs): UseEditHistoryReturn {
  const [undoStack, setUndoStack] = useState<EditHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<EditHistoryEntry[]>([]);

  // Callers pass a fresh `applyValue` on every render (it closes over
  // updateField, which itself changes when refresh/rows update). Route it
  // through a ref so undo/redo don't re-register on every parent render
  // and keyboard shortcuts stay wired.
  const applyValueRef = useRef(applyValue);
  applyValueRef.current = applyValue;

  const record = useCallback(
    (entry: EditHistoryEntry) => {
      // No-op edit (autosave triggered by focus/blur with unchanged value).
      if (entry.prev === entry.next) return;
      setUndoStack((s) => {
        const next = [...s, entry];
        return next.length > maxEntries ? next.slice(-maxEntries) : next;
      });
      // Any new edit invalidates the redo forward-history — matches the
      // standard editor convention.
      setRedoStack([]);
    },
    [maxEntries],
  );

  const undo = useCallback(async () => {
    if (undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((r) => [...r, entry]);
    try {
      await applyValueRef.current(entry.fieldKey, entry.prev);
      toast.success("Undo", {
        description: `${entry.fieldLabel} → ${entry.prev ?? "(empty)"}`,
      });
    } catch {
      // Roll back on failure so the UI state matches the server.
      setUndoStack((s) => [...s, entry]);
      setRedoStack((r) => r.slice(0, -1));
      toast.error("Undo failed — value not restored");
    }
  }, [undoStack]);

  const redo = useCallback(async () => {
    if (redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((s) => {
      const next = [...s, entry];
      return next.length > maxEntries ? next.slice(-maxEntries) : next;
    });
    try {
      await applyValueRef.current(entry.fieldKey, entry.next);
      toast.success("Redo", {
        description: `${entry.fieldLabel} → ${entry.next ?? "(empty)"}`,
      });
    } catch {
      setRedoStack((r) => [...r, entry]);
      setUndoStack((s) => s.slice(0, -1));
      toast.error("Redo failed — value not restored");
    }
  }, [redoStack, maxEntries]);

  const reset = useCallback(() => {
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  return {
    record,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoCount: undoStack.length,
    redoCount: redoStack.length,
    reset,
  };
}
