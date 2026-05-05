// backend/src/routes/checklist.ts
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

// ── Get all checklist fields for a case ─────────────────
router.get("/:caseId/checklist", requireAuth, async (req: Request, res: Response) => {
  const fields = await prisma.checklistField.findMany({
    where: { caseId: req.params.caseId },
    include: {
      template: true,
      sourceDocument: { select: { originalName: true, filename: true } },
      manualEditedBy: { select: { name: true } },
    },
    orderBy: { template: { displayOrder: "asc" } },
  });

  // Group by section
  const grouped = fields.reduce((acc: Record<string, unknown[]>, field) => {
    const section = field.template.sectionName;
    if (!acc[section]) acc[section] = [];
    acc[section].push(field);
    return acc;
  }, {});

  // Summary counts
  const summary = {
    total: fields.length,
    high: fields.filter((f) => f.confidence === "HIGH").length,
    medium: fields.filter((f) => f.confidence === "MEDIUM").length,
    low: fields.filter((f) => f.confidence === "LOW").length,
    missing: fields.filter((f) => f.confidence === "MISSING").length,
    conflicts: fields.filter((f) => f.confidence === "CONFLICT").length,
    approved: fields.filter((f) => f.isApproved).length,
  };

  res.json({ grouped, summary, fields });
});

// ── Edit a checklist field (CA Team) ─────────────────────
router.patch(
  "/:caseId/checklist/:fieldId",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  async (req: Request, res: Response) => {
    const { value, resolvedConflict } = req.body;

    const field = await prisma.checklistField.findUnique({
      where: { id: req.params.fieldId },
      include: { template: true },
    });
    if (!field) return res.status(404).json({ error: "Field not found" });

    const oldValue = field.value;

    const updated = await prisma.checklistField.update({
      where: { id: req.params.fieldId },
      data: {
        value,
        isManuallyOverridden: true,
        status: "MANUALLY_OVERRIDDEN",
        manualEditedById: req.user!.id,
        manualEditedAt: new Date(),
        hasConflict: resolvedConflict ? false : field.hasConflict,
        // Promote confidence to HIGH on manual edit
        confidence: value ? "HIGH" : "MISSING",
      },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "FIELD_EDITED",
        fieldId: req.params.fieldId,
        fieldKey: field.template.fieldKey,
        oldValue,
        newValue: value,
        source: "MANUAL",
      },
    });

    res.json(updated);
  }
);

// ── Resolve conflict ──────────────────────────────────────
router.post(
  "/:caseId/checklist/:fieldId/resolve-conflict",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const { chosenValue } = req.body;

    const field = await prisma.checklistField.findUnique({
      where: { id: req.params.fieldId },
      include: { template: true },
    });
    if (!field) return res.status(404).json({ error: "Field not found" });

    const updated = await prisma.checklistField.update({
      where: { id: req.params.fieldId },
      data: {
        value: chosenValue,
        confidence: "HIGH",
        hasConflict: false,
        conflictValues: undefined,
        status: "MANUALLY_OVERRIDDEN",
        manualEditedById: req.user!.id,
        manualEditedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "CONFLICT_RESOLVED",
        fieldId: req.params.fieldId,
        fieldKey: field.template.fieldKey,
        newValue: chosenValue,
        source: "MANUAL",
      },
    });

    res.json(updated);
  }
);

// ── Adviser: Approve field ────────────────────────────────
router.post(
  "/:caseId/checklist/:fieldId/approve",
  requireAuth,
  requireRole(["ADVISER", "PARAPLANNER", "ADMIN"]),
  async (req: Request, res: Response) => {
    const field = await prisma.checklistField.findUnique({
      where: { id: req.params.fieldId },
      include: { template: true },
    });
    if (!field) return res.status(404).json({ error: "Field not found" });

    const updated = await prisma.checklistField.update({
      where: { id: req.params.fieldId },
      data: {
        isApproved: true,
        approvedAt: new Date(),
        reviewComment: null,
        reviewRequestedAt: null,
        status: "APPROVED",
      },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "FIELD_APPROVED",
        fieldId: req.params.fieldId,
        fieldKey: field.template.fieldKey,
        source: "MANUAL",
      },
    });

    res.json(updated);
  }
);

