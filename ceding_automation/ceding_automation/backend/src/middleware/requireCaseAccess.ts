// backend/src/middleware/requireCaseAccess.ts
//
// Case-scoped authorisation. Attach after requireAuth on every route that
// operates on a single case (identified by :id or :caseId in the URL).
// Mirrors the OR clause the case-list route uses in GET /cases so what a
// user can list is exactly what they can fetch or mutate — never broader.
//
// Roles in OPEN_CASE_ACCESS_ROLES (ADMIN, CA_TEAM, PARAPLANNER) work on
// every case irrespective of ownership: any CA can pick up and progress
// any case, and any paraplanner can review/approve any case. They
// short-circuit without a DB hit, matching the list. Only ADVISER is
// still scoped to cases they are linked to (normally via adviserId, so
// they can approve for an absent paraplanner on their own clients).
//
// Closes a pre-existing exposure where any authenticated user could
// fetch any case by id — GET /cases/:id used findUnique with no user
// filter, and every sub-route (checklist, documents, fundLines,
// contributions, export) took :caseId with no filter at all. The gap
// went live with feat/adviser-scope-and-approval which granted advisers
// their own case list to enumerate ids from.
//
// Deliberately NOT mounted on routes guarded by requireInternalKey
// (checklist.ts:635, documents.ts:985 — the BFF write-back paths).
// Those have no human user; requireInternalKey sets req.user to
// SYSTEM_USER_ID with role=ADMIN, so a stray mount would still pass,
// but by convention internal-key routes carry only requireInternalKey.
// Enforce at review: no route should mount both.

import { Request, Response, NextFunction } from "express";
import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

// Roles that see and operate on every case. Shared with GET /cases so the
// list and the per-case guard can never drift apart.
export const OPEN_CASE_ACCESS_ROLES: readonly UserRole[] = [
  "ADMIN",
  "CA_TEAM",
  "PARAPLANNER",
];

export function hasOpenCaseAccess(role: UserRole): boolean {
  return OPEN_CASE_ACCESS_ROLES.includes(role);
}

export async function requireCaseAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    // requireAuth must run before this. Guard anyway so a mis-ordered
    // mount 401s rather than crashing on undefined below.
    return res.status(401).json({ error: "No token provided" });
  }

  // ADMIN / CA_TEAM / PARAPLANNER see all cases — mirrors the list
  // short-circuit in GET /cases. No DB hit; a non-existent id falls
  // through to the handler's own 404.
  if (hasOpenCaseAccess(req.user.role)) return next();

  // Case identifier arrives as either :id (cases.ts route) or :caseId
  // (checklist/documents/fundLines/contributions/export routes).
  const caseId = (req.params.id ?? req.params.caseId) as string | undefined;
  if (!caseId) {
    // Middleware mounted on a path with no case identifier — programmer
    // error. Fail closed rather than silently pass.
    return res
      .status(500)
      .json({ error: "requireCaseAccess: no caseId in route params" });
  }

  const row = await prisma.case.findFirst({
    where: {
      id: caseId,
      OR: [
        { createdById: req.user.id },
        { assignedToId: req.user.id },
        { paralPlannerId: req.user.id },
        { adviserId: req.user.id },
      ],
    },
    select: { id: true },
  });

  if (!row) {
    // Same 403 body shape as requireRole at auth.ts:71,:83 — the
    // frontend's existing 403 toast handles it unchanged.
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  next();
}
