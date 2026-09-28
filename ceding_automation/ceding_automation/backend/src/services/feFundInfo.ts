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
