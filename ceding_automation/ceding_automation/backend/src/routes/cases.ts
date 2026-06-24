// backend/src/routes/cases.ts
import { Router, Request, Response } from "express";
import { PrismaClient, CaseStatus, LOAStatus, PlanType, Prisma } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";
import * as zoho from "../services/zohoCrm";
import {
  mapZohoTaskToCase,
  getContactRecord,
  extractContactUserFields,
  findProviderRecordByName,
  findZohoUserById,
  findPlanRecordByPolicyRef,
  findPlanRecordById,
  searchPlansByPolicyRefStartsWith,
  createPlanRecord,
  createPlansXClientsLinks,
  linkTaskToPlan,
  mapPlanTypeToZoho,
} from "../services/zohoCrm";
import { generateNextCaseRef } from "../services/caseRef";

const router = Router();
const prisma = new PrismaClient();

// ── Create Case ─────────────────────────────────────────
const CreateCaseSchema = z.object({
  clientName: z.string().min(1),
  clientZohoId: z.string().nullish(),
  planType: z.nativeEnum(PlanType),
  policyRef: z.string().nullish(),
  planNumber: z.string().nullish(),    // alias for policyRef
  providerId: z.string().nullish(),
  providerName: z.string().nullish(),  // resolve to providerId if not given
  zohoTaskId: z.string().nullish(),
  caseNotes: z.string().nullish(),
  zohoCaseId: z.string().nullish(),
});

