// backend/src/middleware/internalKey.ts
// Guards the BFF write-back endpoints. The BFF holds INTERNAL_BFF_KEY and
// sends it on every PATCH; we timing-safe-compare against our env value.
//
// Contract: docs/ai-integration-design.md §7(b).
// Applied to:
//   - PATCH /api/cases/:caseId/checklist/:fieldId/ai-extract
//   - PATCH /api/documents/:documentId
// Never combined with requireAuth — these routes have no human user.

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { UserRole } from "@prisma/client";

const SYSTEM_USER_ID = "system-ai-bff";

export function requireInternalKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const expected = process.env.INTERNAL_BFF_KEY ?? "";
  const provided = req.headers["x-internal-key"];

  if (!expected || typeof provided !== "string") {
    return res.status(401).json({ error: "Missing internal key" });
  }

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid internal key" });
  }

  // Synthetic user so downstream audit-log writes have a valid userId FK.
  // Seeded by prisma/seed.ts with role=ADMIN so any requireRole check passes.
  req.user = {
    id: SYSTEM_USER_ID,
    email: "ai-system@furnleyhouse.internal",
    name: "AI Extraction (system)",
    role: UserRole.ADMIN,
  };
  next();
}
