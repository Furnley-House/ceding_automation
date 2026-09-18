// Unit tests for password.ts — the pure-function surface. Route-level
// login/lockout/audit behaviour is exercised end-to-end in the auth
// login tests (adjacent file).

import { describe, it, expect } from "vitest";
import {
  generateTemporaryPassword,
  hashPassword,
  isPasswordAcceptable,
  verifyPassword,
} from "./password";

describe("hashPassword + verifyPassword", () => {
  it("round-trips a correct password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword(hash, "correct-horse-battery-staple")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword(hash, "different-password")).toBe(false);
  });

  it("produces a bcrypt-format hash string", async () => {
    // Prefix pins the algorithm — a future silent switch to another lib
    // would produce a different prefix and this assertion catches it.
    const hash = await hashPassword("anything at all");
    expect(hash.startsWith("$2")).toBe(true);
  });

  it("verifyPassword fails closed on a malformed hash", async () => {
    // Any string that isn't a bcrypt hash should be rejected without
    // throwing — a corrupted DB row must not crash the login endpoint.
    expect(await verifyPassword("not-a-bcrypt-hash", "whatever")).toBe(false);
    expect(await verifyPassword("", "whatever")).toBe(false);
  });
});

describe("generateTemporaryPassword", () => {
  it("returns 16 characters from the safe alphabet", () => {
    const pw = generateTemporaryPassword();
    expect(pw).toHaveLength(16);
    // Alphabet excludes 0/O/1/l/I to remove confusion when read aloud.
    expect(pw).not.toMatch(/[0O1lI]/);
    expect(pw).toMatch(/^[A-Za-z2-9]+$/);
  });

  it("returns a different value each call (probabilistic)", () => {
    const set = new Set(Array.from({ length: 100 }, () => generateTemporaryPassword()));
    // 100 draws from a 54^16 space colliding is astronomically unlikely.
    expect(set.size).toBe(100);
  });
});

describe("isPasswordAcceptable", () => {
  it("rejects short passwords", () => {
    expect(isPasswordAcceptable("short").ok).toBe(false);
    // 11 chars — one below the boundary.
    expect(isPasswordAcceptable("elevenChars").ok).toBe(false);
  });

  it("accepts a 12-character password at the boundary", () => {
    expect(isPasswordAcceptable("aBcdefghijkl").ok).toBe(true);
  });

  it("rejects >128 char passwords so bcrypt truncation is not silent", () => {
    // bcrypt truncates at 72 bytes — a paste from a password manager
    // longer than expected should error at the interface not silently
    // succeed with a shorter effective secret.
    expect(isPasswordAcceptable("x".repeat(129)).ok).toBe(false);
  });

  it("rejects non-strings", () => {
    // Zod will typically catch this upstream, but the helper's own
    // contract is a defensive floor.
    // deno-lint-ignore no-explicit-any
    expect(isPasswordAcceptable(null as unknown as string).ok).toBe(false);
    expect(isPasswordAcceptable(undefined as unknown as string).ok).toBe(false);
  });
});
