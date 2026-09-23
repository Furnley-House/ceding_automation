// backend/src/routes/fundLines.ts
// Structured "Fund Details" table per case — one row per fund holding.
// Mirrors the repeating table in the Pension / ISA / GIA tabs of the ceding checklist.

import { Router, Request, Response } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireCaseAccess } from "../middleware/requireCaseAccess";
import {
  verifyCaseFundLines,
  isVerificationConfigured,
} from "../services/fundVerification";

const router = Router();
const prisma = new PrismaClient();

// ── Schemas ──────────────────────────────────────────────
const decimalString = z.union([z.string(), z.number()]).optional().nullable();

const fundLineCreateSchema = z.object({
  fundName: z.string().min(1, "Fund name is required"),
  isinSedolCiti: z.string().optional().nullable(),
  numberOfUnits: decimalString,
  pricePerUnit: decimalString,
  value: decimalString,
  ocf: decimalString,
  transactionCosts: decimalString,
  isWithProfits: z.boolean().optional().default(false),
  sourceDocumentId: z.string().optional().nullable(),
  sourcePageNumber: z.number().int().optional().nullable(),
  sourceQuote: z.string().optional().nullable(),
  displayOrder: z.number().int().optional(),
});

const fundLineUpdateSchema = fundLineCreateSchema.partial();

const fundLineBulkSchema = z.object({
  rows: z.array(fundLineCreateSchema),
  replace: z.boolean().optional().default(false), // if true, delete existing rows first
});

// Convert raw input (string|number|null) -> Prisma.Decimal | null
function toDecimal(v: unknown): Prisma.Decimal | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    return new Prisma.Decimal(v as Prisma.Decimal.Value);
  } catch {
    return null;
  }
}

// ── List fund lines for a case ──────────────────────────
router.get("/:caseId/fund-lines", requireAuth, requireCaseAccess, async (req: Request, res: Response) => {
  const lines = await prisma.checklistFundLine.findMany({
    where: { caseId: req.params.caseId },
    include: {
      sourceDocument: { select: { id: true, originalName: true, filename: true } },
      editedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ isWithProfits: "asc" }, { displayOrder: "asc" }, { createdAt: "asc" }],
  });

  // Compute aggregate totals (Decimal-safe)
  const totalValue = lines.reduce<Prisma.Decimal>(
    (sum, l) => (l.value ? sum.plus(l.value) : sum),
    new Prisma.Decimal(0),
  );

  res.json({
    rows: lines,
    summary: {
      count: lines.length,
      withProfitsCount: lines.filter((l) => l.isWithProfits).length,
      totalValue: totalValue.toString(),
    },
  });
});

// ── Add a single fund line ──────────────────────────────
router.post(
  "/:caseId/fund-lines",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  requireCaseAccess,
  async (req: Request, res: Response) => {
    const parse = fundLineCreateSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Invalid payload", details: parse.error.flatten() });
    }
    const data = parse.data;

    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { id: true, planType: true },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    const created = await prisma.checklistFundLine.create({
      data: {
        caseId: caseRecord.id,
        planType: caseRecord.planType,
        fundName: data.fundName,
        isinSedolCiti: data.isinSedolCiti ?? null,
        numberOfUnits: toDecimal(data.numberOfUnits),
        pricePerUnit: toDecimal(data.pricePerUnit),
        value: toDecimal(data.value),
        ocf: toDecimal(data.ocf),
        transactionCosts: toDecimal(data.transactionCosts),
        isWithProfits: data.isWithProfits ?? false,
        sourceDocumentId: data.sourceDocumentId ?? null,
        sourcePageNumber: data.sourcePageNumber ?? null,
        sourceQuote: data.sourceQuote ?? null,
        displayOrder: data.displayOrder ?? 0,
        editedById: req.user!.id,
        status: "MANUALLY_ENTERED",
        confidence: "HIGH",
      },
    });

    await prisma.auditLog.create({
      data: {
        caseId: caseRecord.id,
        userId: req.user!.id,
        action: "FUND_LINE_ADDED",
        fieldKey: `fund_line:${created.fundName}`,
        newValue: created.value?.toString() ?? null,
        source: "MANUAL",
        metadata: { fundLineId: created.id, isin: created.isinSedolCiti },
      },
    });

    res.status(201).json(created);
  },
);