// ── Adviser: Request review on field ─────────────────────
router.post(
  "/:caseId/checklist/:fieldId/request-review",
  requireAuth,
  requireRole(["ADVISER", "PARAPLANNER", "ADMIN"]),
  async (req: Request, res: Response) => {
    const { comment } = req.body;

    const field = await prisma.checklistField.findUnique({
      where: { id: req.params.fieldId },
      include: { template: true },
    });
    if (!field) return res.status(404).json({ error: "Field not found" });

    await prisma.checklistField.update({
      where: { id: req.params.fieldId },
      data: {
        isApproved: false,
        reviewComment: comment,
        reviewRequestedAt: new Date(),
        status: "REVIEW_REQUESTED",
      },
    });

    // Revert case to IN_REVIEW
    const caseRecord = await prisma.case.update({
      where: { id: req.params.caseId },
      data: { status: "IN_REVIEW" },
    });

    // Notify CA Team assignee
    if (caseRecord.assignedToId) {
      await prisma.notification.create({
        data: {
          userId: caseRecord.assignedToId,
          caseId: req.params.caseId,
          title: "Field review requested",
          message: `${field.template.fieldName}: ${comment}`,
          deepLink: `/cases/${req.params.caseId}`,
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "FIELD_REVIEW_REQUESTED",
        fieldId: req.params.fieldId,
        fieldKey: field.template.fieldKey,
        newValue: comment,
        source: "MANUAL",
      },
    });

    res.json({ message: "Review requested" });
  }
);

// ── Bulk approve all fields ───────────────────────────────
router.post(
  "/:caseId/checklist/approve-all",
  requireAuth,
  requireRole(["ADVISER", "PARAPLANNER", "ADMIN"]),
  async (req: Request, res: Response) => {
    await prisma.checklistField.updateMany({
      where: { caseId: req.params.caseId, isApproved: false },
      data: { isApproved: true, approvedAt: new Date(), status: "APPROVED" },
    });

    await prisma.case.update({
      where: { id: req.params.caseId },
      data: { status: "APPROVED", approvedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "CASE_APPROVED",
        source: "MANUAL",
        newValue: "All fields approved",
      },
    });

    res.json({ message: "All fields approved" });
  }
);

// ── Generate Call Script ──────────────────────────────────
router.post(
  "/:caseId/call-script",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      include: {
        provider: true,
        checklistFields: {
          where: { confidence: { in: ["MISSING", "LOW"] } },
          include: { template: true },
        },
      },
    });

    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    const missingFields = caseRecord.checklistFields;
    const questions = missingFields.map((f) => ({
      fieldId: f.id,
      fieldKey: f.template.fieldKey,
      fieldName: f.template.fieldName,
      question: generateQuestion(f.template.fieldName, f.template.fieldType),
      confidence: f.confidence,
    }));

    const script = {
      greeting: `Good [morning/afternoon], my name is [Your Name] from Furnley House Financial Planning Partners. I'm calling regarding a transfer request for one of our clients. Could I speak with someone in your ceding or transfers department please?`,
      providerName: caseRecord.provider?.name || "the provider",
      providerPhone: caseRecord.provider?.phoneCedingDept || caseRecord.provider?.phoneMain,
      questions,
      closing: `Thank you for your help. Could I confirm the best email address to send any follow-up correspondence? And could I take your name and direct line for our records?`,
      generatedAt: new Date().toISOString(),
    };

    const saved = await prisma.callScript.create({
      data: {
        caseId: req.params.caseId,
        scriptContent: script,
        missingFieldIds: missingFields.map((f) => f.id),
        providerPhone: caseRecord.provider?.phoneCedingDept,
        providerDept: "Ceding / Transfers",
      },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "CALL_SCRIPT_GENERATED",
        newValue: `${questions.length} questions`,
        source: "AI",
      },
    });

    res.json(saved);
  }
);

// ── Analyse Transcript ────────────────────────────────────
router.post(
  "/:caseId/transcript",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const { text, source = "MANUAL_PASTE", ringCentralId } = req.body;

    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      include: {
        checklistFields: {
          where: { confidence: { in: ["MISSING", "LOW"] } },
          include: { template: true },
        },
      },
    });

    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    const transcript = await prisma.transcript.create({
      data: {
        caseId: req.params.caseId,
        source,
        rawText: text,
        ringCentralId,
      },
    });

    // TODO: Send to Azure OpenAI for analysis against missing fields
    // For now, record the transcript and return it
    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "TRANSCRIPT_UPLOADED",
        newValue: `${text.length} characters`,
        source: "MANUAL",
      },
    });

    res.json(transcript);
  }
);

function generateQuestion(fieldName: string, fieldType: string): string {
  const questions: Record<string, string> = {
    current_value: "Could you confirm the current value of the policy, and the date this is valued to?",
    transfer_value: "What is the current transfer value of the policy?",
    exit_charge: "Are there any exit penalties or charges that would apply to a transfer at this time?",
    gar: "Does the policy have a Guaranteed Annuity Rate attached?",
    gmp: "Is there a Guaranteed Minimum Pension on this policy?",
    fund_charges_weighted: "Could you confirm the total annual fund charges, or a weighted average across the funds held?",
  };
  return questions[fieldName.toLowerCase().replace(/ /g, "_")] ||
    `Could you confirm the ${fieldName} for the policy?`;
}

export { router as checklistRoutes };
