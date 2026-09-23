// backend/src/services/fundMaster.ts
//
// Read-only access to the fund master (fund_master_feed on the Superbia
// Postgres, production@FUNDS). Supplies the reference fund name, OCF and
// transaction costs that stage-6 verification compares against what the CA
// entered. Prices do NOT come from here — see feFundInfo.ts.
//
// Separate physical database from ceding's own, so this uses `pg` directly
// rather than Prisma.
//
// READ-ONLY IS ENFORCED HERE, NOT BY THE GRANT. The credential we have been
// given (superbiateam) holds INSERT/UPDATE/DELETE on a 94k-row production
// table belonging to another team. Until a read-only role exists, the only
// thing standing between a future bug in this file and their live data is
// this file, so it makes the restriction explicit in two places:
//
//   1. every connection is put into default_transaction_read_only, so the
//      SERVER rejects any write — including one issued by code that never
//      went through assertReadOnly;
//   2. assertReadOnly refuses to send anything but a single SELECT, which
//      fails fast and loudly during development rather than at the database.
//
// Neither is a substitute for the grant. Ask for the read-only role.
//
// Configuration is optional at boot. Without FUND_DB_* the app starts fine and
// verification reports itself unavailable, rather than crashing every request.

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

/**
 * The same row reachable by whichever identifier the CA happened to type.
 * Built once per case so a holding is matched in memory rather than by a
 * query each.
 */
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

  // Every new connection is made read-only before it is used. pg queues
  // queries per client in order, so this runs ahead of whatever the caller
  // issues on a freshly-connected client. A write then fails at the server
  // with "cannot execute INSERT in a read-only transaction".
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

/**
 * Refuse to send anything that is not a single SELECT.
 *
 * Deliberately blunt: one leading SELECT, and no statement separator that
 * could smuggle a second statement in behind it. It is not a SQL parser and
 * does not try to be — it exists so that a write added to this file is caught
 * here, in a unit test, rather than by someone else's audit log.
 */
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

// One statement for a whole case, covering all three identifier types.
//
// The SEDOL arm exploits the construction of a GB ISIN: GB00 + the 7-char
// SEDOL + a check digit, so substring(isin from 5 for 7) IS the SEDOL. That
// is an equality test rather than a LIKE, which matters twice: it is a single
// scan for any number of SEDOLs, and pattern metacharacters in the input
// cannot change what it matches.
//
// Measured 21ms against ~95k rows with no index. If that grows, the fix is a
// functional index on substring(isin from 5 for 7), not a query change.
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

/**
 * Resolve a case's identifiers against the fund master in one round trip.
 *
 * Identifiers must already have been through classifyFundIdentifier — this
 * assumes it is handed validated ISINs, SEDOLs and Citi codes, never raw
 * checklist text.
 */
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
      ocf: toNumber(raw.ongoing_charges),
      transactionCosts: toNumber(raw.tx_costs),
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
