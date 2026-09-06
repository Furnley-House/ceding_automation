// backend/src/middleware/requireCaseAccess.ts
//
// Case-scoped authorisation. Attach after requireAuth on every route that
// operates on a single case (identified by :id or :caseId in the URL).
// Mirrors the OR clause the case-list route uses at cases.ts:421-433 so
// what a user can list is exactly what they can fetch or mutate — never
// broader. ADMIN short-circuits without a DB hit, matching the list.
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
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

  // ADMIN sees all cases — mirrors the list short-circuit at cases.ts:420
  // (`if (req.user!.role !== "ADMIN") { where.OR = [...] }`). No DB hit.
  if (req.user.role === "ADMIN") return next();

  // Case identifier arrives as either :id (cases.ts /:id family +
  // export.ts /:id/complete-export) or :caseId (checklist / documents /
  // fundLines / contributions / audit / calls routes).
  //
  // TRAP — do NOT swap this order back. Two contributions routes carry
  // BOTH :caseId AND :id in the path
  // (PATCH /:caseId/contributions/:id and
  //  POST  /:caseId/contributions/:id/transactions), where the :id is a
  // CHILD row id (contribution row), NOT a case id. Reading :id first
  // makes the case lookup below query by contribution id → no match →
  // 403 for legitimate users. This shipped to prod on 2026-09-06 via
  // 3e0c515 and 403'd every non-ADMIN contribution edit until the
  // one-line hotfix that reversed the precedence. Regression covered
  // by requireCaseAccess.test.ts "prefers :caseId when BOTH …" —
  // that test fails immediately if this order is swapped back.
  //
  // Rule: prefer :caseId. Routes with only :id (no :caseId) resolve
  // correctly via the fall-through; routes with only :caseId already
  // preferred it; routes with both now pick the correct one.
  const caseId = (req.params.caseId ?? req.params.id) as string | undefined;
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