// ── Bulk replace / append fund lines (useful for AI extraction sync) ─
router.post(
  "/:caseId/fund-lines/bulk",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  requireCaseAccess,
  async (req: Request, res: Response) => {
    const parse = fundLineBulkSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Invalid payload", details: parse.error.flatten() });
    }
    const { rows, replace } = parse.data;

    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { id: true, planType: true },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    const result = await prisma.$transaction(async (tx) => {
      if (replace) {
        await tx.checklistFundLine.deleteMany({ where: { caseId: caseRecord.id } });
      }
      const created = await Promise.all(
        rows.map((data, idx) =>
          tx.checklistFundLine.create({
            data: {
              caseId: caseRecord.id,
              planType: caseRecord.planType,
              fundName: data.fundName,
              isinSedolCiti: data.isinSedolCiti ?? null,
              numberOfUnits: toDecimal(data.numberOfUnits),
              pricePerUnit: toDecimal(data.pricePerUnit),
              value: toDecimal(data.value),
              ocf: toDecimal(data.ocf),
              transactionCosts: toDecimal(data.transactionCosts),
              isWithProfits: data.isWithProfits ?? false,
              sourceDocumentId: data.sourceDocumentId ?? null,
              sourcePageNumber: data.sourcePageNumber ?? null,
              sourceQuote: data.sourceQuote ?? null,
              displayOrder: data.displayOrder ?? idx,
              editedById: req.user!.id,
              status: "MANUALLY_ENTERED",
              confidence: "HIGH",
            },
          }),
        ),
      );
      await tx.auditLog.create({
        data: {
          caseId: caseRecord.id,
          userId: req.user!.id,
          action: "FUND_LINE_ADDED",
          newValue: `${created.length} rows ${replace ? "(replaced)" : "(appended)"}`,
          source: "MANUAL",
          metadata: { count: created.length, replace },
        },
      });
      return created;
    });

    res.status(201).json({ rows: result, count: result.length });
  },
);

// ── Update a fund line ──────────────────────────────────
router.patch(
  "/:caseId/fund-lines/:lineId",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  requireCaseAccess,
  async (req: Request, res: Response) => {
    const parse = fundLineUpdateSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Invalid payload", details: parse.error.flatten() });
    }
    const data = parse.data;

    const existing = await prisma.checklistFundLine.findUnique({
      where: { id: req.params.lineId },
    });
    if (!existing || existing.caseId !== req.params.caseId) {
      return res.status(404).json({ error: "Fund line not found" });
    }

    const updated = await prisma.checklistFundLine.update({
      where: { id: req.params.lineId },
      data: {
        ...(data.fundName !== undefined && { fundName: data.fundName }),
        ...(data.isinSedolCiti !== undefined && { isinSedolCiti: data.isinSedolCiti }),
        // Editing the identifier invalidates everything the fund-master lookup
        // resolved from it, so the row drops back to unverified and stage 6
        // asks for it again. Deliberately NOT triggered by edits to units,
        // price or name: export reads those from the row itself, so they
        // cannot make the match wrong.
        ...(data.isinSedolCiti !== undefined &&
          data.isinSedolCiti !== existing.isinSedolCiti && {
            resolvedIsin: null,
            resolvedFundName: null,
            resolvedUnitPrice: null,
            resolvedPriceDate: null,
            resolvedOcf: null,
            resolvedTxCost: null,
            holdingRag: null,
            fundNameSource: null,
            priceSource: null,
            ocfSource: null,
            txCostSource: null,
            verifiedAt: null,
          }),
        ...(data.numberOfUnits !== undefined && { numberOfUnits: toDecimal(data.numberOfUnits) }),
        ...(data.pricePerUnit !== undefined && { pricePerUnit: toDecimal(data.pricePerUnit) }),
        ...(data.value !== undefined && { value: toDecimal(data.value) }),
        ...(data.ocf !== undefined && { ocf: toDecimal(data.ocf) }),
        ...(data.transactionCosts !== undefined && { transactionCosts: toDecimal(data.transactionCosts) }),
        ...(data.isWithProfits !== undefined && { isWithProfits: data.isWithProfits }),
        ...(data.sourceDocumentId !== undefined && { sourceDocumentId: data.sourceDocumentId }),
        ...(data.sourcePageNumber !== undefined && { sourcePageNumber: data.sourcePageNumber }),
        ...(data.sourceQuote !== undefined && { sourceQuote: data.sourceQuote }),
        ...(data.displayOrder !== undefined && { displayOrder: data.displayOrder }),
        editedById: req.user!.id,
        status: "MANUALLY_OVERRIDDEN",
      },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "FUND_LINE_UPDATED",
        fieldKey: `fund_line:${updated.fundName}`,
        oldValue: existing.value?.toString() ?? null,
        newValue: updated.value?.toString() ?? null,
        source: "MANUAL",
        metadata: { fundLineId: updated.id, isin: updated.isinSedolCiti },
      },
    });

    res.json(updated);
  },
);

