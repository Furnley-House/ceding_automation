// backend/src/routes/contributions.ts
// Structured contributions table per case — 4 rows, one per tax year.
// Only meaningful on Pension cases (the checklist Excel template has rows
// for it on the Pension sheet only), but the endpoint doesn't enforce
// planType — the frontend gates rendering by plan type instead, so an
// early stage before plan_type is known can still fetch an empty set.

import { Router, Request, Response } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireCaseAccess } from "../middleware/requireCaseAccess";
import {
  createManualContributionTransaction,
  ContributionNotFoundError,
} from "../services/contributionsService";

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
  requireCaseAccess,
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
    // Seed if needed, then re-read with children included.
    await ensureRows(req.params.caseId);
    // H33-followup PR2: return each parent row with its non-superseded
    // transaction children (grouped by type client-side; the client
    // sums for the displayed total and derives the conflict marker
    // against the parent's *AiTotal columns). Superseded rows are
    // deliberately excluded — drill-down history is a PR3 concern and
    // will extend this include with a query param when it lands.
    const rows = await prisma.checklistContribution.findMany({
      where: { caseId: req.params.caseId },
      orderBy: { position: "asc" },
      include: {
        transactions: {
          where: { supersededAt: null },
          orderBy: [{ date: "asc" }, { createdAt: "asc" }],
        },
      },
    });
    res.json({ rows });
  },
);

// ── Manual contribution entry — one MANUAL child, atomic supersede ──────
// H33-followup PR2. Called by the redesigned two-grid Stage-4 UI when a
// CA types a number into a cell (PR3). Creates ONE child, source=MANUAL,
// null date/documentId, description='Manual entry'. Atomically supersedes
// any non-superseded prior rows in the same (contributionId, type) —
// both AI and MANUAL (see service docstring for the supersede-ALL
// rationale). The parent's employerAiTotal / personalAiTotal is
// PRESERVED. Audit action CONTRIBUTION_TRANSACTION_ADDED captures the
// new value AND full details of anything superseded.
const manualEntrySchema = z.object({
  type: z.enum(["EMPLOYER", "PERSONAL"]),
  // Accept either "5000.00", 5000, or 5000.00 — matches how the
  // existing PATCH amount body is shaped so the client can send one
  // consistent currency-input format across old and new grids.
  amount: z.union([z.string(), z.number()]),
});

router.post(
  "/:caseId/contributions/:id/transactions",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  requireCaseAccess,
  async (req: Request, res: Response) => {
    const parsed = manualEntrySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(parsed.data.amount);
    } catch {
      res.status(400).json({ error: "Amount is not a valid decimal" });
      return;
    }
    try {
      const result = await createManualContributionTransaction(prisma, {
        caseId: req.params.caseId,
        contributionId: req.params.id,
        type: parsed.data.type,
        amount,
        userId: req.user!.id,
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof ContributionNotFoundError) {
        res.status(404).json({ error: "Contribution row not found" });
        return;
      }
      throw err;
    }
  },
);

// ── Update one contribution row (label and/or amount) ──────────────────
// H33-followup PR2 note: the `amount` field on the parent
// (checklist_contributions.amount TEXT, legacy single-total column) is
// kept-and-deprecated per the design session. This PATCH remains the
// path for the OLD single-grid UI to write the legacy amount, so
// deploying PR2 without PR3 does not break Carmel's current type-a-
// number workflow. The new POST /transactions above is the path the
// PR3 two-grid UI will use; retirement of this amount write happens
// only after PR3 ships and the pipeline emits per-row data.
router.patch(
  "/:caseId/contributions/:id",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  requireCaseAccess,
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
  requireCaseAccess,
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
