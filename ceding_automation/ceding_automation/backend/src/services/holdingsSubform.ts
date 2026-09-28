import { HoldingRag, FundValueSource, type ChecklistFundLine } from "@prisma/client";

/** The subform field on the Plans module. */
export const HOLDINGS_SUBFORM = "Holdings_List";

export interface HoldingRow {
  [field: string]: unknown;
}

const DECIMALS: Record<string, number> = {
  gbp_valuation: 2,
  Holdings_Valuation: 2,
  OCF: 2,
  Transaction_Cost: 2,
  Weighting: 2,
  position: 9,
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Round to the places the field allows, half away from zero. */
export function toFieldScale(field: string, v: number | null): number | null {
  if (v === null) return null;
  const dp = DECIMALS[field];
  if (dp === undefined) return v;
  const factor = 10 ** dp;
  // Math.round(-0.185 * 100) is -18, not -19, so sign is handled explicitly —
  // transaction costs are routinely negative.
  const scaled = v * factor;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / factor;
}

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

  return {
    security_name: name ?? line.fundName,
    // The resolved ISIN where we have one, else whatever the CA typed — a RED
    // holding still carries its identifier across, which is what makes it
    // fixable in CRM.
    isin: line.resolvedIsin ?? line.isinSedolCiti ?? null,
    position: toFieldScale("position", num(line.numberOfUnits)),
    gbp_valuation: toFieldScale("gbp_valuation", price),
    Holdings_Valuation: toFieldScale("Holdings_Valuation", num(line.value)),
    valuation_date: isoDate(line.resolvedPriceDate),
    OCF: toFieldScale("OCF", ocf),
    Transaction_Cost: toFieldScale("Transaction_Cost", txCost),
    RAG: ragLabel(line.holdingRag),
  };
}

const OWNED_FIELDS = [
  "security_name",
  "isin",
  "position",
  "gbp_valuation",
  "Holdings_Valuation",
  "valuation_date",
  "OCF",
  "Transaction_Cost",
  "RAG",
] as const;

function forInsert(row: HoldingRow): HoldingRow {
  const out: HoldingRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export function holdingKey(row: HoldingRow): string | null {
  const isin = typeof row.isin === "string" ? row.isin.trim().toUpperCase() : "";
  if (isin) return `isin:${isin}`;
  const name = typeof row.security_name === "string" ? row.security_name : "";
  const normalised = name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  return normalised ? `name:${normalised}` : null;
}

/** The id Zoho gave an existing subform row, if it has one. */
function rowId(row: HoldingRow): string | null {
  return typeof row.id === "string" && row.id ? row.id : null;
}

export interface MergeResult {
  rows: HoldingRow[];
  /** Holdings that were not on the Plan before. */
  added: number;
  /** Holdings we own that were already there and have been refreshed. */
  updated: number;
  /** Rows on the Plan that are nothing to do with this case, left alone. */
  kept: number;
  /** Rows this case put there previously and has since deleted. */
  removed: string[];
  /** Incoming rows with nothing to identify them by, so not written. */
  skipped: string[];
  /** The keys this export owns, to store against the case for next time. */
  ownedKeys: string[];
}

export function mergeHoldings(
  existing: HoldingRow[],
  incoming: HoldingRow[],
  previouslyExported: readonly string[] = [],
): MergeResult {
  // Index what we are pushing, so each existing row can find its counterpart.
  const byKey = new Map<string, HoldingRow>();
  const skipped: string[] = [];
  for (const row of incoming) {
    const key = holdingKey(row);
    // Nothing to identify it by: it can neither be matched to an existing row
    // nor safely appended, since appending would duplicate it every export.
    if (!key) {
      skipped.push(String(row.security_name ?? "(unnamed holding)"));
      continue;
    }
    // Two checklist lines for the same fund — the first wins, as before.
    if (!byKey.has(key)) byKey.set(key, row);
  }

  const previouslyOurs = new Set(previouslyExported);
  const rows: HoldingRow[] = [];
  const matched = new Set<string>();
  const removed: string[] = [];
  let updated = 0;
  let kept = 0;

  for (const row of existing) {
    const key = holdingKey(row);
    const id = rowId(row);
    const ours = key ? byKey.get(key) : undefined;

    if (ours && id) {
      matched.add(key!);
      updated += 1;
      const patch: HoldingRow = { id };
      for (const f of OWNED_FIELDS) patch[f] = ours[f] ?? null;
      rows.push(patch);
      continue;
    }
    if (id && key && previouslyOurs.has(key)) {
      removed.push(String(row.security_name ?? key));
      rows.push({ id, _delete: null });
      continue;
    }
    kept += 1;
  }

  const added: HoldingRow[] = [];
  for (const [key, row] of byKey) {
    if (matched.has(key)) continue;
    added.push(forInsert(row));
  }

  return {
    rows: [...rows, ...added],
    added: added.length,
    updated,
    kept,
    removed,
    skipped,
    ownedKeys: [...byKey.keys()],
  };
}

/** Pull the existing subform rows off a Plan record fetched from Zoho. */
export function readExistingHoldings(record: Record<string, unknown>): HoldingRow[] {
  const raw = record[HOLDINGS_SUBFORM];
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is HoldingRow => Boolean(r) && typeof r === "object");
}
