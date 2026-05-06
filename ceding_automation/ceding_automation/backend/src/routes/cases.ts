// backend/src/routes/cases.ts
import { Router, Request, Response } from "express";
import { PrismaClient, CaseStatus, PlanType } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";

const router = Router();
const prisma = new PrismaClient();

// ── Create Case ─────────────────────────────────────────
const CreateCaseSchema = z.object({
  clientName: z.string().min(1),
  clientZohoId: z.string().optional(),
  planType: z.nativeEnum(PlanType),
  planSubType: z.string().optional(),
  policyRef: z.string().optional(),
  providerId: z.string().optional(),
  zohoCaseId: z.string().optional(),
});

router.post("/", requireAuth, requireRole(["CA_TEAM", "ADMIN"]), async (req: Request, res: Response) => {
  const parsed = CreateCaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { planType, ...data } = parsed.data;

  // Generate case ref
  const count = await prisma.case.count();
  const caseRef = `FH-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`;

  const newCase = await prisma.case.create({
    data: {
      ...data,
      planType,
      caseRef,
      createdById: req.user!.id,
      assignedToId: req.user!.id,
      status: CaseStatus.STAGE_1_LOA_PREP,
    },
    include: { provider: true, createdBy: true, assignedTo: true },
  });

  // Initialise checklist fields from template
  const templates = await prisma.checklistTemplate.findMany({
    where: { planType, isActive: true },
  });

  if (templates.length > 0) {
    await prisma.checklistField.createMany({
      data: templates.map((t) => ({
        caseId: newCase.id,
        templateId: t.id,
      })),
    });
  }

  // Log audit
  await prisma.auditLog.create({
    data: {
      caseId: newCase.id,
      userId: req.user!.id,
      action: "CASE_CREATED",
      source: "SYSTEM",
      newValue: `Case ${caseRef} created`,
    },
  });

  res.status(201).json(newCase);
});

// ── List Cases ──────────────────────────────────────────
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const { status, planType, search, page = "1", limit = "20" } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (planType) where.planType = planType;
  if (search) {
    where.OR = [
      { clientName: { contains: String(search), mode: "insensitive" } },
      { caseRef: { contains: String(search), mode: "insensitive" } },
      { policyRef: { contains: String(search), mode: "insensitive" } },
    ];
  }

  // CA Team and Advisers only see their own cases (Admin sees all)
  if (req.user!.role !== "ADMIN") {
    where.OR = [
      { createdById: req.user!.id },
      { assignedToId: req.user!.id },
      { paralPlannerId: req.user!.id },
    ];
  }

  const [cases, total] = await Promise.all([
    prisma.case.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { updatedAt: "desc" },
      include: {
        provider: { select: { name: true } },
        assignedTo: { select: { name: true } },
        documents: { select: { id: true } },
        _count: { select: { checklistFields: true } },
      },
    }),
    prisma.case.count({ where }),
  ]);

  res.json({ cases, total, page: Number(page), limit: Number(limit) });
});

