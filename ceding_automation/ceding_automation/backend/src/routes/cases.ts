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
