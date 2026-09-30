// Keying function for the app-level express-rate-limit middleware.
//
// The default (req.ip) buckets everyone behind Furnley's office NAT into one
// 200-request budget — one triage session locks the whole team out (item 3
// from the 2026-09-30 E2E findings). Fix: prefer the authenticated user's
// id so each signed-in user gets their own bucket; fall back to IP for
// unauthenticated traffic (login flow, health checks).
//
// Verified — not just decoded — because a keyGenerator that trusts an
// unsigned userId claim lets any client fake a fresh bucket per request and
// defeat rate limiting entirely. jwt.verify is ~1-2 ms and requireAuth
// runs it again anyway; the double-verify is deliberate and cheap.
//
// SEE ALSO: KI-15 (unauthenticated /auth/* still shares the per-IP bucket;
// a stricter second limiter for auth routes is deferred).

import jwt from "jsonwebtoken";

export interface RateLimitKeyInput {
  authHeader: string | undefined;
  ip: string | undefined;
  jwtSecret: string;
}

export function buildRateLimitKey(input: RateLimitKeyInput): string {
  const { authHeader, ip, jwtSecret } = input;

  if (authHeader?.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), jwtSecret) as { userId?: string };
      if (decoded.userId) return `user:${decoded.userId}`;
    } catch {
      // Invalid / expired / tampered — fall through to IP.
    }
  }

  return `ip:${ip ?? "unknown"}`;
}
