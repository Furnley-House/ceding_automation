// backend/src/routes/checklist.ts
import { Router, Request, Response } from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireInternalKey } from "../middleware/internalKey";
import { applyFieldExtraction } from "../services/aiBffApply";
import { mirrorChecklistToCase } from "../services/caseFieldMirror";

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

  // Flatten template display fields onto each field so the frontend can use
  // field.fieldKey / field.label / field.section directly (after snake_keys).
  const normalised = fields.map((f) => ({
    ...f,
    fieldKey: f.template.fieldKey,
    label: f.template.fieldName,
    section: f.template.sectionName,
    fieldType: f.template.fieldType,
    isRequired: f.template.isRequired,
    conditionalNote: f.template.conditionalNote,
    dropdownOptions: f.template.dropdownOptions,
  }));

  const normalisedGrouped = normalised.reduce((acc: Record<string, unknown[]>, field) => {
    const section = field.section;
    if (!acc[section]) acc[section] = [];
    acc[section].push(field);
    return acc;
  }, {});

  res.json({ grouped: normalisedGrouped, summary, fields: normalised });
});

// ── Seed a single missing checklist field ─────────────────
// Called by the frontend when it detects a template field that has no DB row yet
router.post(
  "/:caseId/checklist/seed",
  requireAuth,
  async (req: Request, res: Response) => {
    const { fieldKey, label, section, value } = req.body;
    if (!fieldKey) return res.status(400).json({ error: "fieldKey is required" });

    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    // Find or create the template for this plan type + fieldKey
    let template = await prisma.checklistTemplate.findUnique({
      where: { planType_fieldKey: { planType: caseRecord.planType, fieldKey } },
    });

    if (!template) {
      const maxOrder = await prisma.checklistTemplate.findFirst({
        where: { planType: caseRecord.planType },
        orderBy: { displayOrder: "desc" },
        select: { displayOrder: true },
      });
      template = await prisma.checklistTemplate.create({
        data: {
          planType: caseRecord.planType,
          sectionName: section || "General",
          fieldName: label || fieldKey,
          fieldKey,
          fieldType: "text",
          isRequired: false,
          displayOrder: (maxOrder?.displayOrder ?? 0) + 1,
        },
      });
    }

    // Upsert: create the field row if it doesn't exist; skip if it does
    const field = await prisma.checklistField.upsert({
      where: { caseId_templateId: { caseId: req.params.caseId, templateId: template.id } },
      create: {
        caseId: req.params.caseId,
        templateId: template.id,
        value: value ?? null,
        confidence: "MISSING",
        status: "AI_EXTRACTED",
      },
      update: {}, // leave existing data untouched
    });

    // If the seed carried a value, mirror it to the Case row.
    if (value) {
      await mirrorChecklistToCase(req.params.caseId, template.fieldKey, value);
    }

    // Return the field with template fields flattened so the frontend can use
    // field.fieldKey / field.label / field.section directly (after snake_keys).
    res.status(201).json({
      ...field,
      fieldKey: template.fieldKey,
      label: template.fieldName,
      section: template.sectionName,
      fieldType: template.fieldType,
    });
  }
);

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

    // Conflict cleanup hygiene: a manual edit that sets a value on a
    // conflicted field implicitly resolves the conflict — the operator has
    // chosen one of the candidates (or typed a third value). Clear BOTH
    // the hasConflict flag AND the stale conflictValues JSON so the row
    // doesn't leave stale state behind. Previously this path only cleared
    // hasConflict when `resolvedConflict: true` was explicitly passed, and
    // conflictValues was never cleared by PATCH at all (only by the
    // dedicated POST /resolve-conflict endpoint).
    const isResolvingConflict =
      field.hasConflict && (value !== undefined || resolvedConflict === true);

    const updated = await prisma.checklistField.update({
      where: { id: req.params.fieldId },
      data: {
        value,
        isManuallyOverridden: true,
        status: "MANUALLY_OVERRIDDEN",
        manualEditedById: req.user!.id,
        manualEditedAt: new Date(),
        hasConflict: isResolvingConflict ? false : field.hasConflict,
        // Only include the key when we mean to clear it. Spreading an
        // empty object on the non-resolving branch lets Prisma leave the
        // existing JSON untouched. Prisma.JsonNull writes SQL JSON null
        // — actually clears the column rather than skipping the update.
        ...(isResolvingConflict ? { conflictValues: Prisma.JsonNull } : {}),
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

    // Propagate provider_name / plan_number / start_date to the Case row
    // so the header and dashboard reflect the latest value immediately.
    await mirrorChecklistToCase(req.params.caseId, field.template.fieldKey, value);

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

// ── Bulk-fill missing fields with dummy test data ─────────
// Testing-only helper. Walks every active template for the case's plan
// type, and for any field with no value (whether the DB row exists or
// not) writes a type-aware placeholder so the end-to-end approval flow
// can be tested without scrubbing 33+ real fields.
router.post(
  "/:caseId/checklist/fill-test-data",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { id: true, planType: true },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    const templates = await prisma.checklistTemplate.findMany({
      where: { planType: caseRecord.planType, isActive: true },
    });
    const existing = await prisma.checklistField.findMany({
      where: { caseId: caseRecord.id },
      select: { id: true, templateId: true, value: true },
    });
    const existingByTemplateId = new Map(existing.map((f) => [f.templateId, f]));

    const dummyFor = (t: { fieldType: string; fieldName: string; dropdownOptions: string[] }) => {
      switch ((t.fieldType || "").toLowerCase()) {
        case "number":
          return "42";
        case "currency":
          return "£100.00";
        case "percent":
        case "percentage":
          return "0.75%";
        case "yesno":
        case "yes_no":
          return "Yes";
        case "date":
          return "01/01/2025";
        case "select":
        case "dropdown":
          return t.dropdownOptions?.[0] ?? "Option 1";
        case "url":
          return "https://example.com";
        default:
          return `Test ${t.fieldName}`;
      }
    };

    let filled = 0;
    for (const tpl of templates) {
      const value = dummyFor(tpl);
      const found = existingByTemplateId.get(tpl.id);
      if (found && found.value) continue; // already has a real value — skip
      if (found) {
        await prisma.checklistField.update({
          where: { id: found.id },
          data: {
            value,
            confidence: "HIGH",
            status: "MANUALLY_OVERRIDDEN",
            isManuallyOverridden: true,
            manualEditedById: req.user!.id,
            manualEditedAt: new Date(),
          },
        });
      } else {
        await prisma.checklistField.create({
          data: {
            caseId: caseRecord.id,
            templateId: tpl.id,
            value,
            confidence: "HIGH",
            status: "MANUALLY_OVERRIDDEN",
            isManuallyOverridden: true,
            manualEditedById: req.user!.id,
            manualEditedAt: new Date(),
          },
        });
      }
      // Mirror to Case columns (provider / policy ref / start date).
      await mirrorChecklistToCase(caseRecord.id, tpl.fieldKey, value);
      filled++;
    }

    await prisma.auditLog.create({
      data: {
        caseId: caseRecord.id,
        userId: req.user!.id,
        action: "CASE_UPDATED",
        source: "MANUAL",
        newValue: `Filled ${filled} field${filled === 1 ? "" : "s"} with test data`,
      },
    });

    res.json({ message: `Filled ${filled} field${filled === 1 ? "" : "s"} with test data`, filled });
  },
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
        // Provider phone/dept now live inside scriptContent (the JSON above)
        // instead of as separate columns — read live from case.provider in
        // the UI if you need the current value, else from the snapshot.
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

// ── BFF write-back: single field ──────────────────────────
// Called by the BFF (NOT by the frontend). Uses X-Internal-Key auth.
// Contract: docs/ai-integration-design.md §4(a). The actual apply logic
// lives in services/aiBffApply.ts so the poller uses the same path.
const aiFieldWriteBackSchema = z.object({
  job_id: z.string().regex(/^bff-[0-9a-f]{8,16}$/),
  field_key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.null()]),
  raw_value: z.string().nullable().optional(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW", "MISSING"]),
  source_page: z.number().int().positive().nullable().optional(),
  source_quote: z.string().max(2000).nullable().optional(),
  reasoning: z.string().max(2000).nullable().optional(),
  document_id: z.string().min(1),
});

router.patch(
  "/:caseId/checklist/:fieldId/ai-extract",
  requireInternalKey,
  async (req: Request, res: Response) => {
    const parse = aiFieldWriteBackSchema.safeParse(req.body);
    if (!parse.success) {
      return res
        .status(400)
        .json({ error: "Invalid payload", details: parse.error.flatten() });
    }
    const body = parse.data;

    // NOTE (per docs/monday-execution-plan.md D3):
    // For /ai-extract only, :fieldId is the template.fieldKey
    // (e.g. "plan_number"), NOT ChecklistField.id UUID. Stage 4
    // of the BFF pipeline outputs each field keyed by field_key,
    // so the BFF passes that as the URL param. Other routes in
    // this file still use UUID-based lookup.
    const field = await prisma.checklistField.findFirst({
      where: {
        caseId: req.params.caseId,
        template: { fieldKey: req.params.fieldId },
      },
      include: {
        template: true,
        // Pull the case's canonical provider so we can plumb it into
        // compareFieldValues via applyFieldExtraction. Only used for
        // provider_name alias collapsing. No extra round-trip vs the
        // existing query — same join.
        case: { select: { provider: { select: { name: true } } } },
      },
    });
    if (!field) {
      return res
        .status(404)
        .json({ error: "Field not found for this case" });
    }

    // Defense-in-depth: BFF must send the same field_key in URL and body.
    // Catches BFF bugs where URL routing and payload construction diverge.
    if (body.field_key !== req.params.fieldId) {
      return res.status(400).json({
        error: "field_key mismatch between URL and body",
        urlFieldKey: req.params.fieldId,
        bodyFieldKey: body.field_key,
      });
    }

    // Guard the BFF write-back call. Without this try/catch, any Prisma
    // error (P2003 FK violation when the source doc was deleted mid-flight,
    // P2025 record-not-found, transient connection drops) bubbles up as an
    // unhandled promise rejection and crashes the Node process. The BFF
    // typically multi-PATCHes 65 fields per doc, so one bad field would
    // restart the whole backend mid-batch — observed as a 13-restart loop
    // on 2026-06-10. Catch here, return 500 for THIS request, keep the
    // process alive for everyone else.
    let result;
    try {
      result = await applyFieldExtraction({
        caseId: req.params.caseId,
        fieldKey: field.template.fieldKey,
        data: {
          fieldKey: body.field_key,
          value: body.value,
          rawValue: body.raw_value ?? null,
          confidence: body.confidence,
          sourcePage: body.source_page ?? null,
          sourceQuote: body.source_quote ?? null,
          reasoning: body.reasoning ?? null,
        },
        jobId: body.job_id,
        documentId: body.document_id,
        // PATCH body doesn't carry detected_provider; fall back to the case's
        // registry-known provider name (canonical by construction since the
        // Provider table is the source of truth).
        providerCanonical: field.case?.provider?.name ?? undefined,
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      console.error(
        "[ai-extract] applyFieldExtraction failed for case=%s field=%s job=%s doc=%s code=%s:",
        req.params.caseId,
        req.params.fieldId,
        body.job_id,
        body.document_id,
        code ?? "unknown",
        err,
      );
      return res.status(500).json({
        error: "Field extraction write failed",
        code: code ?? "unknown",
      });
    }

    if (result.outcome === "preserved") {
      return res.json({ ok: true, fieldId: field.id, skipped: "preserved" });
    }
    if (result.outcome === "no-overwrite-missing") {
      return res.json({
        ok: true,
        fieldId: field.id,
        skipped: "no-overwrite-with-missing",
      });
    }
    if (result.outcome === "skipped-manual-only") {
      // Template is manual-entry-only — AI never writes it. No-op success so
      // the BFF can tally it without treating it as an error.
      return res.json({ ok: true, fieldId: field.id, skipped: "manual-entry-only" });
    }
    if (result.outcome === "field-not-found") {
      return res.status(404).json({ error: "Field not found" });
    }

    // applied or conflict — re-read for the response so the BFF sees the
    // post-state (helpful for its own telemetry).
    const updated = await prisma.checklistField.findUnique({
      where: { id: field.id },
      select: { id: true, confidence: true, hasConflict: true },
    });
    return res.json({
      ok: true,
      fieldId: updated?.id,
      confidence: updated?.confidence,
      hasConflict: updated?.hasConflict ?? false,
      outcome: result.outcome,
    });
  }
);

export { router as checklistRoutes };
