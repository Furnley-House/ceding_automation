import { describe, it, expect } from "vitest";
import { isRecentSync, SYNC_FROM_ZOHO_WINDOW_MS } from "./syncFreshness";

const NOW = new Date("2026-09-30T12:00:00.000Z");

describe("isRecentSync", () => {
  it("returns false when zohoSyncedAt is null (case has never been synced)", () => {
    expect(isRecentSync(null, NOW)).toBe(false);
  });

  it("returns false when zohoSyncedAt is undefined", () => {
    expect(isRecentSync(undefined, NOW)).toBe(false);
  });

  it("returns true when the last sync was 60 seconds ago (well inside the 5-min window)", () => {
    const syncedAt = new Date(NOW.getTime() - 60_000);
    expect(isRecentSync(syncedAt, NOW)).toBe(true);
  });

  it("returns true when the last sync was just under 5 minutes ago", () => {
    const syncedAt = new Date(NOW.getTime() - (SYNC_FROM_ZOHO_WINDOW_MS - 1));
    expect(isRecentSync(syncedAt, NOW)).toBe(true);
  });

  it("returns false when the last sync was exactly 5 minutes ago (boundary — window is < not <=)", () => {
    const syncedAt = new Date(NOW.getTime() - SYNC_FROM_ZOHO_WINDOW_MS);
    expect(isRecentSync(syncedAt, NOW)).toBe(false);
  });

  it("returns false when the last sync was 6 minutes ago (past the window)", () => {
    const syncedAt = new Date(NOW.getTime() - 6 * 60 * 1000);
    expect(isRecentSync(syncedAt, NOW)).toBe(false);
  });

  it("respects a custom windowMs override (e.g. a shorter window in a specific caller)", () => {
    const syncedAt = new Date(NOW.getTime() - 90_000);
    expect(isRecentSync(syncedAt, NOW, 60_000)).toBe(false);
    expect(isRecentSync(syncedAt, NOW, 120_000)).toBe(true);
  });

  it("treats a future zohoSyncedAt as fresh (clock skew safety — err on the side of skipping)", () => {
    // If some other process (or a clock jump) stamped a timestamp in the
    // future, we'd rather skip the Zoho round-trip than double-fire.
    const syncedAt = new Date(NOW.getTime() + 5_000);
    expect(isRecentSync(syncedAt, NOW)).toBe(true);
  });
});
