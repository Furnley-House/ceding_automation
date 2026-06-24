// backend/src/utils/compareFieldValues.ts
//
// Multi-doc CONFLICT canonicalization. The raw `!==` check used by the merge
// paths (aiBffApply / triggerExtraction) flags semantically-equivalent values
// as conflicts — e.g. "Aviva" vs "Aviva Life & Pensions UK Limited", "£10,558.60"
// vs "10558.6", or "Yes" vs "yes". This module normalises by ChecklistTemplate
// fieldType so only genuine disagreements raise CONFLICT.
//
// Per-type comparators (Phase 1) + provider-alias resolution via Provider
// registry canonical (Phase 2). Snapshot-pair handling (Phase 3) deferred.

export type ComparisonResult = "equivalent" | "different";

export interface CompareContext {
  /** Canonical provider name (e.g. from BFF detectedProvider.canonical, or
   *  Case.provider.name). When set and fieldKey === "provider_name", values
   *  that both contain this canonical are treated as equivalent. */
  providerCanonical?: string;
}

export function compareFieldValues(
  a: string | null | undefined,
  b: string | null | undefined,
  fieldType?: string,
  fieldKey?: string,
  context?: CompareContext,
): ComparisonResult {
  // ── (1) Null / empty equivalence ──────────────────────────────
  // Two tiers:
  //   isEmpty    — truly absent ("", null, "null")
  //   isNoneLike — semantically nothing ("none", "n/a", "no", "0", …)
  // Both-empty or empty-vs-none-like resolves to equivalent. Empty vs a real
  // value is "different" (we don't claim an absent field matches a real one).
  // None-like values that are both non-empty fall through to per-type
  // comparators so e.g. "No" vs "None" gets boolean treatment and "None" vs
  // "No regular contributions" gets the text none-phrase logic.
  if (isEmpty(a) && isEmpty(b)) return "equivalent";
  if (isEmpty(a) && isNoneLike(b)) return "equivalent";
  if (isEmpty(b) && isNoneLike(a)) return "equivalent";
  if (isEmpty(a) || isEmpty(b)) return "different";

  const aTrim = String(a).trim();
  const bTrim = String(b).trim();
  if (aTrim === bTrim) return "equivalent";

  // ── (2) Provider-alias resolution ─────────────────────────────
  // Runs before type dispatch so e.g. "Aviva" vs "Aviva Life & Pensions UK
  // Limited" with canonical="Aviva" resolves to equivalent regardless of
  // whether the template labels provider_name as text or dropdown.
  if (fieldKey === "provider_name" && context?.providerCanonical) {
    const canonical = context.providerCanonical.toLowerCase().trim();
    if (canonical.length > 0) {
      const aLower = aTrim.toLowerCase();
      const bLower = bTrim.toLowerCase();
      if (aLower.includes(canonical) && bLower.includes(canonical)) {
        return "equivalent";
      }
    }
  }

  // ── (3) Per-type comparators ──────────────────────────────────
  const type = (fieldType ?? "text").toLowerCase();
  switch (type) {
    case "currency":
    case "number":
      return compareCurrency(aTrim, bTrim);
    case "percentage":
    case "percent":
      return comparePercent(aTrim, bTrim);
    case "date":
      return compareDate(aTrim, bTrim);
    case "yes_no":
    case "boolean":
      return compareBoolean(aTrim, bTrim);
    case "dropdown":
      return compareCaseInsensitive(aTrim, bTrim);
    default:
      return compareText(aTrim, bTrim);
  }
}

// ── helpers ──────────────────────────────────────────────────────

function isEmpty(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return s === "" || s === "null";
}

function isNoneLike(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return (
    s === "" ||
    s === "null" ||
    s === "none" ||
    s === "n/a" ||
    s === "not applicable" ||
    s === "no" ||
    s === "0" ||
    s === "zero" ||
    s === "nil"
  );
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]$/, "")
    .trim();
}

function compareText(a: string, b: string): ComparisonResult {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return "equivalent";

  // Prefix tolerance: one value is a clean prefix of the other AND covers
  // ≥85% of the longer value's length. Conservative threshold to avoid
  // collapsing genuinely-distinct truncations.
  const [shorter, longer] = na.length < nb.length ? [na, nb] : [nb, na];
  if (longer.startsWith(shorter) && shorter.length >= longer.length * 0.85) {
    return "equivalent";
  }

  // "None" family — both values must be a none-equivalent for this to fire.
  const noneAliases = new Set(["none", "no", "n/a", "not applicable", "0", "zero", "nil"]);
  if (noneAliases.has(na) && noneAliases.has(nb)) return "equivalent";
  const isNonePhrase = (s: string) =>
    s === "none" || s === "no regular contributions" || s.startsWith("no ");
  if (isNonePhrase(na) && isNonePhrase(nb)) return "equivalent";

  return "different";
}

function parseCurrency(s: string): number | null {
  const cleaned = s.replace(/[£$€,\s]/g, "").replace(/[a-zA-Z]/g, "").trim();
  if (cleaned === "") return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function compareCurrency(a: string, b: string): ComparisonResult {
  const na = parseCurrency(a);
  const nb = parseCurrency(b);
  if (na === null || nb === null) return compareText(a, b);
  return Math.abs(na - nb) <= 0.01 ? "equivalent" : "different";
}

function parsePercent(s: string): number | null {
  const cleaned = s.replace(/[%\s]/g, "").replace(/[a-zA-Z]/g, "").trim();
  if (cleaned === "") return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function comparePercent(a: string, b: string): ComparisonResult {
  const na = parsePercent(a);
  const nb = parsePercent(b);
  if (na === null || nb === null) return compareText(a, b);
  return Math.abs(na - nb) <= 0.02 ? "equivalent" : "different";
}

function parseDate(s: string): string | null {
  const isoMatch = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const ukMatch = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (ukMatch) {
    const [, d, m, y] = ukMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

function compareDate(a: string, b: string): ComparisonResult {
  const da = parseDate(a);
  const db = parseDate(b);
  if (da === null || db === null) return compareText(a, b);
  return da === db ? "equivalent" : "different";
}

function normalizeBoolean(s: string): boolean | null {
  const n = s.toLowerCase().trim();
  if (["yes", "y", "true", "1"].includes(n)) return true;
  if (["no", "n", "false", "0", "none"].includes(n)) return false;
  return null;
}

function compareBoolean(a: string, b: string): ComparisonResult {
  const na = normalizeBoolean(a);
  const nb = normalizeBoolean(b);
  if (na === null || nb === null) return compareText(a, b);
  return na === nb ? "equivalent" : "different";
}

function compareCaseInsensitive(a: string, b: string): ComparisonResult {
  return a.toLowerCase().trim() === b.toLowerCase().trim() ? "equivalent" : "different";
}
