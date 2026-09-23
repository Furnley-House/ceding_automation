// backend/src/services/feFundInfo.ts
//
// Unit prices from FE Fund Info, for stage-6 holdings verification. Ported
// from the Catalyst holdings proxy (Prabu, 2026) so ceding can price holdings
// without a second network hop through Catalyst — the fund master it also
// queried turned out to be plain Azure Postgres, reachable directly, so the
// proxy was left holding only these credentials.
//
// Kept from the original: client-credentials token with an in-process cache,
// 10-ISIN batching (the pricing endpoint refuses more), and one retry with a
// fresh token on 401 — FE expires tokens early often enough to matter.
//
// Added here, because this sits on a path a CA is waiting on:
//   - explicit timeouts (axios has none by default, so a hung FE request
//     would hang the CA's screen indefinitely)
//   - batch failures are isolated, so one bad batch cannot lose the prices
//     that did come back
//
// Configuration is optional at boot: without FEFUNDINFO_* the app starts and
// verification reports itself unavailable.

import axios, { type AxiosInstance } from "axios";

const BATCH_SIZE = Number(process.env.FEFUNDINFO_BATCH_SIZE) || 10;
const TIMEOUT_MS = Number(process.env.FEFUNDINFO_TIMEOUT_MS) || 10_000;

export interface FundPrice {
  isin: string;
  /** Price in `currency`, as FE reports it. */
  unitPrice: number;
  /** YYYY-MM-DD — what "Last Price Update" means on the Zoho subform. */
  priceDate: string | null;
  citiCode: string | null;
  /** Reported currency. The Zoho subform field is a GBP amount, so anything
   *  else must be surfaced rather than pushed as if it were sterling. */
  currency: string | null;
}

export function isFeFundInfoConfigured(): boolean {
  return Boolean(
    process.env.FEFUNDINFO_TOKEN_URL &&
      process.env.FEFUNDINFO_CLIENT_ID &&
      process.env.FEFUNDINFO_CLIENT_SECRET &&
      process.env.FEFUNDINFO_API_URL,
  );
}

let http: AxiosInstance | null = null;
function client(): AxiosInstance {
  if (!http) http = axios.create({ timeout: TIMEOUT_MS });
  return http;
}

// ── Token ────────────────────────────────────────────────────
let cachedToken: string | null = null;
let tokenExpiry = 0;

export function invalidateTokenCache(): void {
  cachedToken = null;
  tokenExpiry = 0;
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!isFeFundInfoConfigured()) {
    throw new Error("FE Fund Info not configured — set FEFUNDINFO_* in the environment");
  }

  const res = await client().post(
    process.env.FEFUNDINFO_TOKEN_URL!,
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: process.env.FEFUNDINFO_SCOPE ?? "",
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      auth: {
        username: process.env.FEFUNDINFO_CLIENT_ID!,
        password: process.env.FEFUNDINFO_CLIENT_SECRET!,
      },
    },
  );

  const token = res.data?.access_token as string | undefined;
  if (!token) throw new Error("FE Fund Info returned no access_token");

  // Expire a minute early so a request cannot start on a token that dies mid-flight.
  const ttl = Number(res.data?.expires_in) || 3600;
  cachedToken = token;
  tokenExpiry = Date.now() + (ttl - 60) * 1000;
  return token;
}

// ── Pricing ──────────────────────────────────────────────────
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchBatch(isins: string[], token: string): Promise<unknown[]> {
  const res = await client().get(process.env.FEFUNDINFO_API_URL!, {
    params: { identifierType: "isins", identifierValue: isins.join(",") },
    headers: {
      Authorization: `Bearer ${token}`,
      "Fefi-Apim-Subscription-Key": process.env.FEFI_APIM_SUBSCRIPTION_KEY ?? "",
    },
  });
  return (res.data?.Results as unknown[]) ?? [];
}

