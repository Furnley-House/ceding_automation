// Should a checklist-field edit clear the field's existing approval?
//
// Every field is editable at Stage 6 Review Checklist, including ones a
// paraplanner has already approved. An approval was given to a specific
// value, so a *changed* value must go back to the paraplanner. Saving the
// same value (whitespace aside) keeps the approval. `newValue` undefined
// means the request didn't touch the value at all.
export function shouldClearApproval(
  isApproved: boolean,
  oldValue: string | null,
  newValue: string | null | undefined,
): boolean {
  if (!isApproved || newValue === undefined) return false;
  return (newValue ?? "").trim() !== (oldValue ?? "").trim();
}
