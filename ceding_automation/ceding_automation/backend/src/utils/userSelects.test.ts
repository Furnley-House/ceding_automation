// H27 regression tests.
//
// If a future change reintroduces `include: true` on a User relation in a
// case-returning route, the JSON body would leak `ssoRefreshToken`,
// `passwordHash`, `rcRefreshToken`, and other secrets on every response.
// These two tests are the tripwire.
//
// Test 1: SAFE_USER_SELECT itself never claims a sensitive field, no
// matter how the object is edited in the future.
//
// Test 2: an AST-ish grep across the routes tree fails if any active
// route file contains `include:` block referencing a User relation with
// `:true` (as opposed to `{ select: ... }`). Deliberately covers the
// whole routes tree, not just cases.ts / crm.ts, so a new route added
// later doesn't slip through.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { SAFE_USER_SELECT } from "./userSelects";

const SENSITIVE_FIELDS = [
  "ssoRefreshToken",
  "ssoId",
  "passwordHash",
  "mustChangePassword",
  "failedLoginAttempts",
  "lockedUntil",
  "passwordUpdatedAt",
  "rcRefreshToken",
  "rcAccessToken",
  "rcAccessTokenExpiresAt",
] as const;

const USER_RELATION_NAMES = [
  "assignedTo",
  "createdBy",
  "paraplanner",
  "paralPlanner",
  "adviser",
  "user",
  "manualEditedBy",
  "approvedBy",
  "actor",
  "target",
];

describe("SAFE_USER_SELECT", () => {
  it("does not enumerate any sensitive field", () => {
    for (const field of SENSITIVE_FIELDS) {
      expect(SAFE_USER_SELECT).not.toHaveProperty(field);
    }
  });

  it("enumerates only the safe display fields the wire contract permits", () => {
    // Pin the exact allow-list — a future addition to this object must
    // be an explicit, reviewed decision, not an accidental `id: true,
    // name: true, foo: true` where `foo` is a secret. If you're adding
    // a field, update this list AND explain why it belongs on every
    // case-returning response.
    const allowed = new Set([
      "id",
      "name",
      "email",
      "role",
      "status",
      "canAccessAiTraining",
    ]);
    for (const key of Object.keys(SAFE_USER_SELECT)) {
      expect(allowed.has(key), `Unexpected key on SAFE_USER_SELECT: ${key}`).toBe(true);
    }
  });
});

describe("H27 regression — no route uses include:true on a User relation", () => {
  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, acc);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) acc.push(full);
    }
    return acc;
  }

  it("scans src/routes for the bare :true shape and reports any hits", () => {
    const routesDir = join(__dirname, "..", "routes");
    const files = walk(routesDir);
    const violations: string[] = [];
    // Matches any `include: { ... }` block (including nested one-level
    // braces) that contains one of the User relation names followed by
    // `: true`. Any hit is a regression that would leak secrets.
    const includeRe = /include:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gs;
    const relRe = new RegExp(
      `\\b(${USER_RELATION_NAMES.join("|")})\\s*:\\s*true\\b`,
    );
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      let m: RegExpExecArray | null;
      while ((m = includeRe.exec(src)) !== null) {
        const body = m[1];
        const rel = body.match(relRe);
        if (rel) {
          const lineNum = src.slice(0, m.index).split("\n").length;
          violations.push(`${file}:${lineNum} — ${rel[0]}`);
        }
      }
    }
    // Show ALL violations at once so a fix in one place doesn't hide
    // regressions in another.
    expect(violations, `Sites leaking User columns via include:true:\n${violations.join("\n")}`).toHaveLength(0);
  });
});