// ── Delete a fund line ──────────────────────────────────
router.delete(
  "/:caseId/fund-lines/:lineId",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  requireCaseAccess,
  async (req: Request, res: Response) => {
    const existing = await prisma.checklistFundLine.findUnique({
      where: { id: req.params.lineId },
    });
    if (!existing || existing.caseId !== req.params.caseId) {
      return res.status(404).json({ error: "Fund line not found" });
    }

    await prisma.checklistFundLine.delete({ where: { id: req.params.lineId } });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "FUND_LINE_REMOVED",
        fieldKey: `fund_line:${existing.fundName}`,
        oldValue: existing.value?.toString() ?? null,
        source: "MANUAL",
        metadata: { fundLineId: existing.id, isin: existing.isinSedolCiti },
      },
    });

    res.status(204).send();
  },
);


// ── Verify holdings against the fund master + FE Fund Info ──
// Stage 6. Resolves each holding's identifier, prices it, and records both the
// CA's figures and the reference data, so any disagreement is visible before
// the case is approved. Export reads what this writes and never re-runs the
// lookup — CRM must carry the figures that were signed off.
router.post(
  "/:caseId/fund-lines/verify",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  requireCaseAccess,
  async (req: Request, res: Response) => {
    if (!isVerificationConfigured()) {
      return res
        .status(503)
        .json({ error: "Fund verification is not configured on this environment." });
    }

    try {
      const summary = await verifyCaseFundLines(req.params.caseId, req.user!.id);
      const fundLines = await prisma.checklistFundLine.findMany({
        where: { caseId: req.params.caseId },
        orderBy: { displayOrder: "asc" },
      });
      return res.json({ summary, fundLines });
    } catch (err) {
      // The lookup failing is an upstream problem, not a bad request, and
      // nothing was written — the CA can simply retry. Reported as 502 so the
      // UI can say "could not reach the fund data" rather than implying the
      // holdings were checked and found wanting.
      // eslint-disable-next-line no-console
      console.error("[fund-lines/verify] failed for case %s:", req.params.caseId, err);
      return res.status(502).json({
        error: "Could not reach the fund data service. Nothing was changed — please try again.",
      });
    }
  },
);

// ── Choose which figure to carry forward ────────────────
// Where the CA's entry and the reference data disagree, the CA decides per
// field. Verification writes a default; this records an override.
const sourceChoiceSchema = z.object({
  fundNameSource: z.enum(["CEDING", "LOOKUP"]).optional(),
  priceSource: z.enum(["CEDING", "LOOKUP"]).optional(),
  ocfSource: z.enum(["CEDING", "LOOKUP"]).optional(),
  txCostSource: z.enum(["CEDING", "LOOKUP"]).optional(),
});

router.patch(
  "/:caseId/fund-lines/:lineId/source",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  requireCaseAccess,
  async (req: Request, res: Response) => {
    const parse = sourceChoiceSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Invalid payload", details: parse.error.flatten() });
    }
    const data = parse.data;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No choice supplied" });
    }

    const existing = await prisma.checklistFundLine.findUnique({
      where: { id: req.params.lineId },
    });
    if (!existing || existing.caseId !== req.params.caseId) {
      return res.status(404).json({ error: "Fund line not found" });
    }
    if (!existing.verifiedAt) {
      // Choosing between two figures when only one exists is meaningless, and
      // the choice would be overwritten by the next verification run anyway.
      return res.status(409).json({ error: "This holding has not been verified yet." });
    }

    const updated = await prisma.checklistFundLine.update({
      where: { id: req.params.lineId },
      data: { ...data, editedById: req.user!.id },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "FUND_LINE_UPDATED",
        fieldKey: "fund_line:" + updated.fundName,
        source: "MANUAL",
        newValue: Object.entries(data)
          .map(([k, v]) => k + "=" + v)
          .join(", "),
        metadata: {
          reason: "verification-source-choice",
          fundLineId: updated.id,
          isin: updated.resolvedIsin ?? updated.isinSedolCiti,
        },
      },
    });

    res.json(updated);
  },
);

export { router as fundLineRoutes };
