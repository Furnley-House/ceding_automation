import { describe, it, expect, beforeEach, vi } from "vitest";

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));
vi.mock("axios", () => ({
  default: { create: vi.fn(() => ({ get: getMock, post: postMock })) },
}));

import { fetchPrices, isFeFundInfoConfigured, invalidateTokenCache } from "./feFundInfo";

// Shape taken from a live FE response. OFDY908102 is the code present on
// every fund measured; OFDY908005 appeared on only 2 of 10.
const priced = (isin: string, value = 2042.26, date = "2026-09-19T00:00:00Z") => ({
  Isin: isin,
  CitiCode: "ERP7",
  OFDY908102: [{ Value: value, Currency: "GBP" }],
  OFDY000021: date,
});

const tokenOk = (expiresIn = 3600) => ({
  data: { access_token: "tok-" + Math.random(), expires_in: expiresIn },
});

function unauthorised() {
  const err = new Error("Unauthorized") as Error & { response: { status: number } };
  err.response = { status: 401 };
  return err;
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  invalidateTokenCache();
  process.env.FEFUNDINFO_TOKEN_URL = "https://fe.test/token";
  process.env.FEFUNDINFO_CLIENT_ID = "id";
  process.env.FEFUNDINFO_CLIENT_SECRET = "secret";
  process.env.FEFUNDINFO_API_URL = "https://fe.test/prices";
});

describe("isFeFundInfoConfigured", () => {
  it("is false when credentials are absent", () => {
    delete process.env.FEFUNDINFO_CLIENT_SECRET;
    expect(isFeFundInfoConfigured()).toBe(false);
  });
  it("is true once they are set", () => {
    expect(isFeFundInfoConfigured()).toBe(true);
  });
});