// ── Get Single Case ─────────────────────────────────────
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const caseRecord = await prisma.case.findUnique({
    where: { id: req.params.id },
    include: {
      provider: true,
      createdBy: { select: { id: true, name: true, role: true } },
      assignedTo: { select: { id: true, name: true, role: true } },
      paraplanner: { select: { id: true, name: true, role: true } },
      documents: true,
      checklistFields: {
        include: { template: true, sourceDocument: { select: { filename: true } } },
        orderBy: { template: { displayOrder: "asc" } },
      },
      chaseAttempts: { orderBy: { attemptedAt: "desc" } },
      comments: {
        include: { author: { select: { name: true, role: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!caseRecord) return res.status(404).json({ error: "Case not found" });
  res.json(caseRecord);
});

// ── General Case Update (frontend "Mark complete & continue", etc.) ────
// The UI was originally built against a Supabase schema with fields like
// `current_stage`, `stages_completed`, and a string-status enum ("pending_loa",
// "awaiting_documents", …). This endpoint accepts those legacy names and
// translates them to the Prisma Case shape so the existing UI keeps working
// without a frontend rewrite.
const STAGE_TO_STATUS: Record<number, CaseStatus> = {
  1: CaseStatus.STAGE_1_LOA_PREP,
  2: CaseStatus.STAGE_2_COLLECT_DETAILS,
  3: CaseStatus.STAGE_3_CRM_SETUP,
  4: CaseStatus.STAGE_4_PROVIDER_REQUEST,
  5: CaseStatus.STAGE_5_CHASING,
  6: CaseStatus.STAGE_6_DOCUMENT_UPLOAD,
  7: CaseStatus.STAGE_7_MISSING_INFO,
  8: CaseStatus.STAGE_8_VERIFY_CHECKLIST,
  9: CaseStatus.STAGE_9_ADVISER_REVIEW,
  10: CaseStatus.STAGE_10_COMPLETE,
};
const UI_STATUS_TO_PRISMA: Record<string, CaseStatus> = {
  pending_loa: CaseStatus.STAGE_1_LOA_PREP,
  awaiting_documents: CaseStatus.STAGE_4_PROVIDER_REQUEST,
  extraction_complete: CaseStatus.STAGE_8_VERIFY_CHECKLIST,
  in_review: CaseStatus.IN_REVIEW,
  approved: CaseStatus.APPROVED,
  on_hold: CaseStatus.ON_HOLD,
  complete: CaseStatus.STAGE_10_COMPLETE,
};

router.patch(
  "/:id",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  async (req: Request, res: Response) => {
    // Body keys arrive in camelCase (the frontend's camelKeys helper converts before send).
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};

    // current_stage  →  status
    if (typeof body.currentStage === "number") {
      const stage = body.currentStage as number;
      if (STAGE_TO_STATUS[stage]) {
        data.status = STAGE_TO_STATUS[stage];
        if (stage === 9) data.readyForReviewAt = new Date();
        if (stage === 10) data.completedAt = new Date();
      }
    }

    // status: "complete" / "pending_loa" / etc.  →  CaseStatus enum
    if (typeof body.status === "string") {
      const upper = body.status.toUpperCase();
      // If the UI sent the canonical Prisma enum, accept it directly.
      if ((Object.values(CaseStatus) as string[]).includes(upper)) {
        data.status = upper as CaseStatus;
        if (upper === "STAGE_10_COMPLETE" || upper === "APPROVED") {
          data.completedAt = data.completedAt ?? new Date();
        }
      } else if (UI_STATUS_TO_PRISMA[body.status]) {
        data.status = UI_STATUS_TO_PRISMA[body.status];
        if (body.status === "complete") data.completedAt = new Date();
        if (body.status === "approved") data.approvedAt = new Date();
        if (body.status === "in_review") data.readyForReviewAt = new Date();
      }
    }

    // cedingCompleteDate (yyyy-mm-dd or ISO)  →  completedAt
    if (typeof body.cedingCompleteDate === "string" && body.cedingCompleteDate) {
      data.completedAt = new Date(body.cedingCompleteDate);
    }

    // Manual edits to the basic case fields
    if (typeof body.clientName === "string") data.clientName = body.clientName;
    if (typeof body.policyRef === "string") data.policyRef = body.policyRef;
    if (typeof body.planNumber === "string") data.policyRef = body.planNumber;
    if (typeof body.providerId === "string") data.providerId = body.providerId;
    if (typeof body.assignedToId === "string") data.assignedToId = body.assignedToId;
    if (typeof body.paralPlannerId === "string") data.paralPlannerId = body.paralPlannerId;
    if (typeof body.ragStatus === "string") data.ragStatus = body.ragStatus;
    if (typeof body.onHoldReason === "string") data.onHoldReason = body.onHoldReason;
    if (typeof body.zohoTaskId === "string") data.zohoTaskId = body.zohoTaskId;
    if (typeof body.zohoCaseId === "string") data.zohoCaseId = body.zohoCaseId;
    if (typeof body.zohoDeepLink === "string") data.zohoDeepLink = body.zohoDeepLink;

    // Fields the legacy UI sends that have no Prisma column — silently drop:
    //   stagesCompleted, lastActivityAt, zohoCedingStatus, zohoSyncedAt.
    // (updatedAt is maintained automatically by Prisma.)

    if (Object.keys(data).length === 0) {
      // Nothing meaningful — short-circuit with the current record.
      const current = await prisma.case.findUnique({
        where: { id: req.params.id },
        include: { provider: true, assignedTo: true, createdBy: true },
      });
      if (!current) return res.status(404).json({ error: "Case not found" });
      return res.json(current);
    }

    let updated;
    try {
      updated = await prisma.case.update({
        where: { id: req.params.id },
        data,
        include: { provider: true, assignedTo: true, createdBy: true },
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "P2025") return res.status(404).json({ error: "Case not found" });
      return res.status(500).json({ error: e.message ?? "Update failed" });
    }

    // Audit log (only if status changed — avoid spam for trivial edits)
    if (data.status) {
      await prisma.auditLog.create({
        data: {
          caseId: req.params.id,
          userId: req.user!.id,
          action: "CASE_STATUS_CHANGED",
          newValue: String(data.status),
          source: "MANUAL",
          metadata: body as Record<string, unknown>,
        },
      });
    } else {
      await prisma.auditLog.create({
        data: {
          caseId: req.params.id,
          userId: req.user!.id,
          action: "CASE_UPDATED",
          source: "MANUAL",
          metadata: body as Record<string, unknown>,
        },
      });
    }

    res.json(updated);
  },
);

// ── Update Case Stage ────────────────────────────────────
router.patch("/:id/status", requireAuth, requireRole(["CA_TEAM", "ADMIN"]), async (req: Request, res: Response) => {
  const { status, onHoldReason } = req.body;

  const updated = await prisma.case.update({
    where: { id: req.params.id },
    data: {
      status,
      onHoldReason: status === "ON_HOLD" ? onHoldReason : null,
      readyForReviewAt: status === "STAGE_9_ADVISER_REVIEW" ? new Date() : undefined,
      approvedAt: status === "APPROVED" ? new Date() : undefined,
      completedAt: status === "STAGE_10_COMPLETE" ? new Date() : undefined,
    },
  });

  await prisma.auditLog.create({
    data: {
      caseId: req.params.id,
      userId: req.user!.id,
      action: "CASE_STATUS_CHANGED",
      newValue: status,
      source: "MANUAL",
    },
  });

  res.json(updated);
});

// ── Update LOA Status ────────────────────────────────────
router.patch("/:id/loa", requireAuth, requireRole(["CA_TEAM", "ADMIN"]), async (req: Request, res: Response) => {
  const { loaStatus } = req.body;
  const updated = await prisma.case.update({
    where: { id: req.params.id },
    data: {
      loaStatus,
      loaSentAt: loaStatus === "SENT" ? new Date() : undefined,
      loaSignedAt: loaStatus === "SIGNED" ? new Date() : undefined,
    },
  });

  await prisma.auditLog.create({
    data: {
      caseId: req.params.id,
      userId: req.user!.id,
      action: "LOA_STATUS_UPDATED",
      newValue: loaStatus,
      source: "MANUAL",
    },
  });

  res.json(updated);
});

// ── Assign to Paraplanner ────────────────────────────────
router.post("/:id/assign-paraplanner", requireAuth, requireRole(["CA_TEAM", "ADMIN"]), async (req: Request, res: Response) => {
  const { paralPlannerId, note } = req.body;

  const updated = await prisma.case.update({
    where: { id: req.params.id },
    data: {
      paralPlannerId,
      status: CaseStatus.STAGE_9_ADVISER_REVIEW,
      readyForReviewAt: new Date(),
    },
  });

  if (note) {
    await prisma.comment.create({
      data: { caseId: req.params.id, authorId: req.user!.id, content: note },
    });
  }

  await prisma.auditLog.create({
    data: {
      caseId: req.params.id,
      userId: req.user!.id,
      action: "CASE_ASSIGNED",
      newValue: paralPlannerId,
      source: "MANUAL",
    },
  });

  // Notify paraplanner
  await prisma.notification.create({
    data: {
      userId: paralPlannerId,
      caseId: req.params.id,
      title: "Case assigned for review",
      message: `A ceding case has been assigned to you for review.`,
      deepLink: `/cases/${req.params.id}`,
    },
  });

  res.json(updated);
});

// ── Log Chase Attempt ─────────────────────────────────────
router.post("/:id/chase", requireAuth, requireRole(["CA_TEAM", "ADMIN"]), async (req: Request, res: Response) => {
  const { method, notes } = req.body;

  const chase = await prisma.chaseAttempt.create({
    data: {
      caseId: req.params.id,
      method,
      notes,
      attemptedById: req.user!.id,
    },
  });

  await prisma.auditLog.create({
    data: {
      caseId: req.params.id,
      userId: req.user!.id,
      action: "CHASE_LOGGED",
      newValue: `${method}: ${notes || ""}`,
      source: "MANUAL",
    },
  });

  res.json(chase);
});

export { router as caseRoutes };