router.post("/", requireAuth, requireRole(["CA_TEAM", "ADMIN"]), async (req: Request, res: Response) => {
  const parsed = CreateCaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { planType, planNumber, providerName, zohoTaskId, caseNotes: _caseNotes, ...data } = parsed.data;

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

  // Generate case ref via the shared helper (services/caseRef.ts).
  const caseRef = await generateNextCaseRef(prisma);

  const newCase = await prisma.case.create({
    data: {
      ...data,
      planType,
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
      // Eager-include fund lines so the frontend doesn't fire a separate
      // GET /cases/:id/fund-lines after first paint. Pre-fix, the Fund
      // Details table appeared after a perceptible delay (its own waterfall
      // request) and any logic that needed to count fund-line status had
      // to wait — Stage 4 / 5 / 6 "Missing" chips would briefly disagree.
      fundLines: { orderBy: { displayOrder: "asc" } },
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

// Statuses that mean "the case is sitting with the paraplanner for review".
// Both the PATCH /:id (stepper) and PATCH /:id/status (Send-for-approval
// button) routes need the same behaviour when we enter this state:
//   - ensure a paraplanner is linked (auto-assign first active one if not)
//   - notify them so the case lands in their inbox
function isAwaitingReview(s: CaseStatus | undefined | null): boolean {
  return s === CaseStatus.IN_REVIEW || s === CaseStatus.STAGE_9_ADVISER_REVIEW;
}

// Returns the paraplanner id that should own the review. If the case
// already has one, keep it. Otherwise pick the first active PARAPLANNER
// user (Megan Doherty in the demo seed) and patch the update payload to
// connect them.
async function ensureParaplannerForReview(
  caseId: string,
  data: Prisma.CaseUpdateInput,
): Promise<string | null> {
  const current = await prisma.case.findUnique({
    where: { id: caseId },
    select: { paralPlannerId: true },
  });
  if (current?.paralPlannerId) return current.paralPlannerId;
  const pp = await prisma.user.findFirst({
    where: { role: "PARAPLANNER", status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  if (!pp) return null;
  data.paraplanner = { connect: { id: pp.id } };
  return pp.id;
}

// Skip if the same (user, case, title) was already notified in the recent
// past — both the stepper and the status route can fire side effects in
// quick succession; without this the bell collects ×3 / ×4 dupes per case.
const NOTIFICATION_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 min

async function maybeCreateNotification(args: {
  userId: string;
  caseId: string;
  title: string;
  message: string;
  deepLink: string;
}): Promise<"created" | "deduped"> {
  const cutoff = new Date(Date.now() - NOTIFICATION_DEDUP_WINDOW_MS);
  const existing = await prisma.notification.findFirst({
    where: {
      userId: args.userId,
      caseId: args.caseId,
      title: args.title,
      createdAt: { gte: cutoff },
    },
    select: { id: true },
  });
  if (existing) return "deduped";
  await prisma.notification.create({
    data: {
      userId: args.userId,
      caseId: args.caseId,
      title: args.title,
      message: args.message,
      deepLink: args.deepLink,
    },
  });
  return "created";
}

async function notifyParaplannerReady(
  paraplannerId: string,
  c: { id: string; clientName: string; caseRef: string },
): Promise<void> {
  await maybeCreateNotification({
    userId: paraplannerId,
    caseId: c.id,
    title: "Case ready for review",
    message: `${c.clientName} · ${c.caseRef} is ready for approval.`,
    deepLink: `/cases/${c.id}`,
  });
}

async function notifyCaseApproved(
  caTeamUserId: string,
  c: { id: string; clientName: string; caseRef: string },
): Promise<void> {
  await maybeCreateNotification({
    userId: caTeamUserId,
    caseId: c.id,
    title: "Case approved",
    message: `${c.clientName} · ${c.caseRef} signed off — ready to export.`,
    deepLink: `/cases/${c.id}`,
  });
}

router.patch(
  "/:id",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "ADVISER", "PARAPLANNER"]),
  async (req: Request, res: Response) => {
    // Body keys arrive in camelCase (the frontend's camelKeys helper converts before send).
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};

    // current_stage  →  status
    // Don't auto-downgrade a case that's already with the paraplanner or
    // approved: the CA might be jumping back to Stage 4/5 to fix or re-call
    // a returned field, and we don't want to wipe out IN_REVIEW / APPROVED.
    if (typeof body.currentStage === "number") {
      const stage = body.currentStage as number;
      const targetStatus = STAGE_TO_STATUS[stage];
      if (targetStatus) {
        const currentCase = await prisma.case.findUnique({
          where: { id: req.params.id },
          select: { status: true },
        });
        const locked =
          currentCase?.status === CaseStatus.IN_REVIEW ||
          currentCase?.status === CaseStatus.STAGE_9_ADVISER_REVIEW ||
          currentCase?.status === CaseStatus.APPROVED ||
          currentCase?.status === CaseStatus.STAGE_10_COMPLETE;
        if (!locked) {
          data.status = targetStatus;
          if (stage === 9) data.readyForReviewAt = new Date();
          if (stage === 10) data.completedAt = new Date();
        }
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

    // LOA bookkeeping (Stage 2 SendLOAWorkspace). Accept null explicitly
    // so the UI can clear a previous value — `typeof null === "object"`,
    // so we test the key presence rather than the type.
    //
    // Per-method fields (added 16 Jun): each panel on Stage 2 owns its own
    // textarea/input pair. Notes + refs no longer leak across tabs.
    if ("loaMethod" in body) data.loaMethod = body.loaMethod as string | null;
    if ("loaOrigoRef" in body) data.loaOrigoRef = body.loaOrigoRef as string | null;
    if ("loaOrigoNotes" in body) data.loaOrigoNotes = body.loaOrigoNotes as string | null;
    if ("loaEmailNotes" in body) data.loaEmailNotes = body.loaEmailNotes as string | null;
    if ("loaCourierRef" in body) data.loaCourierRef = body.loaCourierRef as string | null;
    if ("loaCourierNotes" in body) data.loaCourierNotes = body.loaCourierNotes as string | null;
    if ("loaSentDate" in body) {
      // UI field is the date the LOA went out; stored in loaSentAt (DateTime).
      data.loaSentAt = body.loaSentDate ? new Date(body.loaSentDate as string) : null;
    }
    if ("loaProcessedDate" in body) {
      data.loaProcessedAt = body.loaProcessedDate ? new Date(body.loaProcessedDate as string) : null;
    }
    if ("loaReceivedDate" in body) {
      data.loaReceivedAt = body.loaReceivedDate ? new Date(body.loaReceivedDate as string) : null;
    }
    // loaStatus arrives lowercase ("sent"/"processed"/"received"/"not_sent").
    // Map to the Prisma LOAStatus enum. (SIGNED is in the enum but no UI
    // surface ever sends it — leaving the branch out keeps this honest.)
    if (typeof body.loaStatus === "string") {
      const upper = body.loaStatus.toUpperCase();
      if ((Object.values(LOAStatus) as string[]).includes(upper)) {
        data.loaStatus = upper as LOAStatus;
        // Auto-stamp the matching timestamp when status flips, unless the UI
        // supplied an explicit date for that transition. SIGNED is legacy
        // and intentionally has no timestamp.
        if (upper === "SENT" && !("loaSentDate" in body)) {
          data.loaSentAt = data.loaSentAt ?? new Date();
        }
        if (upper === "PROCESSED" && !("loaProcessedDate" in body)) {
          data.loaProcessedAt = data.loaProcessedAt ?? new Date();
        }
        if (upper === "RECEIVED" && !("loaReceivedDate" in body)) {
          data.loaReceivedAt = data.loaReceivedAt ?? new Date();
        }
      }
    }

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

    // Same handoff side-effects as PATCH /:id/status, so navigating via the
    // stepper doesn't skip paraplanner assignment + notification.
    const nextStatus = data.status as CaseStatus | undefined;
    let paraplannerToNotify: string | null = null;
    if (isAwaitingReview(nextStatus)) {
      paraplannerToNotify = await ensureParaplannerForReview(
        req.params.id,
        data as Prisma.CaseUpdateInput,
      );
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

    if (paraplannerToNotify) {
      await notifyParaplannerReady(paraplannerToNotify, updated);
    }
    if (nextStatus === CaseStatus.APPROVED && updated.assignedToId) {
      await notifyCaseApproved(updated.assignedToId, updated);
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
    } else if (data.loaStatus) {
      // LOA status transitions get their own action so the audit trail (and
      // Stage 2 timeline) can reconstruct the full LOA lifecycle. Metadata
      // carries ALL THREE timestamps so each row is self-describing.
      await prisma.auditLog.create({
        data: {
          caseId: req.params.id,
          userId: req.user!.id,
          action: "LOA_STATUS_UPDATED",
          newValue: String(data.loaStatus),
          source: "MANUAL",
          metadata: {
            loaStatus: updated.loaStatus,
            loaSentAt: updated.loaSentAt,
            loaProcessedAt: updated.loaProcessedAt,
            loaReceivedAt: updated.loaReceivedAt,
          } as Prisma.InputJsonValue,
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
router.patch("/:id/status", requireAuth, requireRole(["CA_TEAM", "ADMIN", "PARAPLANNER", "ADVISER"]), async (req: Request, res: Response) => {
  const { status: rawStatus, onHoldReason } = req.body;

  // Normalise: accept both the Prisma enum literal ("IN_REVIEW") and the
  // UI-side lowercase form ("in_review", "approved", ...).
  let status: CaseStatus | undefined;
  if (typeof rawStatus === "string") {
    const upper = rawStatus.toUpperCase();
    if ((Object.values(CaseStatus) as string[]).includes(upper)) {
      status = upper as CaseStatus;
    } else if (UI_STATUS_TO_PRISMA[rawStatus]) {
      status = UI_STATUS_TO_PRISMA[rawStatus];
    }
  }
  if (!status) {
    return res.status(400).json({ error: `Invalid status: ${rawStatus}` });
  }

  const data: Prisma.CaseUpdateInput = {
    status,
    onHoldReason: status === "ON_HOLD" ? onHoldReason : null,
    readyForReviewAt: isAwaitingReview(status) ? new Date() : undefined,
    approvedAt: status === "APPROVED" ? new Date() : undefined,
    completedAt: status === "STAGE_10_COMPLETE" ? new Date() : undefined,
  };

  let paraplannerToNotify: string | null = null;
  if (isAwaitingReview(status)) {
    paraplannerToNotify = await ensureParaplannerForReview(req.params.id, data);
  }

  const updated = await prisma.case.update({
    where: { id: req.params.id },
    data,
  });

  if (paraplannerToNotify) {
    await notifyParaplannerReady(paraplannerToNotify, updated);
  }
  if (status === "APPROVED" && updated.assignedToId) {
    await notifyCaseApproved(updated.assignedToId, updated);
  }

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
      // Auto-stamp the matching timestamp on each transition. SIGNED is
      // legacy and intentionally has no timestamp.
      loaSentAt: loaStatus === "SENT" ? new Date() : undefined,
      loaProcessedAt: loaStatus === "PROCESSED" ? new Date() : undefined,
      loaReceivedAt: loaStatus === "RECEIVED" ? new Date() : undefined,
    },
  });

  await prisma.auditLog.create({
    data: {
      caseId: req.params.id,
      userId: req.user!.id,
      action: "LOA_STATUS_UPDATED",
      newValue: loaStatus,
      source: "MANUAL",
      // All three timestamps so the audit row preserves the full timeline.
      metadata: {
        loaStatus: updated.loaStatus,
        loaSentAt: updated.loaSentAt,
        loaProcessedAt: updated.loaProcessedAt,
        loaReceivedAt: updated.loaReceivedAt,
      } as Prisma.InputJsonValue,
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
  // Sticky operator pick (Fix 2): only auto-replace from Zoho when no provider
  // is linked yet. After the operator uses the Stage 2 picker (or after import
  // set the link), Zoho-side provider edits don't auto-flow — the operator
  // re-picks in the app.
  let resolvedProviderId: string | null = caseRecord.providerId;
  const currentProviderName = caseRecord.provider?.name ?? null;
  if (
    caseRecord.providerId === null &&
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

  // 3c. Resolve paraplanner from the linked Contact record.
  //
  // The CRM Contact is the source of truth for who's assigned to the
  // client. We read its Paraplanner / Client_Owners field, match the
  // resulting Zoho user email to an app user (auto-creating if missing,
  // same policy as the Task owner above), and re-link the case.
  //
  // Use the freshly-mapped clientZohoId if Zoho returned one (the link
  // may have just been added), otherwise fall back to the stored DB row.
  const effectiveClientZohoId = mapping.clientZohoId ?? caseRecord.clientZohoId ?? null;

  let resolvedParaplannerId: string | null = caseRecord.paralPlannerId;
  let resolvedParaplannerName: string | null = null;
  let paraplannerSyncNote: string | null = null;

  // Cached Zoho IDs — set during sync, used at export time.
  let cachedZohoOwnerId: string | null = null;
  let cachedZohoClientOwnerIds: string[] = [];
  let cachedZohoParaplannerId: string | null = null;

  if (effectiveClientZohoId) {
    try {
      const contact = await getContactRecord(effectiveClientZohoId);
      if (!contact) {
        paraplannerSyncNote = `Contact ${effectiveClientZohoId} not found in CRM.`;
      } else {
        const fields = extractContactUserFields(contact);

        // Snapshot the raw Zoho IDs straight off the Contact — these are
        // what we'll send back to Plans at export time. No re-fetch needed.
        cachedZohoOwnerId = fields.owner?.id ?? null;
        cachedZohoClientOwnerIds = fields.clientOwners.map((u) => u.id);
        cachedZohoParaplannerId = fields.paraplanner?.id ?? null;

        // Prefer single Paraplanner field; fall back to first Client_Owners entry.
        let ref = fields.paraplanner ?? fields.clientOwners[0] ?? null;

        // The Contact's User Lookup often returns `{id, name}` without
        // `email`. Enrich from /users/{id} so the local-user match /
        // auto-create has the email it needs.
        if (ref && !ref.email && ref.id) {
          const full = await findZohoUserById(ref.id);
          if (full) {
            ref = {
              id: ref.id,
              name: ref.name ?? full.full_name,
              email: full.email,
            };
          }
        }

        if (!ref) {
          paraplannerSyncNote = "No Paraplanner or Client_Owners on Contact.";
        } else if (ref.email) {
          const lower = ref.email.toLowerCase();
          const existing = await prisma.user.findUnique({ where: { email: lower } });
          if (existing && existing.status === "ACTIVE") {
            resolvedParaplannerId = existing.id;
            resolvedParaplannerName = existing.name;
          } else if (existing && existing.status === "INACTIVE") {
            resolvedParaplannerId = null;
            resolvedParaplannerName = null;
            paraplannerSyncNote = `Matched user ${lower} is inactive — unassigning.`;
          } else {
            // Auto-provision the paraplanner so the case can be linked
            // immediately. Same policy as owner auto-create.
            const created = await prisma.user.create({
              data: {
                email: lower,
                name: ref.name?.trim() || lower.split("@")[0],
                role: "PARAPLANNER",
                status: "ACTIVE",
              },
            });
            resolvedParaplannerId = created.id;
            resolvedParaplannerName = created.name;
          }
        } else if (ref.name) {
          // No email on the Contact field — try a name-only match (no
          // auto-create, same policy as owner).
          const byName = await prisma.user.findFirst({
            where: {
              name: { equals: ref.name, mode: "insensitive" },
              role: "PARAPLANNER",
              status: "ACTIVE",
            },
          });
          if (byName) {
            resolvedParaplannerId = byName.id;
            resolvedParaplannerName = byName.name;
          } else {
            paraplannerSyncNote = `Paraplanner "${ref.name}" not found in app users (no email on Contact to auto-create).`;
          }
        }
      }
    } catch (err) {
      paraplannerSyncNote = `Contact fetch failed: ${(err as Error).message}`;
    }
  }

  // 3d. Resolve Provider Zoho record id by searching the Providers module
  //     by name. Stored on the case so export skips the search.
  let cachedZohoProviderId: string | null = null;
  let providerSyncNote: string | null = null;
  const effectiveProviderName =
    mapping.providerName ?? caseRecord.provider?.name ?? null;
  if (effectiveProviderName) {
    try {
      const hit = await findProviderRecordByName(effectiveProviderName);
      if (hit) cachedZohoProviderId = hit.id;
      else providerSyncNote = `No unique Providers record for name="${effectiveProviderName}"`;
    } catch (err) {
      providerSyncNote = `Providers search failed: ${(err as Error).message}`;
    }
  }

  // 4. Diff
  const updates: Record<string, unknown> = {};
  const changes: { field: string; from: unknown; to: unknown }[] = [];

  // Always stamp the cached Zoho IDs — even if no value changed, we want
  // the audit trail to record when the cache was refreshed.
  updates.zohoOwnerId = cachedZohoOwnerId;
  updates.zohoClientOwnerIds = cachedZohoClientOwnerIds;
  updates.zohoParaplannerId = cachedZohoParaplannerId;
  updates.zohoProviderRecordId = cachedZohoProviderId;
  updates.zohoSyncedAt = new Date();
  // We deliberately do NOT push these into `changes[]` — they're internal
  // bookkeeping. Real CRM diffs (clientName, paraplanner, …) still appear.

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

  // 3e. Plans-module linkage by Policy_Ref fallback + Plan Name capture.
  //
  // The Zoho Task carries a `What_Id` only when the operator linked the
  // Task to a Plans record before we imported it. In practice many tasks
  // land here unlinked, even though a matching Plans record exists in CRM
  // (linked by Client_Owners instead). Without this fallback the case
  // header showed "⚠ Not linked" until a Stage 9 export ran, which felt
  // wrong to testers — the CRM clearly had the right record all along.
  //
  // Two paths, both end up populating zohoPlanName (Plans.Name, e.g.
  // "Plan119575") so the header can show <Name> (<Policy Ref>):
  //   • If we still don't have a zohoCaseId, search Plans by Policy_Ref.
  //   • If we have a zohoCaseId but no cached zohoPlanName (legacy rows
  //     pre-dating this column), fetch the Plans record by id to backfill.
  let planSyncNote: string | null = null;
  const effectiveZohoCaseId =
    (updates.zohoCaseId as string | undefined) ?? caseRecord.zohoCaseId;
  const effectivePolicyRef =
    (updates.policyRef as string | undefined) ?? caseRecord.policyRef;
  const pickPlanName = (rec: Record<string, unknown>): string | null => {
    const n = rec.Name;
    return typeof n === "string" && n.trim() ? n.trim() : null;
  };
  if (!effectiveZohoCaseId && effectivePolicyRef) {
    try {
      const hit = await findPlanRecordByPolicyRef(effectivePolicyRef);
      if (hit) {
        updates.zohoCaseId = hit.id;
        const planName = pickPlanName(hit.record);
        if (planName) updates.zohoPlanName = planName;
        changes.push({
          field: "linkedPlan",
          from: null,
          to: planName ?? hit.id,
        });
      } else {
        planSyncNote = `No unique Plans record for Policy_Ref="${effectivePolicyRef}"`;
      }
    } catch (err) {
      planSyncNote = `Plans search by Policy_Ref failed: ${(err as Error).message}`;
    }
  } else if (effectiveZohoCaseId && !caseRecord.zohoPlanName) {
    // Backfill Plan Name for cases that already had zohoCaseId cached but
    // are missing the display name. One-shot — once stored, sync won't
    // re-fetch it.
    try {
      const rec = await findPlanRecordById(effectiveZohoCaseId);
      if (rec) {
        const planName = pickPlanName(rec.record);
        if (planName) updates.zohoPlanName = planName;
      }
    } catch (err) {
      planSyncNote = `Plan Name backfill failed: ${(err as Error).message}`;
    }
  }
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
  if (resolvedParaplannerId !== caseRecord.paralPlannerId) {
    updates.paralPlannerId = resolvedParaplannerId;
    changes.push({
      field: "paraplanner",
      // We don't have the previous paraplanner name handy here; the audit
      // metadata below still captures the full transition.
      from: caseRecord.paralPlannerId,
      to: resolvedParaplannerName ?? resolvedParaplannerId,
    });
  }

  // We always have at least the cached Zoho IDs in `updates`, so always
  // apply. `changed` for the response reflects real CRM-data changes only
  // (the cache refresh is internal bookkeeping).
  const updated = await prisma.case.update({
    where: { id },
    data: updates,
    include: { provider: true, assignedTo: true, createdBy: true },
  });
  const changedRealData = changes.length > 0;

  // 6. Audit — only when Zoho actually changed something on the case.
  //
  // Previously this fired on every sync (page-load auto-sync + manual
  // "Refresh from Zoho" button), so the timeline filled up with rows
  // saying "Synced 0 fields from Zoho · via System" — pure noise. Now we
  // skip the audit row when no real CRM data changed; the cached Zoho IDs
  // refresh still happens silently (it's internal bookkeeping, not a CRM
  // mutation the auditor cares about), and any sync notes are still
  // returned in the HTTP response for the UI / debugging.
  if (changedRealData) {
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
          paraplannerSyncNote,
          providerSyncNote,
          planSyncNote,
          cachedZohoIds: {
            zohoOwnerId: cachedZohoOwnerId,
            zohoClientOwnerIds: cachedZohoClientOwnerIds,
            zohoParaplannerId: cachedZohoParaplannerId,
            zohoProviderRecordId: cachedZohoProviderId,
          },
        } as Prisma.InputJsonValue,
      },
    });
  }

  res.json({
    synced: true,
    changed: changedRealData,
    changes,
    paraplannerSyncNote,
    providerSyncNote,
    planSyncNote,
    cachedZohoIds: {
      zohoOwnerId: cachedZohoOwnerId,
      zohoClientOwnerIds: cachedZohoClientOwnerIds,
      zohoParaplannerId: cachedZohoParaplannerId,
      zohoProviderRecordId: cachedZohoProviderId,
    },
    case: updated,
  });
});

// ── D4: Plans-record link/create flow ────────────────────────
// Three endpoints back the unlinked-plan banner on Stage 1 + Stage 9
// fallback. The frontend never talks to Zoho directly — these proxy
// through so the OAuth token + module-name resolution stay server-side.

// Multi-result Plans search by Policy_Ref starts-with.
// Used by the "Link existing" picker — returns up to 10 candidates.
router.get(
  "/plans/search",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const q = (req.query.q as string | undefined) ?? "";
    if (!q.trim()) return res.json({ hits: [] });
    try {
      const hits = await searchPlansByPolicyRefStartsWith(q, 10);
      res.json({ hits });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  },
);

// Link a chosen existing Plans record to this case.
// Updates the case row (zohoCaseId, zohoPlanName) and, if a Zoho Task is
// linked, PATCHes Task.What_Id so the linkage is durable on the CRM side.
const LinkPlanSchema = z.object({ planRecordId: z.string().min(1) });
router.post(
  "/:id/link-plan",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const parsed = LinkPlanSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const caseRow = await prisma.case.findUnique({
      where: { id: req.params.id },
      select: { id: true, zohoTaskId: true },
    });
    if (!caseRow) return res.status(404).json({ error: "Case not found" });

    const { planRecordId } = parsed.data;
    // Fetch the Plans record so we can cache Name + verify the id is real
    // before we touch Task.What_Id. Better to 502 here than half-link.
    let planName: string | null = null;
    try {
      const rec = await findPlanRecordById(planRecordId);
      if (!rec) return res.status(404).json({ error: "Plans record not found in Zoho" });
      const nm = rec.record.Name;
      if (typeof nm === "string" && nm.trim()) planName = nm.trim();
    } catch (err) {
      return res.status(502).json({ error: `Plans fetch failed: ${(err as Error).message}` });
    }

    // Best-effort Task linkage. If it fails (permissions, deleted Task,
    // etc.), still cache the linkage on the case row — export only needs
    // the case-side data.
    let taskLinkNote: string | null = null;
    if (caseRow.zohoTaskId) {
      try {
        await linkTaskToPlan(caseRow.zohoTaskId, planRecordId);
      } catch (err) {
        taskLinkNote = `Task ${caseRow.zohoTaskId} What_Id update failed: ${(err as Error).message}`;
      }
    }

    const updated = await prisma.case.update({
      where: { id: req.params.id },
      data: { zohoCaseId: planRecordId, zohoPlanName: planName },
    });
    await prisma.auditLog.create({
      data: {
        caseId: req.params.id,
        userId: req.user!.id,
        action: "CASE_UPDATED",
        source: "MANUAL",
        newValue: `Linked Plans record ${planName ?? planRecordId}`,
        metadata: { linkedPlan: { id: planRecordId, name: planName }, taskLinkNote } as Prisma.InputJsonValue,
      },
    });
    res.json({ ok: true, planRecordId, planName, taskLinkNote, case: updated });
  },
);

// Create a new Plans record in Zoho from the case's current data, then
// link it back. Three writes happen here:
//   1. POST a new Plans record with Policy_Ref + Plan_Type + Provider
//   2. PATCH the Zoho Task's What_Id so it points at the new Plan
//   3. Create Plans_X_Clients junction row(s) so the Plan appears under
//      the client in CRM — uses cached zohoClientOwnerIds / clientZohoId
//      (multi-client / joint plans get multiple junction rows).
router.post(
  "/:id/create-plan",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const caseRow = await prisma.case.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        policyRef: true,
        planType: true,
        zohoTaskId: true,
        zohoProviderRecordId: true,
        clientZohoId: true,
        zohoClientOwnerIds: true,
      },
    });
    if (!caseRow) return res.status(404).json({ error: "Case not found" });
    if (!caseRow.policyRef) {
      return res.status(400).json({ error: "Case has no Policy Ref — cannot create a Plans record without it." });
    }

    const fields: Record<string, unknown> = {
      Policy_Ref: caseRow.policyRef,
      Plan_Type: mapPlanTypeToZoho(caseRow.planType),
    };
    if (caseRow.zohoProviderRecordId) {
      fields.Provider = { id: caseRow.zohoProviderRecordId };
    }
    // Plan↔Client linkage is NOT a field on the Plans record itself — it's
    // a separate row in the Plans_X_Clients junction module, created below
    // via createPlansXClientsLinks() once the Plan record id is known.

    let created: { id: string; name: string | null };
    try {
      created = await createPlanRecord(fields);
    } catch (err) {
      return res.status(502).json({ error: (err as Error).message });
    }

    let taskLinkNote: string | null = null;
    if (caseRow.zohoTaskId) {
      try {
        await linkTaskToPlan(caseRow.zohoTaskId, created.id);
      } catch (err) {
        taskLinkNote = `Task ${caseRow.zohoTaskId} What_Id update failed: ${(err as Error).message}`;
      }
    }

    // Plans_X_Clients junction — without this, the new Plan won't appear under
    // the Client in CRM. Use cached client-owner IDs (multi-client / joint
    // plans get multiple rows); fall back to clientZohoId for single-client cases.
    const clientOwnerIds =
      caseRow.zohoClientOwnerIds && caseRow.zohoClientOwnerIds.length > 0
        ? caseRow.zohoClientOwnerIds
        : caseRow.clientZohoId
          ? [caseRow.clientZohoId]
          : [];
    let plansXClientsResult: { created: number; errors: string[] } = { created: 0, errors: [] };
    if (clientOwnerIds.length > 0) {
      try {
        plansXClientsResult = await createPlansXClientsLinks(created.id, clientOwnerIds);
      } catch (err) {
        plansXClientsResult = {
          created: 0,
          errors: [`Plans_X_Clients call threw: ${(err as Error).message}`],
        };
      }
    }
    const plansXClientsNote =
      clientOwnerIds.length === 0
        ? "No client IDs cached on the case — Plans_X_Clients skipped"
        : plansXClientsResult.errors.length === 0
          ? `Plans_X_Clients ${plansXClientsResult.created} of ${clientOwnerIds.length} linked`
          : `Plans_X_Clients ${plansXClientsResult.created}/${clientOwnerIds.length} — errors: ${plansXClientsResult.errors.join("; ")}`;

    const updated = await prisma.case.update({
      where: { id: req.params.id },
      data: { zohoCaseId: created.id, zohoPlanName: created.name },
    });
    await prisma.auditLog.create({
      data: {
        caseId: req.params.id,
        userId: req.user!.id,
        action: "CASE_UPDATED",
        source: "MANUAL",
        newValue: `Created Plans record ${created.name ?? created.id}`,
        metadata: {
          createdPlan: { id: created.id, name: created.name },
          payload: fields,
          taskLinkNote,
          plansXClientsNote,
          plansXClientsResult,
        } as Prisma.InputJsonValue,
      },
    });
    res.json({
      ok: true,
      planRecordId: created.id,
      planName: created.name,
      taskLinkNote,
      plansXClientsNote,
      plansXClientsCreated: plansXClientsResult.created,
      plansXClientsErrors: plansXClientsResult.errors,
      case: updated,
    });
  },
);

export { router as caseRoutes };
