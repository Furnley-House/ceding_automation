// Client-side mirror of backend/src/services/optionalSections.ts value
// rules, used to count answers in a section from what's on screen *now*
// (the server's count is from the last fetch and misses edits made since).
// Keep in sync with the backend.

/** "N/A", "n/a", "NA". */
export function isNotApplicableValue(v: string | null | undefined): boolean {
  const t = (v ?? "").trim().toUpperCase();
  return t === "N/A" || t === "NA";
}

/** A value that counts as a real answer (not blank, MISSING or N/A). */
export function isRealValue(v: string | null | undefined): boolean {
  const t = (v ?? "").trim();
  return t !== "" && t.toUpperCase() !== "MISSING" && !isNotApplicableValue(t);
}
