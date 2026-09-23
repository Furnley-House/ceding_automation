// backend/src/utils/fundIdentifier.ts
//
// ChecklistFundLine.isinSedolCiti is one free-text column holding an ISIN, a
// SEDOL, a Citi code, a placeholder, or junk — whatever the CA typed. Across
// production (Sept 2026, 550 rows): 249 ISIN, 174 SEDOL, 88 blank, 17
// placeholder ("N/A", "Nil", "-"), 13 other, 5 Citi, 4 with two codes in one
// cell.
//
// Everything that reaches the fund master or FE Fund Info goes through here
// first. That is partly to decide HOW to look a row up, and partly a security
// control: the SEDOL match runs inside a SQL comparison, so an unvalidated
// value containing wildcard or quote characters must never reach it. Anything
// that does not match one of the three shapes exactly is UNUSABLE and is never
// sent anywhere — it becomes a RED holding, which is the honest answer.

export type IdentifierKind = "ISIN" | "SEDOL" | "CITI" | "UNUSABLE";

export interface ClassifiedIdentifier {
  /** Exactly what was stored, untouched. */
  raw: string | null;
  /** Trimmed + uppercased, and for a multi-code cell the part we matched on. */
  value: string | null;
  kind: IdentifierKind;
}

// ISIN: 2-letter country code, 9 alphanumeric, 1 check digit.
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
// SEDOL: 7 chars, consonants and digits only — the alphabet deliberately
// excludes vowels, so a value containing one is not a SEDOL.
const SEDOL_RE = /^[0-9BCDFGHJKLMNPQRSTVWXYZ]{7}$/;
// Citi code: 4 alphanumeric (FE Fund Info's internal code).
const CITI_RE = /^[A-Z0-9]{4}$/;

const PLACEHOLDERS = new Set(["", "-", "--", "N/A", "NA", "N\A", "NIL", "NONE", "TBC", "?"]);

function classifyOne(token: string): IdentifierKind {
  if (PLACEHOLDERS.has(token)) return "UNUSABLE";
  if (ISIN_RE.test(token)) return "ISIN";
  if (SEDOL_RE.test(token)) return "SEDOL";
  if (CITI_RE.test(token)) return "CITI";
  return "UNUSABLE";
}

/**
 * Work out what kind of identifier a fund line carries, if any.
 *
 * Cells holding two codes ("SWXBJ2 / BCLXQL4") are split and the first part
 * that classifies wins — better than failing the row outright, and the loser
 * is redundant anyway since both name the same fund.
 */
export function classifyFundIdentifier(
  raw: string | null | undefined,
): ClassifiedIdentifier {
  if (raw === null || raw === undefined) {
    return { raw: null, value: null, kind: "UNUSABLE" };
  }

  // Internal whitespace is stripped too: "GB00 B4W9 CK61" is a real way for a
  // value to arrive from a PDF, and it is the same identifier.
  const cleaned = raw.trim().toUpperCase();

  for (const token of cleaned.split("/").map((t) => t.replace(/\s+/g, ""))) {
    const kind = classifyOne(token);
    if (kind !== "UNUSABLE") return { raw, value: token, kind };
  }

  return { raw, value: null, kind: "UNUSABLE" };
}

export interface LookupKeys {
  /** Look up directly against fund_master_feed.isin */
  isins: string[];
  /** Matched via substring(isin from 5 for 7) — a GB ISIN is GB00 + SEDOL + check digit */
  sedols: string[];
  /** Matched against fund_master_feed.citi_code */
  citiCodes: string[];
}

/**
 * Collapse a case's fund lines into the three de-duplicated key sets the fund
 * master query takes, so a case costs ONE query rather than one per holding.
 * Unusable identifiers are dropped — they have nothing to look up.
 */
export function collectLookupKeys(
  identifiers: Array<string | null | undefined>,
): LookupKeys {
  const isins = new Set<string>();
  const sedols = new Set<string>();
  const citiCodes = new Set<string>();

  for (const raw of identifiers) {
    const { kind, value } = classifyFundIdentifier(raw);
    if (!value) continue;
    if (kind === "ISIN") isins.add(value);
    else if (kind === "SEDOL") sedols.add(value);
    else if (kind === "CITI") citiCodes.add(value);
  }

  return {
    isins: [...isins],
    sedols: [...sedols],
    citiCodes: [...citiCodes],
  };
}