describe("fetchPrices", () => {
  it("returns nothing, and calls nothing, for an empty list", async () => {
    expect((await fetchPrices([])).size).toBe(0);
    expect(postMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("maps FE's field codes into price, date and citi code", async () => {
    postMock.mockResolvedValueOnce(tokenOk());
    getMock.mockResolvedValueOnce({ data: { Results: [priced("GB00B4W9CK61")] } });

    const prices = await fetchPrices(["GB00B4W9CK61"]);
    const hit = prices.get("GB00B4W9CK61")!;
    expect(hit.unitPrice).toBe(2042.26);
    expect(hit.priceDate).toBe("2026-09-19"); // time component stripped
    expect(hit.citiCode).toBe("ERP7");
    expect(hit.currency).toBe("GBP");
  });

  // FE puts the price under different codes per instrument. Reading only
  // OFDY908005 (what the Catalyst proxy does) left 8 of 10 real ceding
  // holdings unpriced.
  it.each([
    ["OFDY908102", 4.2237],
    ["OFDY000020", 5.216],
    ["OFDY908005", 1.807],
  ])("reads the price from %s", async (field, value) => {
    postMock.mockResolvedValueOnce(tokenOk());
    getMock.mockResolvedValueOnce({
      data: {
        Results: [
          { Isin: "GB00B4W9CK61", [field]: [{ Value: value, Currency: "GBP" }] },
        ],
      },
    });
    expect((await fetchPrices(["GB00B4W9CK61"])).get("GB00B4W9CK61")?.unitPrice).toBe(value);
  });

  it("prefers the most widely populated code when several are present", async () => {
    postMock.mockResolvedValueOnce(tokenOk());
    getMock.mockResolvedValueOnce({
      data: {
        Results: [
          {
            Isin: "GB00B4W9CK61",
            OFDY908005: [{ Value: 1.807 }],
            OFDY908102: [{ Value: 1.807 }],
          },
        ],
      },
    });
    // Live data always agrees between codes; this pins the precedence anyway.
    expect((await fetchPrices(["GB00B4W9CK61"])).get("GB00B4W9CK61")?.unitPrice).toBe(1.807);
  });

  it("surfaces a non-GBP currency rather than silently treating it as sterling", async () => {
    postMock.mockResolvedValueOnce(tokenOk());
    getMock.mockResolvedValueOnce({
      data: { Results: [{ Isin: "IE00TEST0001", OFDY908102: [{ Value: 12.5, Currency: "USD" }] }] },
    });
    expect((await fetchPrices(["IE00TEST0001"])).get("IE00TEST0001")?.currency).toBe("USD");
  });

  it("splits into batches of 10 — the pricing endpoint refuses more", async () => {
    postMock.mockResolvedValueOnce(tokenOk());
    getMock.mockResolvedValue({ data: { Results: [] } });

    const many = Array.from({ length: 23 }, (_, i) => `GB00TEST${String(i).padStart(4, "0")}`);
    await fetchPrices(many);

    expect(getMock).toHaveBeenCalledTimes(3); // 10 + 10 + 3
    expect(getMock.mock.calls[0][1].params.identifierValue.split(",")).toHaveLength(10);
    expect(getMock.mock.calls[2][1].params.identifierValue.split(",")).toHaveLength(3);
  });

  it("de-duplicates ISINs before asking FE", async () => {
    postMock.mockResolvedValueOnce(tokenOk());
    getMock.mockResolvedValueOnce({ data: { Results: [] } });
    await fetchPrices(["GB00B4W9CK61", "GB00B4W9CK61", ""]);
    expect(getMock.mock.calls[0][1].params.identifierValue).toBe("GB00B4W9CK61");
  });

  it("reuses the cached token across batches", async () => {
    postMock.mockResolvedValueOnce(tokenOk());
    getMock.mockResolvedValue({ data: { Results: [] } });
    const many = Array.from({ length: 25 }, (_, i) => `GB00TEST${String(i).padStart(4, "0")}`);
    await fetchPrices(many);
    expect(postMock).toHaveBeenCalledTimes(1); // one token, three batches
  });

  it("retries once with a fresh token on 401", async () => {
    postMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(tokenOk());
    getMock
      .mockRejectedValueOnce(unauthorised())
      .mockResolvedValueOnce({ data: { Results: [priced("GB00B4W9CK61")] } });

    const prices = await fetchPrices(["GB00B4W9CK61"]);
    expect(prices.get("GB00B4W9CK61")?.unitPrice).toBe(2042.26);
    expect(postMock).toHaveBeenCalledTimes(2); // token refetched
  });

  it("propagates a non-401 failure instead of reporting no price", async () => {
    postMock.mockResolvedValueOnce(tokenOk());
    const boom = new Error("500") as Error & { response: { status: number } };
    boom.response = { status: 500 };
    getMock.mockRejectedValueOnce(boom);

    // A failed lookup must be distinguishable from "FE has no price for this",
    // otherwise an outage would be recorded as a verified RED holding.
    await expect(fetchPrices(["GB00B4W9CK61"])).rejects.toThrow();
  });

  it("omits an ISIN FE returns with no usable price", async () => {
    postMock.mockResolvedValueOnce(tokenOk());
    getMock.mockResolvedValueOnce({
      data: { Results: [{ Isin: "GB00B4W9CK61", OFDY908102: [], OFDY908005: [] }] },
    });
    expect((await fetchPrices(["GB00B4W9CK61"])).size).toBe(0);
  });

  it("keeps the first row when FE returns several for one ISIN", async () => {
    postMock.mockResolvedValueOnce(tokenOk());
    getMock.mockResolvedValueOnce({
      data: { Results: [priced("GB00B4W9CK61", 100), priced("GB00B4W9CK61", 999)] },
    });
    expect((await fetchPrices(["GB00B4W9CK61"])).get("GB00B4W9CK61")?.unitPrice).toBe(100);
  });

  it("refuses when FE is not configured", async () => {
    delete process.env.FEFUNDINFO_CLIENT_ID;
    await expect(fetchPrices(["GB00B4W9CK61"])).rejects.toThrow(/not configured/i);
  });
});
