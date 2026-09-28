// backend/src/utils/userSelects.ts
//
// Safe projections for User relations in Prisma includes.
//
// H27 (open 2026-08-06, closed 2026-09-17 by this file): every case
// response used to include `assignedTo: true` / `createdBy: true` /
// `paraplanner: true`, which returns EVERY column on the User row —
// including `ssoRefreshToken` (live Entra refresh tokens),
// `rcRefreshToken` / `rcAccessToken` (live RingCentral OAuth secrets),
// `ssoId`, and — after 2026-09-17 — `passwordHash` (bcrypt).
//
// Any caller with a valid session (which for six weeks included any
// unauthenticated party via the passwordless /login endpoint, H36) could
// GET /api/cases/:id and harvest refresh tokens for the case's assignee
// and creator — access to Microsoft and RingCentral themselves, not just
// this app. This helper closes the hole by naming the fields we DO want
// on the wire and refusing to leak anything else by omission.
//
// Rule for future User columns: when in doubt, LEAVE OUT. Frontend today
// reads only `id` and `name`; adding a column here should require an
// explicit decision that it belongs in every case-returning response.

import { Prisma } from "@prisma/client";

// The exact fields every case-returning route may safely embed for a User
// relation. Mirrors the JWT-derived `req.user` shape (auth.ts:15-19) so
// the wire contract for "a user reference on a case" is identical to the
// wire contract for "the caller's own user object" — no coincidental
// asymmetry that a future refactor could confuse.
export const SAFE_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  canAccessAiTraining: true,
} as const satisfies Prisma.UserSelect;