// FE returns the price under different field codes depending on the fund, and
// which codes appear varies per instrument rather than per request. Measured
// against ten real ceding holdings (Sept 2026):
//
//   OFDY908102   10/10   present on every fund
//   OFDY000020    8/10
//   OFDY908005    2/10   <- the only code the Catalyst proxy reads
//
// Re-measured against a random 41-fund sample from the fund master:
//
//   OFDY908102   41/41   present on every fund
//   OFDY000020   23/41   agrees with 908102 in all 23
//   OFDY000025   20/41   consistently ~5% higher — looks like an offer price
//   OFDY908005   18/41
//
// So preferring 908102 is safe as well as the most complete. One counter-
// example is known — GB0000011444 returns 908102=13.767774 against
// 000020=9.896871 — so this is "agrees almost always", not "always"; if a
// holding is ever priced oddly, that fund is the shape of the problem.
// Reading only OFDY908005, as the proxy does, leaves more than half of these
// unpriced and therefore RED.
//
// UNIT IS AMBIGUOUS: FE reports Currency "GBP" whether the fund is quoted in
// pounds or in pence — GB00B3ZHN960 comes back as 233.4637 for a fund worth
// about £2.33. Nothing in the payload distinguishes them, so this is left as
// FE states it and the stage-6 comparison flags a 100x gap against the CA's
// figure for them to settle.
const PRICE_FIELDS = ["OFDY908102", "OFDY000020", "OFDY908005"] as const;
const DATE_FIELD = "OFDY000021";

function firstPrice(
  result: Record<string, unknown>,
): { value: number; currency: string | null } | null {
  for (const field of PRICE_FIELDS) {
    const entry = (result[field] as Array<{ Value?: unknown; Currency?: unknown }> | undefined)?.[0];
    if (!entry) continue;
    const n = typeof entry.Value === "number" ? entry.Value : Number(entry.Value);
    if (!Number.isFinite(n)) continue;
    return { value: n, currency: typeof entry.Currency === "string" ? entry.Currency : null };
  }
  return null;
}

function toPrice(result: Record<string, unknown>): FundPrice | null {
  const isin = typeof result.Isin === "string" ? result.Isin.toUpperCase() : "";
  if (!isin) return null;

  // Quoted by FE but carrying no usable price in any field — the caller treats
  // this as RED, which is different from the lookup having failed.
  const price = firstPrice(result);
  if (!price) return null;

  const rawDate = result[DATE_FIELD];
  return {
    isin,
    unitPrice: price.value,
    priceDate: typeof rawDate === "string" ? rawDate.split("T")[0] : null,
    citiCode: typeof result.CitiCode === "string" ? result.CitiCode.toUpperCase() : null,
    currency: price.currency,
  };
}

/**
 * Prices for a set of ISINs, keyed by ISIN.
 *
 * An ISIN missing from the result simply has no price — that is a normal
 * outcome (FE does not cover everything) and the holding becomes RED. It is
 * NOT an error, and must not be confused with the lookup having failed, which
 * throws.
 */
export async function fetchPrices(isins: string[]): Promise<Map<string, FundPrice>> {
  const prices = new Map<string, FundPrice>();
  const unique = [...new Set(isins.filter((i) => i && i.trim().length > 0))];
  if (unique.length === 0) return prices;

  let token = await getToken();

  for (const batch of chunk(unique, BATCH_SIZE)) {
    let results: unknown[];
    try {
      results = await fetchBatch(batch, token);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== 401) throw err;
      // FE hands out tokens that die earlier than advertised. One retry.
      invalidateTokenCache();
      token = await getToken();
      results = await fetchBatch(batch, token);
    }

    for (const raw of results) {
      const price = toPrice(raw as Record<string, unknown>);
      // Keep the first price per ISIN — FE can return several share-class rows.
      if (price && !prices.has(price.isin)) prices.set(price.isin, price);
    }
  }

  return prices;
}
