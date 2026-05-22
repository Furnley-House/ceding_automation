// backend/src/routes/cases.ts
import { Router, Request, Response } from "express";
import { PrismaClient, CaseStatus, PlanType, Prisma } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";
import * as zoho from "../services/zohoCrm";
import { mapZohoTaskToCase } from "../services/zohoCrm";

const router = Router();
const prisma = new PrismaClient();

// ── Create Case ─────────────────────────────────────────
const CreateCaseSchema = z.object({
  clientName: z.string().min(1),
  clientZohoId: z.string().optional(),
  planType: z.nativeEnum(PlanType),
  planSubType: z.string().optional(),
  policyRef: z.string().optional(),
  planNumber: z.string().optional(),    // alias for policyRef
  providerId: z.string().optional(),
  providerName: z.string().optional(),  // resolve to providerId if not given
  zohoTaskId: z.string().optional(),
  caseNotes: z.string().optional(),
  zohoCaseId: z.string().optional(),
});

router.post("/", requireAuth, requireRole(["CA_TEAM", "ADMIN"]), async (req: Request, res: Response) => {
  const parsed = CreateCaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { planType, planSubType, planNumber, providerName, zohoTaskId, caseNotes: _caseNotes, ...data } = parsed.data;

  // planNumber is an alias for policyRef
  if (planNumber && !data.policyRef) data.policyRef = planNumber;

  // Resolve providerName → providerId (auto-create bare record if needed)
  if (!data.providerId && providerName) {
    let provider = await prisma.provider.findFirst({
      where: { name: { equals: providerName, mode: 'insensitive' } },
    });
    if (!provider) {
      provider = await prisma.provider.create({ data: { name: providerName } });
    }
    data.providerId = provider.id;
  }

  // Generate case ref
  const count = await prisma.case.count();
  const caseRef = `FH-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`;

  const newCase = await prisma.case.create({
    data: {
      ...data,
      planType,
      ...(planSubType ? { planSubType: planSubType as import('@prisma/client').PlanSubType } : {}),
      caseRef,
      ...(zohoTaskId ? { zohoTaskId } : {}),
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
          metadata: body as Prisma.InputJsonValue,
        },
      });
    } else {
      await prisma.auditLog.create({
        data: {
          caseId: req.params.id,
          userId: req.user!.id,
          action: "CASE_UPDATED",
          source: "MANUAL",
          metadata: body as Prisma.InputJsonValue,
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
    await prisma.auditLog.create({
      data: {
        caseId: req.params.id,
        userId: req.user!.id,
        action: "COMMENT_ADDED",
        source: "MANUAL",
        newValue: note,
        metadata: { context: "assign-paraplanner", paralPlannerId },
      },
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
  await prisma.auditLog.create({
    data: {
      caseId: req.params.id,
      userId: req.user!.id,
      action: "NOTIFICATION_SENT",
      source: "SYSTEM",
      newValue: "Paraplanner: case assigned for review",
      metadata: { recipientUserId: paralPlannerId, channel: "in-app" },
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

// ── Sync Case from Zoho ──────────────────────────────────
// Re-fetches the linked Zoho task, diffs the basic details against the DB,
// and updates only the fields that have changed in Zoho. Designed to be
// called whenever a case detail page loads, so manual edits made directly in
// Zoho (provider, policy ref, plan type, etc.) propagate into the app.
//
// Response shape:
//   { synced: true, changed: boolean, changes: [{field, from, to}], case }
router.post("/:id/sync-from-zoho", requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id;
  const caseRecord = await prisma.case.findUnique({
    where: { id },
    include: {
      provider: true,
      assignedTo: { select: { id: true, name: true, email: true } },
    },
  });
  if (!caseRecord) return res.status(404).json({ error: "Case not found" });
  if (!caseRecord.zohoTaskId) {
    return res.status(400).json({ error: "Case is not linked to a Zoho task" });
  }

  // 1. Pull the latest task from Zoho
  let taskRecord: Record<string, unknown> | null = null;
  try {
    const raw = (await zoho.getTask(caseRecord.zohoTaskId)) as { data?: unknown[] };
    taskRecord = Array.isArray(raw?.data) ? (raw.data[0] as Record<string, unknown>) : null;
  } catch (err) {
    return res.status(502).json({
      error: `Zoho fetch failed: ${(err as Error).message}`,
      zohoTaskId: caseRecord.zohoTaskId,
    });
  }
  if (!taskRecord) {
    return res.status(404).json({
      error: "Zoho task no longer exists",
      zohoTaskId: caseRecord.zohoTaskId,
    });
  }

  // 2. Map fields
  const mapping = mapZohoTaskToCase(taskRecord);

  // 3a. Resolve provider from name → ID (only if the name has actually changed)
  let resolvedProviderId: string | null = caseRecord.providerId;
  const currentProviderName = caseRecord.provider?.name ?? null;
  if (
    mapping.providerName &&
    mapping.providerName.trim().toLowerCase() !==
      (currentProviderName ?? "").trim().toLowerCase()
  ) {
    const provider = await prisma.provider.findFirst({
      where: { name: { equals: mapping.providerName, mode: "insensitive" } },
    });
    if (provider) {
      resolvedProviderId = provider.id;
    }
    // If no match, leave the existing providerId alone — better than orphaning.
  }

  // 3b. Resolve Zoho Owner → app user.
  //
  // Critical: when Zoho says the Owner has changed but the new person isn't
  // in our DB yet, we MUST NOT fall back to the previous assignee — that
  // would let a no-longer-responsible CA keep access to a case that's now
  // someone else's work. So:
  //
  //   • Email match (active)        → assign to that user
  //   • Email match (inactive)      → unassign (set null)
  //   • No email match BUT Zoho gave us an email
  //                                  → auto-create the user from Zoho data
  //                                    (Zoho is the authoritative HR/CRM
  //                                    record; the new person will inherit
  //                                    this account when they later sign in
  //                                    via SSO, since accounts dedupe by
  //                                    email)
  //   • Name-only match (active)    → assign to that user
  //   • Name-only, no match         → unassign (don't leave stale owner)
  //   • Zoho returned no owner info → leave existing assignment alone
  //                                    (probably a transient API hiccup)
  let resolvedAssignedToId: string | null = caseRecord.assignedToId;
  let resolvedAssignedName: string | null = caseRecord.assignedTo?.name ?? null;
  const currentAssignedName = caseRecord.assignedTo?.name ?? null;

  if (mapping.ownerEmail) {
    const lower = mapping.ownerEmail.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: lower } });

    if (existing && existing.status === "ACTIVE") {
      resolvedAssignedToId = existing.id;
      resolvedAssignedName = existing.name;
    } else if (existing && existing.status === "INACTIVE") {
      // Explicitly disabled — don't reactivate, and don't keep old owner.
      resolvedAssignedToId = null;
      resolvedAssignedName = null;
    } else {
      // Auto-provision from Zoho data so the case can be assigned cleanly.
      const created = await prisma.user.create({
        data: {
          email: lower,
          name: mapping.ownerName?.trim() || lower.split("@")[0],
          role: "CA_TEAM",
          status: "ACTIVE",
        },
      });
      resolvedAssignedToId = created.id;
      resolvedAssignedName = created.name;
    }
  } else if (mapping.ownerName) {
    // No email — try a name match. We deliberately do NOT auto-create from a
    // name alone: without an email there's no way to dedupe the user against
    // a future SSO sign-in.
    const byName = await prisma.user.findFirst({
      where: {
        name: { equals: mapping.ownerName, mode: "insensitive" },
        status: "ACTIVE",
      },
    });
    if (byName) {
      resolvedAssignedToId = byName.id;
      resolvedAssignedName = byName.name;
    } else {
      resolvedAssignedToId = null;
      resolvedAssignedName = null;
    }
  }

  // 4. Diff
  const updates: Record<string, unknown> = {};
  const changes: { field: string; from: unknown; to: unknown }[] = [];

  const considerChange = (
    field: string,
    incoming: unknown,
    current: unknown,
    dbField: string = field,
  ) => {
    // Skip if Zoho returned nothing for this field — never blank-out an
    // existing value just because Zoho omits it on this read.
    if (incoming === undefined || incoming === null || incoming === "") return;
    if (incoming === current) return;
    updates[dbField] = incoming;
    changes.push({ field, from: current, to: incoming });
  };

  considerChange("clientName", mapping.clientName, caseRecord.clientName);
  considerChange("policyRef", mapping.policyRef, caseRecord.policyRef);
  considerChange("planType", mapping.planType, caseRecord.planType);
  considerChange("zohoDeepLink", mapping.zohoDeepLink, caseRecord.zohoDeepLink);
  considerChange("zohoCaseId", mapping.zohoCaseId, caseRecord.zohoCaseId);
  considerChange("clientZohoId", mapping.clientZohoId, caseRecord.clientZohoId);
  if (resolvedProviderId !== caseRecord.providerId) {
    updates.providerId = resolvedProviderId;
    changes.push({
      field: "provider",
      from: currentProviderName,
      to: mapping.providerName ?? null,
    });
  }
  if (resolvedAssignedToId !== caseRecord.assignedToId) {
    updates.assignedToId = resolvedAssignedToId;
    changes.push({
      field: "assignedTo",
      from: currentAssignedName,
      to: resolvedAssignedName,
    });
  }

  if (Object.keys(updates).length === 0) {
    return res.json({
      synced: true,
      changed: false,
      changes: [],
      case: caseRecord,
    });
  }

  // 5. Apply updates
  const updated = await prisma.case.update({
    where: { id },
    data: updates,
    include: { provider: true, assignedTo: true, createdBy: true },
  });

  // 6. Audit (one summary entry per sync — no enum value for "ZOHO sync",
  // so we use CASE_UPDATED + source SYSTEM and stash the diff in metadata).
  await prisma.auditLog.create({
    data: {
      caseId: id,
      userId: req.user!.id,
      action: "CASE_UPDATED",
      source: "SYSTEM",
      newValue: `Synced ${changes.length} field${changes.length === 1 ? "" : "s"} from Zoho`,
      metadata: {
        sync: "zoho",
        zohoTaskId: caseRecord.zohoTaskId,
        changes,
      } as Prisma.InputJsonValue,
    },
  });

  res.json({ synced: true, changed: true, changes, case: updated });
});

export { router as caseRoutes };
