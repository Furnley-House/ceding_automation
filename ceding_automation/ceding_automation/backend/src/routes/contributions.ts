// backend/src/routes/contributions.ts
// Structured contributions table per case — 4 rows, one per tax year.
// Only meaningful on Pension cases (the checklist Excel template has rows
// for it on the Pension sheet only), but the endpoint doesn't enforce
// planType — the frontend gates rendering by plan type instead, so an
// early stage before plan_type is known can still fetch an empty set.

import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

const NUM_YEARS = 4;

// ── Tax-year label defaults ─────────────────────────────────────────────
// UK tax year runs 06/04/YYYY – 05/04/(YYYY+1). If today is between 6 Apr
// and 31 Dec, the current tax year starts this calendar year; if between
// 1 Jan and 5 Apr, it started last calendar year. We compute the four
// most recent tax years for seeding — CAs can edit these labels per case
// via PATCH if the source document uses a different convention.
function computeDefaultTaxYearLabels(): string[] {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const day = now.getUTCDate();
  // Current tax year START:
  const currentYearStart = month > 3 || (month === 3 && day >= 6) ? year : year - 1;
  const labels: string[] = [];
  for (let i = 0; i < NUM_YEARS; i++) {
    const startYear = currentYearStart - i;
    // Two-digit end year suffix matches the reference Excel style
    // ("2025/26") — the ISO variant ("06/04/2025 – 05/04/2026") is
    // available on the frontend for CAs who prefer it.
    labels.push(`${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`);
  }
  return labels;
}

// ── Auto-seed 4 rows if the case has none ───────────────────────────────
async function ensureRows(caseId: string) {
  const existing = await prisma.checklistContribution.findMany({
    where: { caseId },
    orderBy: { position: "asc" },
  });
  if (existing.length >= NUM_YEARS) return existing;

  const labels = computeDefaultTaxYearLabels();
  const missingPositions: number[] = [];
  const presentPositions = new Set(existing.map((r) => r.position));
  for (let p = 1; p <= NUM_YEARS; p++) {
    if (!presentPositions.has(p)) missingPositions.push(p);
  }
  await prisma.$transaction(
    missingPositions.map((position) =>
      prisma.checklistContribution.create({
        data: {
          caseId,
          position,
          taxYearLabel: labels[position - 1],
          amount: null,
        },
      }),
    ),
  );
  return prisma.checklistContribution.findMany({
    where: { caseId },
    orderBy: { position: "asc" },
  });
}

const contributionUpdateSchema = z.object({
  taxYearLabel: z.string().trim().min(1).optional(),
  amount: z.string().trim().optional().nullable(),
});

// ── List contributions for a case (auto-seeds on first access) ─────────
router.get(
  "/:caseId/contributions",
  requireAuth,
  async (req: Request, res: Response) => {
    // Guard against seeding rows for a caseId that doesn't exist.
    const caseExists = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { id: true },
    });
    if (!caseExists) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    const rows = await ensureRows(req.params.caseId);
    res.json({ rows });
  },
);

// ── Update one contribution row (label and/or amount) ──────────────────
router.patch(
  "/:caseId/contributions/:id",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  async (req: Request, res: Response) => {
    const parsed = contributionUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }
    // Confirm the row belongs to the requested case — prevents cross-case
    // updates via a leaked id.
    const row = await prisma.checklistContribution.findUnique({
      where: { id: req.params.id },
      select: { id: true, caseId: true },
    });
    if (!row || row.caseId !== req.params.caseId) {
      res.status(404).json({ error: "Contribution row not found" });
      return;
    }
    const updated = await prisma.checklistContribution.update({
      where: { id: req.params.id },
      data: {
        ...(parsed.data.taxYearLabel !== undefined && { taxYearLabel: parsed.data.taxYearLabel }),
        ...(parsed.data.amount !== undefined && { amount: parsed.data.amount ?? null }),
      },
    });
    res.json(updated);
  },
);

// ── Reset all rows to defaults (destructive — CAs use this if the auto-
//    seeded labels drift or they want to redo years cleanly) ──────────
router.post(
  "/:caseId/contributions/reset",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  async (req: Request, res: Response) => {
    const caseExists = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { id: true },
    });
    if (!caseExists) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    await prisma.checklistContribution.deleteMany({ where: { caseId: req.params.caseId } });
    const rows = await ensureRows(req.params.caseId);
    res.json({ rows });
  },
);

export { router as contributionRoutes };
