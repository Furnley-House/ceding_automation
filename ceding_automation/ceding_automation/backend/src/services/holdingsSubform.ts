// backend/src/services/holdingsSubform.ts
//
// Maps a case's verified fund lines onto the Holdings_List subform of the
// Zoho Plans module, and merges them with whatever is already on the Plan.
//
// FIELD NAMES ARE READ FROM ZOHO, NOT GUESSED. They were taken from
// GET /settings/fields?module=Holdings_List (Sept 2026) because a wrong API
// name does not fail — Zoho returns 200 and silently ignores the field, which
// is the same class of bug as the Provider one documented in export.ts. If the
// subform is ever changed, re-read the metadata rather than adjusting these by
// eye.
//
//   Holdings_List        the subform field on Plans — NOT "Holdings"
//   security_name        text       "Name"
//   isin                 text       "ISIN"
//   position             double     "Current Holding"
//   gbp_valuation        currency   "Unit Price (£)"   <- pounds, confirmed
//   Holdings_Valuation   currency   "Holdings Valuation"
//   valuation_date       date       "Last Price Update"
//   OCF                  percent    "OCF"
//   Transaction_Cost     percent    "Transaction Cost"
//   RAG                  picklist   -None- | Red | Amber | Green
//   Weighting            percent    "Weighting %"       <- left blank, by request
//   Parent_Id            lookup     read-only, system mandatory — never sent

import { HoldingRag, FundValueSource, type ChecklistFundLine } from "@prisma/client";

/** The subform field on the Plans module. */
export const HOLDINGS_SUBFORM = "Holdings_List";

/**
 * Keys Zoho returns on an existing subform row that must not be sent back.
 * Parent_Id is read-only; the timestamps are system-managed. Anything
 * "$"-prefixed is Zoho metadata rather than a field.
 */
const NOT_WRITABLE = new Set(["Parent_Id", "Created_Time", "Modified_Time"]);

export interface HoldingRow {
  [field: string]: unknown;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The figure the CA settled on at stage 6.
 *
 * Falls back to the other side when the chosen one is empty: the source flag
 * records a preference, and a preference for a value that does not exist
 * should not blank the field in CRM.
 */
function chosen<T>(source: FundValueSource | null, lookup: T | null, ceding: T | null): T | null {
  if (source === FundValueSource.LOOKUP) return lookup ?? ceding;
  if (source === FundValueSource.CEDING) return ceding ?? lookup;
  return ceding ?? lookup;
}

/** RAG enum -> the exact picklist labels the subform accepts. */
export function ragLabel(rag: HoldingRag | null): string | null {
  if (rag === HoldingRag.AMBER) return "Amber";
  if (rag === HoldingRag.RED) return "Red";
  return null; // unverified — leave the picklist alone rather than sending -None-
}

/** YYYY-MM-DD, which is what a Zoho date field expects. */
function isoDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * One subform row from one checklist fund line, carrying the figures the CA
 * approved at stage 6 — never a fresh lookup.
 */
export function buildHoldingRow(line: ChecklistFundLine): HoldingRow {
  const name = chosen(line.fundNameSource, line.resolvedFundName, line.fundName);
  const price = chosen(
    line.priceSource,
    num(line.resolvedUnitPrice),
    num(line.pricePerUnit),
  );
  const ocf = chosen(line.ocfSource, num(line.resolvedOcf), num(line.ocf));
  const txCost = chosen(
    line.txCostSource,
    num(line.resolvedTxCost),
    num(line.transactionCosts),
  );

  const row: HoldingRow = {
    security_name: name ?? line.fundName,
    // The resolved ISIN where we have one, else whatever the CA typed — a RED
    // holding still carries its identifier across, which is what makes it
    // fixable in CRM.
    isin: line.resolvedIsin ?? line.isinSedolCiti ?? null,
    position: num(line.numberOfUnits),
    gbp_valuation: price,
    Holdings_Valuation: num(line.value),
    valuation_date: isoDate(line.resolvedPriceDate),
    OCF: ocf,
    Transaction_Cost: txCost,
    RAG: ragLabel(line.holdingRag),
  };

  // Send only what we have. A null on a Zoho field clears it, and clearing a
  // figure somebody entered in CRM is not ours to do.
  for (const k of Object.keys(row)) {
    if (row[k] === null || row[k] === undefined) delete row[k];
  }
  return row;
}

/**
 * What identifies "the same holding" across the two sides.
 *
 * ISIN where there is one. A RED holding usually has no ISIN — that is
 * generally why it is red — so it falls back to the fund name, normalised the
 * same way the stage-6 comparison normalises it, so "RLS Deposit Pn." and
 * "RLS deposit pn" are one holding rather than two.
 */
export function holdingKey(row: HoldingRow): string | null {
  const isin = typeof row.isin === "string" ? row.isin.trim().toUpperCase() : "";
  if (isin) return `isin:${isin}`;
  const name = typeof row.security_name === "string" ? row.security_name : "";
  const normalised = name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  return normalised ? `name:${normalised}` : null;
}

/** Strip the keys Zoho will not accept back on an existing row. */
function echoable(row: HoldingRow): HoldingRow {
  const out: HoldingRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("$") || NOT_WRITABLE.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface MergeResult {
  rows: HoldingRow[];
  added: number;
  kept: number;
  /** Holdings already on the Plan, so not written again. */
  skipped: string[];
}

/**
 * Merge our holdings into the Plan's existing subform.
 *
 * A PUT REPLACES THE WHOLE SUBFORM — any row left out of the payload is
 * deleted. So every existing row is echoed back with its id, and ours are
 * appended after them. A holding already on the Plan is left exactly as it
 * is rather than updated: the CA may have corrected it in CRM, and this
 * export is not the authority on a row somebody else has touched.
 */
export function mergeHoldings(existing: HoldingRow[], incoming: HoldingRow[]): MergeResult {
  const kept = existing.map(echoable);
  const seen = new Set<string>();
  for (const row of existing) {
    const key = holdingKey(row);
    if (key) seen.add(key);
  }

  const added: HoldingRow[] = [];
  const skipped: string[] = [];

  for (const row of incoming) {
    const key = holdingKey(row);
    // A row with nothing to identify it cannot be deduped, and appending it
    // blindly would duplicate it on every export. Skip it and say so.
    if (!key) {
      skipped.push(String(row.security_name ?? "(unnamed holding)"));
      continue;
    }
    if (seen.has(key)) {
      skipped.push(String(row.security_name ?? key));
      continue;
    }
    seen.add(key);
    added.push(row);
  }

  return {
    rows: [...kept, ...added],
    added: added.length,
    kept: kept.length,
    skipped,
  };
}

/** Pull the existing subform rows off a Plan record fetched from Zoho. */
export function readExistingHoldings(record: Record<string, unknown>): HoldingRow[] {
  const raw = record[HOLDINGS_SUBFORM];
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is HoldingRow => Boolean(r) && typeof r === "object");
}
