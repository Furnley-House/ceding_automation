import { Pool, type PoolConfig } from "pg";
import type { LookupKeys } from "../utils/fundIdentifier";

const TABLE = process.env.FUND_DB_TABLE ?? "fund_master_feed";

export interface FundMasterRow {
  isin: string;
  citiCode: string | null;
  fundName: string;
  /** Percentage as displayed, e.g. 0.75 means 0.75% — same scale ceding stores. */
  ocf: number | null;
  transactionCosts: number | null;
}

const CHARGE_FRACTION_TO_PERCENT = 100;

export interface FundMasterIndex {
  byIsin: Map<string, FundMasterRow>;
  bySedol: Map<string, FundMasterRow>;
  byCiti: Map<string, FundMasterRow>;
}

export function isFundMasterConfigured(): boolean {
  return Boolean(process.env.FUND_DB_HOST && process.env.FUND_DB_NAME && process.env.FUND_DB_USER);
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  if (!isFundMasterConfigured()) {
    throw new Error("Fund master not configured — set FUND_DB_HOST / FUND_DB_NAME / FUND_DB_USER");
  }
  const cfg: PoolConfig = {
    host: process.env.FUND_DB_HOST,
    port: Number(process.env.FUND_DB_PORT) || 5432,
    database: process.env.FUND_DB_NAME,
    user: process.env.FUND_DB_USER,
    password: process.env.FUND_DB_PASSWORD,
    // Azure Postgres requires TLS.
    ssl: { rejectUnauthorized: false },
    // Bounded on purpose: a stuck query must not be able to exhaust
    // connections on someone else's production database.
    max: Number(process.env.FUND_DB_POOL_MAX) || 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    // So their DBA can see who is connecting, and kill us specifically if we
    // ever misbehave on their production instance.
    application_name: "ceding-automation (read-only)",
  };
  pool = new Pool(cfg);
  pool.on("connect", (client) => {
    client
      .query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
      .catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.error("[fundMaster] could not set the session read-only:", err.message);
      });
  });

  pool.on("error", (err) => {
    // An idle client erroring must not take the process down.
    // eslint-disable-next-line no-console
    console.error("[fundMaster] idle client error:", err.message);
  });
  return pool;
}

export function assertReadOnly(sql: string): void {
  const stripped = sql
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .trim();

  if (!/^select\b/i.test(stripped)) {
    throw new Error("fundMaster may only run SELECT statements");
  }
  // A trailing semicolon is fine; one that has anything after it is not.
  if (/;\s*\S/.test(stripped)) {
    throw new Error("fundMaster may only run a single statement");
  }
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toPercent(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  return Math.round(n * CHARGE_FRACTION_TO_PERCENT * 10_000) / 10_000;
}

const LOOKUP_SQL = `
  SELECT isin,
         citi_code,
         legal_fund_name_including_umbrella AS fund_name,
         ongoing_charges,
         emt_financial_instrument_transaction_costs_ex_ante_uk AS tx_costs
    FROM ${TABLE}
   WHERE isin = ANY($1::text[])
      OR (left(isin, 4) = 'GB00' AND substring(isin from 5 for 7) = ANY($2::text[]))
      OR citi_code = ANY($3::text[])
`;

export async function lookupFunds(keys: LookupKeys): Promise<FundMasterIndex> {
  const empty: FundMasterIndex = {
    byIsin: new Map(),
    bySedol: new Map(),
    byCiti: new Map(),
  };

  const { isins, sedols, citiCodes } = keys;
  if (isins.length === 0 && sedols.length === 0 && citiCodes.length === 0) {
    return empty; // nothing usable on this case — don't open a connection
  }

  assertReadOnly(LOOKUP_SQL);
  const res = await getPool().query(LOOKUP_SQL, [isins, sedols, citiCodes]);

  for (const raw of res.rows as Array<Record<string, unknown>>) {
    const isin = String(raw.isin ?? "").toUpperCase();
    if (!isin) continue;

    const row: FundMasterRow = {
      isin,
      citiCode: raw.citi_code ? String(raw.citi_code).toUpperCase() : null,
      fundName: String(raw.fund_name ?? "").trim(),
      ocf: toPercent(raw.ongoing_charges),
      transactionCosts: toPercent(raw.tx_costs),
    };

    empty.byIsin.set(isin, row);
    // Reachable by the SEDOL the CA typed, for GB ISINs.
    if (isin.startsWith("GB00") && isin.length === 12) {
      empty.bySedol.set(isin.slice(4, 11), row);
    }
    if (row.citiCode) empty.byCiti.set(row.citiCode, row);
  }

  return empty;
}

/** Close the pool — for tests and graceful shutdown. */
export async function closeFundMasterPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
