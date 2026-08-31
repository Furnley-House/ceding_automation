// backend/src/routes/cases.ts
import { Router, Request, Response } from "express";
import { PrismaClient, CaseStatus, LOAStatus, PlanType, Prisma } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";
import * as zoho from "../services/zohoCrm";
import { SYSTEM_USER_ID } from "../services/aiBffApply";
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
  planProviderField,
  planModuleName,
  inferPlanType,
} from "../services/zohoCrm";
import { generateNextCaseRef } from "../services/caseRef";

const router = Router();
const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────
// Ship #1 (H18) — Locked-field guard
//
// Once a case has any AI extraction on record (i.e. at least one
// checklist_field row with aiExtractedAt IS NOT NULL), three fields
// on the case become LOCKED against ALL non-admin-explicit writes:
//   • planType — reshapes the entire checklist template set
//   • providerId — reshapes provider-alias merge behaviour
//   • policyRef — used by Zoho linkage + WorkDrive path resolution
//
// The guard is UNCONDITIONAL: it does not read req.user.role.
// The manual PATCH /cases/:id path and the auto-`/sync-from-zoho`
// sync path both funnel through guardLockedFields; admins do NOT
// bypass by loading the page. The only paths that can mutate a
// locked field are:
//   • PATCH /cases/:id/locked-field/:field (admin-only, explicit)
//   • POST /admin/cases/:id/reset-plan-type (admin-only, plus
//     orphan-row cleanup, needed for FH-010 remediation)
// Dismissal (admin acknowledgement without changing the local value)
// goes through POST /cases/:id/locked-field/:field/dismiss.
//
// Rationale: FH-098 lost the AI-extracted values when Zoho flipped
// planType silently between extraction runs. Freezing these three
// fields after any extraction blocks the failure mode without
// requiring the user to know planType is load-bearing.
// ─────────────────────────────────────────────────────────

const LOCKED_FIELDS = ["planType", "providerId", "policyRef"] as const;
type LockedField = (typeof LOCKED_FIELDS)[number];

function isLockedField(name: string): name is LockedField {
  return (LOCKED_FIELDS as readonly string[]).includes(name);
}

// H23: predicate is `aiExtractedAt IS NOT NULL` and NOT `id IS NOT NULL`.
// The pre-extraction window is intentionally open to planType corrections
// (Messina FH-2026-000173, 2026-08-21: Zoho corrected FINAL_SALARY →
// PENSION 98 min after import; that correction MUST NOT be blocked).
// Seeding creates rows with aiExtractedAt=NULL, so a case that just got
// seed-if-empty'd at /sync-from-zoho (see the H23 block near the end of
// that handler) is still eligible for further planType corrections until
// the first extraction lands a value. If a future change wants "seeded =
// protected" semantics, switching this predicate to a plain
// findFirst({caseId}) reverses the current design intent: crm.ts seeds
// every Zoho-imported case at creation (except the FINAL_SALARY / BOND
// zero-template branch), so under `id IS NOT NULL` the guard would fire
// immediately after case creation and Zoho's later planType correction
// — the mechanism that would have healed Messina — would be blocked at
// guardLockedFields (which runs BEFORE the /sync-from-zoho transaction,
// so it sees the freshly-seeded rows from the import that happened
// minutes to hours earlier). Don't do that. If pre-extraction planType
// stability becomes a product requirement, use a separate mechanism
// (e.g. a `planTypeConfirmedAt` column) rather than repurposing this
// predicate.
async function caseHasExtractionRun(caseId: string): Promise<boolean> {
  const row = await prisma.checklistField.findFirst({
    where: { caseId, aiExtractedAt: { not: null } },
    select: { id: true },
  });
  return row !== null;
}

interface BlockedChange {
  field: LockedField;
  currentValue: string | null;
  attemptedValue: string | null;
}

/**
 * Filter a set of requested case updates against the locked-field
 * policy. Returns the updates that are safe to write plus the list
 * of updates that were blocked. Caller MUST persist an audit row
 * per blocked entry via emitBlockedAudit().
 *
 * `source` is what will land in the audit row's `source` column
 * (existing convention: "ZOHO_SYNC" | "MANUAL"). `triggerUserId`
 * is the human who triggered the mutation; the audit row itself
 * uses SYSTEM_USER_ID for sync-path attribution so downstream
 * queries can distinguish "someone loaded the page" from "an
 * admin made a deliberate change".
 */
async function guardLockedFields(args: {
  caseId: string;
  requested: Record<string, unknown>;
  current: { planType?: string | null; providerId?: string | null; policyRef?: string | null };
  source: "ZOHO_SYNC" | "MANUAL";
  triggerUserId: string;
}): Promise<{ safe: Record<string, unknown>; blocked: BlockedChange[] }> {
  const requested = { ...args.requested };
  const blocked: BlockedChange[] = [];

  // Cheap escape: if no locked field is being touched, skip the
  // extraction lookup entirely.
  const touchedLockedFields = LOCKED_FIELDS.filter((f) => f in requested);
  if (touchedLockedFields.length === 0) {
    return { safe: requested, blocked: [] };
  }

  const shouldGuard = await caseHasExtractionRun(args.caseId);
  if (!shouldGuard) {
    return { safe: requested, blocked: [] };
  }

  for (const field of touchedLockedFields) {
    const attempted = requested[field];
    const attemptedStr =
      attempted === null || attempted === undefined ? null : String(attempted);
    const currentStr = (args.current as Record<string, unknown>)[field];
    const currentStrNorm =
      currentStr === null || currentStr === undefined ? null : String(currentStr);

    if (attemptedStr === currentStrNorm) {
      // Not actually a change — silently drop from requested, no audit.
      delete requested[field];
      continue;
    }

    // Check if this exact attempt was already dismissed by an admin
    // (derived from audit log — see plan item 3).
    const dismissed = await isDismissed({
      caseId: args.caseId,
      field,
      attemptedValue: attemptedStr,
    });
    if (dismissed) {
      // Silent no-op — admin has chosen to ignore this Zoho drift.
      delete requested[field];
      continue;
    }

    blocked.push({ field, currentValue: currentStrNorm, attemptedValue: attemptedStr });
    delete requested[field];
  }

  return { safe: requested, blocked };
}

/**
 * Derive whether a particular (field, attemptedValue) has been
 * dismissed by an admin. Compares the latest DISMISSED metadata
 * against the current attempt. Cheap given the @@index([caseId])
 * on audit_logs.
 */
async function isDismissed(args: {
  caseId: string;
  field: LockedField;
  attemptedValue: string | null;
}): Promise<boolean> {
  const latestDismiss = await prisma.auditLog.findFirst({
    where: {
      caseId: args.caseId,
      action: "LOCKED_FIELD_CHANGE_DISMISSED",
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  if (!latestDismiss?.metadata) return false;
  const md = latestDismiss.metadata as Record<string, unknown>;
  return md.field === args.field && md.attemptedValue === args.attemptedValue;
}

/**
 * Persist a LOCKED_FIELD_CHANGE_BLOCKED audit row. Called once per
 * blocked change. userId is SYSTEM_USER_ID because the mutation was
 * not a deliberate act by req.user; metadata.trigger carries the
 * loader who caused the sync so an ops query can still surface who
 * was on the page when the sync fired.
 */
async function emitBlockedAudit(args: {
  caseId: string;
  caseRef: string;
  blocked: BlockedChange;
  source: "ZOHO_SYNC" | "MANUAL";
  triggerUserId: string;
}): Promise<void> {
  // Structured stdout line so Container Apps → Log Analytics can alert on
  // blocked syncs before the Ship #3 UI banner exists. Values are the same
  // ones already persisted in audit_logs.newValue below; policyRef /
  // providerId / planType are not standalone PII.
  console.warn(
    JSON.stringify({
      evt: "LOCKED_FIELD_BLOCKED",
      caseRef: args.caseRef,
      field: args.blocked.field,
      currentValue: args.blocked.currentValue,
      attemptedValue: args.blocked.attemptedValue,
      source: args.source,
      triggerUserId: args.triggerUserId,
    }),
  );
  await prisma.auditLog.create({
    data: {
      caseId: args.caseId,
      userId: SYSTEM_USER_ID,
      action: "LOCKED_FIELD_CHANGE_BLOCKED",
      source: args.source,
      newValue: `Blocked change to ${args.blocked.field}: "${args.blocked.currentValue ?? "<null>"}" → "${args.blocked.attemptedValue ?? "<null>"}"`,
      metadata: {
        field: args.blocked.field,
        currentValue: args.blocked.currentValue,
        attemptedValue: args.blocked.attemptedValue,
        trigger: { userId: args.triggerUserId, at: new Date().toISOString() },
      } as Prisma.InputJsonValue,
    },
  });
}

/**
 * Summarise locked-field activity for a case, exposed on GET
 * /cases/:id as `lockedFieldAttempts`. Each element is the latest
 * BLOCKED per (field, attemptedValue) with any subsequent DISMISSED
 * merged in. Ship #3's banner reads this directly.
 */
interface LockedFieldAttempt {
  field: LockedField;
  currentValue: string | null;
  attemptedValue: string | null;
  source: string | null;
  triggerUserId: string | null;
  at: Date;
  dismissed: boolean;
  dismissedBy: string | null;
  dismissedAt: Date | null;
  dismissReason: string | null;
}

async function getLockedFieldAttempts(caseId: string): Promise<LockedFieldAttempt[]> {
  const rows = await prisma.auditLog.findMany({
    where: {
      caseId,
      action: {
        in: ["LOCKED_FIELD_CHANGE_BLOCKED", "LOCKED_FIELD_CHANGE_DISMISSED"],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const latestBlocked = new Map<string, typeof rows[number]>();
  const latestDismissed = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const md = (row.metadata ?? {}) as Record<string, unknown>;
    const field = typeof md.field === "string" ? md.field : null;
    if (!field || !isLockedField(field)) continue;
    const key = `${field}|${JSON.stringify(md.attemptedValue ?? null)}`;
    if (row.action === "LOCKED_FIELD_CHANGE_BLOCKED" && !latestBlocked.has(key)) {
      latestBlocked.set(key, row);
    } else if (
      row.action === "LOCKED_FIELD_CHANGE_DISMISSED" &&
      !latestDismissed.has(key)
    ) {
      latestDismissed.set(key, row);
    }
  }

  const attempts: LockedFieldAttempt[] = [];
  for (const [key, blockedRow] of latestBlocked) {
    const md = (blockedRow.metadata ?? {}) as Record<string, unknown>;
    const dismissedRow = latestDismissed.get(key);
    // A dismissal supersedes a block only if it happened AFTER the block.
    const isDismissedNow =
      dismissedRow !== undefined && dismissedRow.createdAt > blockedRow.createdAt;
    const dismissMd = isDismissedNow
      ? ((dismissedRow!.metadata ?? {}) as Record<string, unknown>)
      : null;
    const trigger =
      md.trigger && typeof md.trigger === "object"
        ? (md.trigger as Record<string, unknown>)
        : null;
    attempts.push({
      field: (md.field as LockedField),
      currentValue: (md.currentValue as string | null) ?? null,
      attemptedValue: (md.attemptedValue as string | null) ?? null,
      source: blockedRow.source,
      triggerUserId: (trigger?.userId as string | null) ?? null,
      at: blockedRow.createdAt,
      dismissed: isDismissedNow,
      dismissedBy: isDismissedNow ? dismissedRow!.userId : null,
      dismissedAt: isDismissedNow ? dismissedRow!.createdAt : null,
      dismissReason:
        isDismissedNow && typeof dismissMd?.reason === "string"
          ? (dismissMd!.reason as string)
          : null,
    });
  }
  attempts.sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
  return attempts;
}

/**
 * Reject case creation / planType change if the target plan type
 * has no active checklist templates (Decision 2). PROTECTION,
 * BOND, FINAL_SALARY etc. are in the enum but Phase 2 — no
 * templates yet.
 */
async function planTypeHasTemplates(planType: PlanType): Promise<boolean> {
  const cnt = await prisma.checklistTemplate.count({
    where: { planType, isActive: true },
  });
  return cnt > 0;
}

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

  // Ship #1 (H18 Decision 2): reject plan types with no active
  // checklist templates. PROTECTION / BOND / FINAL_SALARY / GIA
  // are in the enum but only PENSION and ISA have templates in
  // prod today. Without this check, an operator can create an
  // FH-010-shape case that has no extractable fields — extraction
  // then submits with an empty checklistFields array (matches the
  // H18 empty-`fields` array hypothesis on the 5 orphan docs).
  if (!(await planTypeHasTemplates(planType))) {
    return res.status(422).json({
      error: `Plan type "${planType}" is not implemented yet. Contact an admin to request template rollout.`,
      code: "PLAN_TYPE_NOT_IMPLEMENTED",
      planType,
    });
  }

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

  // Initialise checklist fields from template.
  //
  // H23: seeded rows have aiExtractedAt=NULL, so the Ship #1 guard at
  // caseHasExtractionRun (this file, near the top) stays OFF until first
  // extraction — pre-extraction planType corrections remain unblocked.
  // No `else` branch on templates.length===0 here: manual create is
  // already gated by planTypeHasTemplates at ~line 339 (returns 422
  // before this block is reached), so a zero-template result is
  // unreachable on this path. Contrast crm.ts's Zoho-import seed which
  // does emit an audit + warn on the zero-template branch — Zoho
  // intake is intentionally not gated (see H23 tracker entry).
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

  // Ship #1 (H18): surface the locked-field guard's activity on
  // this case so any consumer of GET /cases/:id (Ship #3 banner,
  // exports, ops tools) can render / react to blocked-sync attempts
  // without a second endpoint. Derived from audit_logs — see the
  // getLockedFieldAttempts helper for the derivation contract.
  const lockedFieldAttempts = await getLockedFieldAttempts(req.params.id);
  res.json({ ...caseRecord, lockedFieldAttempts });
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

/**
 * Return the value of the first key in `record` that has a non-empty
 * string value, or null if none match. Used by the Refresh-from-Zoho
 * diagnostic snapshot to show which of our candidate field names was
 * actually populated on the Task (so ops can see if their Zoho org
 * uses a different field name from what our lookup expects).
 */
function firstNonEmpty(record: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = record[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
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

    // Ship #1 (H18): guard locked fields on manual PATCH just like
    // on the sync path. The guard is UNCONDITIONAL — role is NOT
    // checked here even for ADMINs. Admins mutate locked fields
    // via PATCH /cases/:id/locked-field/:field, which is explicit,
    // logged as LOCKED_FIELD_CHANGED, and requires a reason.
    const touchedLocked = LOCKED_FIELDS.filter((f) => f in data);
    let manualBlocked: BlockedChange[] = [];
    if (touchedLocked.length > 0) {
      const currentForGuard = await prisma.case.findUnique({
        where: { id: req.params.id },
        select: { caseRef: true, planType: true, providerId: true, policyRef: true },
      });
      if (!currentForGuard) {
        return res.status(404).json({ error: "Case not found" });
      }
      const result = await guardLockedFields({
        caseId: req.params.id,
        requested: data,
        current: currentForGuard,
        source: "MANUAL",
        triggerUserId: req.user!.id,
      });
      Object.assign(data, result.safe);
      // Also strip any locked-field keys that guardLockedFields
      // removed but weren't in `result.safe` (guardLockedFields
      // mutates by returning a filtered `safe` map; drop those
      // keys from `data` explicitly to be safe).
      for (const lf of LOCKED_FIELDS) {
        if (!(lf in result.safe)) delete (data as Record<string, unknown>)[lf];
      }
      manualBlocked = result.blocked;
      for (const b of manualBlocked) {
        await emitBlockedAudit({
          caseId: req.params.id,
          caseRef: currentForGuard.caseRef,
          blocked: b,
          source: "MANUAL",
          triggerUserId: req.user!.id,
        });
      }
      // If ALL the caller sent was locked-field writes and they
      // were all blocked, `data` may now be empty. Short-circuit
      // with a 409 that names the blocked fields so the UI can
      // render a "contact admin" message.
      if (Object.keys(data).length === 0 && manualBlocked.length > 0) {
        const current = await prisma.case.findUnique({
          where: { id: req.params.id },
          include: { provider: true, assignedTo: true, createdBy: true },
        });
        return res.status(409).json({
          error: "Locked fields cannot be changed after extraction has run. Contact an admin.",
          code: "LOCKED_FIELD",
          blocked: manualBlocked,
          case: current,
        });
      }
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

  // Diagnostic snapshot — echoed in the response so the UI can show a
  // CA (or us during triage) exactly what Zoho returned and why the sync
  // did or didn't change something. Non-sensitive: only echoes back the
  // presence of the fields we already look at, not raw Zoho payloads.
  const syncDebug: {
    taskFieldsSeen: {
      providerField: string | null;
      planTypeField: string | null;
      policyRefField: string | null;
      subject: string | null;
    };
    /** Every non-empty top-level string/object-with-name field on the Zoho
     *  Task, keyed by API name. Lets ops eyeball a case's actual field
     *  names to catch mismatches without opening the Zoho API. */
    rawTaskFieldNames: string[];
    extracted: {
      providerName: string | null;
      planTypeRaw: string | null;
      policyRef: string | null;
    };
    plansRecord: {
      fetched: boolean;
      providerName: string | null;
      planTypeRaw: string | null;
      planName: string | null;
      note: string | null;
    };
    providerDirectory: {
      lookupName: string | null;
      matched: boolean;
    };
  } = {
    taskFieldsSeen: {
      providerField: firstNonEmpty(taskRecord, [
        "Provider_Group", "Provider_group", "Ceding_Provider", "Provider_Name", "Provider",
      ]),
      planTypeField: firstNonEmpty(taskRecord, [
        "Ceding_Type", "Plan_Type", "PlanType", "Product_Type",
      ]),
      policyRefField: firstNonEmpty(taskRecord, [
        "Plan_reference", "Plan_Reference", "Policy_Ref", "Policy_Number",
      ]),
      subject: firstNonEmpty(taskRecord, ["Subject"]),
    },
    rawTaskFieldNames: Object.keys(taskRecord).filter((k) => {
      const v = taskRecord[k];
      if (typeof v === "string") return v.trim().length > 0;
      if (v && typeof v === "object" && "name" in (v as Record<string, unknown>)) {
        const n = (v as Record<string, unknown>).name;
        return typeof n === "string" && n.trim().length > 0;
      }
      return false;
    }),
    extracted: {
      providerName: mapping.providerName ?? null,
      planTypeRaw:
        (typeof taskRecord.Ceding_Type === "string" && taskRecord.Ceding_Type) ||
        (typeof taskRecord.Plan_Type === "string" && taskRecord.Plan_Type) ||
        null,
      policyRef: mapping.policyRef ?? null,
    },
    plansRecord: {
      fetched: false,
      providerName: null,
      planTypeRaw: null,
      planName: null,
      note: null,
    },
    providerDirectory: {
      lookupName: null,
      matched: false,
    },
  };

  // 3a. Resolve provider from name → ID.
  //
  // We *used* to require `caseRecord.providerId === null` (a "sticky operator
  // pick" — once a provider was linked, Zoho-side changes wouldn't flow), on
  // the theory that operators would fix name-drift in the app. Furnley's
  // real workflow flipped that assumption: they update Provider Name in the
  // Zoho CRM (either on the Task or the Plans record — see 3d below), then
  // hit Refresh in the app expecting the change to come through. Sticky-pick
  // was blocking that entirely.
  //
  // New rule: on every refresh, if Zoho's provider name differs from what
  // the app has, look it up in the Provider Directory and update. If no
  // matching Provider row exists in our DB, leave the current link alone
  // (never orphan a case just because Zoho has a name we haven't onboarded).
  let resolvedProviderId: string | null = caseRecord.providerId;
  const currentProviderName = caseRecord.provider?.name ?? null;
  const zohoProviderName =
    mapping.providerName && mapping.providerName.trim() ? mapping.providerName.trim() : null;
  const providerNameChanged =
    zohoProviderName !== null &&
    zohoProviderName.toLowerCase() !== (currentProviderName ?? "").trim().toLowerCase();
  if (providerNameChanged) {
    syncDebug.providerDirectory.lookupName = zohoProviderName;
    const provider = await prisma.provider.findFirst({
      where: { name: { equals: zohoProviderName, mode: "insensitive" } },
    });
    if (provider) {
      resolvedProviderId = provider.id;
      syncDebug.providerDirectory.matched = true;
    }
    // If no match, leave the existing providerId alone — better than orphaning.
    // The change still shows up in the `changes[]` array below because
    // effectiveProviderName reflects the Zoho value.
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

  // 3e. Plans-module linkage: Plan Name + authoritative Plan_Type / Provider.
  //
  // The Zoho Task carries a `What_Id` only when the operator linked the
  // Task to a Plans record before we imported it. In practice many tasks
  // land here unlinked, even though a matching Plans record exists in CRM
  // (linked by Client_Owners instead). Without this fallback the case
  // header showed "⚠ Not linked" until a Stage 9 export ran, which felt
  // wrong to testers — the CRM clearly had the right record all along.
  //
  // When the Plans record is linked (either it was already, or we just
  // resolved it via Policy_Ref search), we fetch the record and pull three
  // things off it:
  //   • Name → zohoPlanName (case header display)
  //   • Plan_Type → overrides the Task's Plan_Type if present (Furnley
  //     updates plan-type on the Plans record; the Task's copy goes stale)
  //   • Provider (Lookup.name) → overrides Task Provider_group for the
  //     same reason
  // Both overrides feed considerChange so the response's `changes[]`
  // reflects the real diff.
  let planSyncNote: string | null = null;
  let planRecord: Record<string, unknown> | null = null;
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
        planRecord = hit.record;
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
  } else if (effectiveZohoCaseId) {
    // Case already linked to a Plans record — refetch on every sync so
    // Plans-record edits (Plan_Type, Provider) come through. Also
    // opportunistically backfills zohoPlanName on legacy rows that
    // predate that column.
    try {
      const rec = await findPlanRecordById(effectiveZohoCaseId);
      if (rec) {
        planRecord = rec.record;
        const planName = pickPlanName(rec.record);
        if (planName && planName !== caseRecord.zohoPlanName) {
          updates.zohoPlanName = planName;
        }
      } else if (effectivePolicyRef) {
        // Auto-heal: the stored zohoCaseId doesn't resolve in the Plans
        // module (returns HTTP 204). This happens in Furnley's prod org
        // where Task.What_Id points at a Deal record (advice pipeline),
        // not a Plans record — so the sync originally cached the Deal
        // ID as zohoCaseId, and every Plans lookup with it 400s or 204s.
        // Fall back to Policy_Ref search, which lands on the correct
        // Plans record (verified against prod: /Plans/{stored-id} → 204,
        // /Plans/search?criteria=Policy_Ref:equals:{ref} → 200).
        // Persist the corrected id so the export path (and every future
        // sync) skips this second lookup.
        try {
          const hit = await findPlanRecordByPolicyRef(effectivePolicyRef);
          if (hit) {
            updates.zohoCaseId = hit.id;
            planRecord = hit.record;
            const planName = pickPlanName(hit.record);
            if (planName) updates.zohoPlanName = planName;
            changes.push({
              field: "linkedPlan",
              from: effectiveZohoCaseId,
              to: planName ?? hit.id,
            });
          } else {
            planSyncNote =
              `Stored zohoCaseId ${effectiveZohoCaseId} not found in ${planModuleName()} module, and Policy_Ref="${effectivePolicyRef}" also returned no unique match.`;
          }
        } catch (searchErr) {
          planSyncNote =
            `Stored zohoCaseId ${effectiveZohoCaseId} not in ${planModuleName()} module; Plans search by Policy_Ref also failed: ${(searchErr as Error).message}`;
        }
      } else {
        planSyncNote =
          `Stored zohoCaseId ${effectiveZohoCaseId} not found in ${planModuleName()} module, and case has no Policy_Ref to search by.`;
      }
    } catch (err) {
      planSyncNote = `Plans record fetch failed: ${(err as Error).message}`;
    }
  } else if (!effectiveZohoCaseId && !effectivePolicyRef) {
    planSyncNote =
      "Task has no linked Plans record (What_Id) and no Policy_Ref to search by — Provider/Plan Type cannot be pulled from the Plans module.";
  }

  // Populate the plansRecord debug snapshot now that we know what we
  // fetched (or didn't). Values come from the record itself so the CA
  // can see EXACTLY what Zoho returned vs what's in the DB.
  if (planRecord) {
    syncDebug.plansRecord.fetched = true;
    syncDebug.plansRecord.planName = pickPlanName(planRecord);
    syncDebug.plansRecord.planTypeRaw =
      typeof planRecord.Plan_Type === "string" ? planRecord.Plan_Type.trim() : null;
    const providerRef = planRecord[planProviderField()];
    if (providerRef && typeof providerRef === "object") {
      const nm = (providerRef as Record<string, unknown>).name;
      if (typeof nm === "string" && nm.trim()) {
        syncDebug.plansRecord.providerName = nm.trim();
      }
    }
  }
  if (planSyncNote) syncDebug.plansRecord.note = planSyncNote;

  // 3f. Plan_Type + Provider Name from the Plans record (authoritative).
  //     Only fires when we have a linked record; falls back to the Task
  //     values already handled by the considerChange calls above.
  if (planRecord) {
    // Plan_Type on the Plans module is a picklist string ("Pension" / "ISA"
    // / "GIA" / …). inferPlanType handles casing + word variations and
    // returns the app's PlanType enum.
    const rawPlanTypeFromPlans =
      typeof planRecord.Plan_Type === "string" ? planRecord.Plan_Type.trim() : "";
    if (rawPlanTypeFromPlans) {
      const inferred = inferPlanType(rawPlanTypeFromPlans);
      // Track under the same "planType" field name so an earlier Task-based
      // update gets overwritten by the more authoritative Plans value.
      const currentPlanType = (updates.planType as PlanType | undefined) ?? caseRecord.planType;
      if (inferred !== currentPlanType) {
        updates.planType = inferred;
        // Remove any previously-pushed planType change so we don't emit
        // two entries in the response's changes[] for the same field.
        const existingIdx = changes.findIndex((c) => c.field === "planType");
        if (existingIdx >= 0) changes.splice(existingIdx, 1);
        changes.push({ field: "planType", from: caseRecord.planType, to: inferred });
      }
    }

    // Provider on Plans is a Lookup ({id, name, module}). Prefer its name
    // over the Task's Provider_group — again, that's the field the operator
    // actually edits on the Plans record.
    const providerRef = planRecord[planProviderField()];
    let plansProviderName: string | null = null;
    if (providerRef && typeof providerRef === "object") {
      const nm = (providerRef as Record<string, unknown>).name;
      if (typeof nm === "string" && nm.trim()) plansProviderName = nm.trim();
    }
    if (plansProviderName && plansProviderName.toLowerCase() !== (currentProviderName ?? "").trim().toLowerCase()) {
      // Overrides the Task-based decision from step 3a.
      const provider = await prisma.provider.findFirst({
        where: { name: { equals: plansProviderName, mode: "insensitive" } },
      });
      if (provider) {
        resolvedProviderId = provider.id;
      }
      // If no matching Provider row in our DB, resolvedProviderId stays as
      // it was after step 3a — again, don't orphan an active case.
    }
  }

  if (resolvedProviderId !== caseRecord.providerId) {
    updates.providerId = resolvedProviderId;
    // Prefer the Plans-record provider name in the change log if present,
    // otherwise fall back to the Task's name (mapping.providerName).
    const toName = planRecord
      ? (() => {
          const ref = planRecord[planProviderField()];
          if (ref && typeof ref === "object") {
            const nm = (ref as Record<string, unknown>).name;
            if (typeof nm === "string" && nm.trim()) return nm.trim();
          }
          return null;
        })()
      : null;
    changes.push({
      field: "provider",
      from: currentProviderName,
      to: toName ?? mapping.providerName ?? null,
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

  // Ship #1 (H18): filter Zoho-driven writes through the locked-field
  // guard BEFORE applying updates. Any block emits an audit row and
  // strips the field from `updates`; the corresponding entry is also
  // removed from `changes[]` so the response's `changes` accurately
  // reflects what actually happened, and the CASE_UPDATED audit at
  // the bottom of this handler doesn't double-log a blocked field.
  // The guard is UNCONDITIONAL — req.user.role is not consulted here
  // (an admin loading the case must not silently accept Zoho drift).
  const guardResult = await guardLockedFields({
    caseId: id,
    requested: updates,
    current: {
      planType: caseRecord.planType,
      providerId: caseRecord.providerId,
      policyRef: caseRecord.policyRef,
    },
    source: "ZOHO_SYNC",
    triggerUserId: req.user!.id,
  });
  for (const b of guardResult.blocked) {
    await emitBlockedAudit({
      caseId: id,
      caseRef: caseRecord.caseRef,
      blocked: b,
      source: "ZOHO_SYNC",
      triggerUserId: req.user!.id,
    });
    const idx = changes.findIndex((c) => c.field === b.field || (b.field === "providerId" && c.field === "provider"));
    if (idx >= 0) changes.splice(idx, 1);
  }
  // Rebuild `updates` from the guard's `safe` map — anything the
  // guard stripped is gone from here too.
  for (const lf of LOCKED_FIELDS) {
    if (lf in updates && !(lf in guardResult.safe)) {
      delete (updates as Record<string, unknown>)[lf];
    }
  }

  // H23: seed-if-empty heal.
  //
  // A case with zero checklist_fields rows can arrive here for several
  // reasons: (a) Zoho import landed with an unserviceable planType
  // (FINAL_SALARY / BOND — Messina shape), (b) an earlier silent-drop
  // somewhere in the pipeline, (c) a case that was created before
  // seeding existed. Any /sync-from-zoho invocation that finds a
  // zero-row case must heal it against the planType this sync is about
  // to leave the case with — otherwise subsequent AI_EXTRACTION_RUN
  // events report "N fields processed" against a checklist with no
  // rows, and the extracted values land in Cosmos with nowhere to
  // apply to (the merge/apply path silently no-ops on field-not-found).
  //
  // Wrapped in a $transaction with the case.update below so a partial
  // failure rolls back cleanly. The seed uses the FINAL planType
  // (post-guardLockedFields), so a sync that corrects planType from
  // FINAL_SALARY to PENSION seeds against PENSION templates directly.
  // Idempotent by row-count check for the common (non-concurrent) path:
  // an already-seeded case is a no-op.
  //
  // Concurrency. preExistingRowCount is read OUTSIDE the transaction
  // (Prisma's `count` runs its own statement). Under concurrent
  // /sync-from-zoho on the same case, both loaders can see rowCount=0
  // and both enter the transaction with templatesToSeed populated. The
  // @@unique([caseId, templateId]) constraint at checklist_fields
  // (schema.prisma:479) makes the second createMany a conflict; the
  // `skipDuplicates: true` option converts each conflicting row to a
  // per-row skip (Postgres ON CONFLICT DO NOTHING). The losing race
  // commits with zero net inserts and its case.update still applies —
  // no double-seed, no lost planType correction. Cost: the losing
  // race's SEEDING_HEAL_ON_SYNC audit records seededCount from
  // templatesToSeed.length rather than actual inserts (a small,
  // documented inaccuracy in exchange for avoiding an extra round-
  // trip). Alternative would be SELECT ... FOR UPDATE on the case
  // row inside the transaction; not worth the lock across every sync
  // for a race that fires only in a millisecond-scale window during
  // heal.
  //
  // Array order inside $transaction is execution order (case.update,
  // then createMany). Correctness does not depend on the order —
  // neither operation reads the other's result, and the seed uses
  // the pre-computed `effectivePlanType` rather than reading case.planType.
  //
  // Guard interaction. guardLockedFields ran at :~1652 (above), BEFORE
  // this transaction opens. Rows created inside the transaction cannot
  // be observed by the guard on the same sync. Seeded rows carry
  // aiExtractedAt=NULL, so caseHasExtractionRun (the guard predicate)
  // stays false against them on subsequent syncs too — the pre-
  // extraction window remains open, as intended. See the comment block
  // above caseHasExtractionRun (top of this file) for the rationale,
  // including why the predicate MUST NOT change to "any row exists".
  const effectivePlanType =
    (updates.planType as PlanType | undefined) ??
    (caseRecord.planType as PlanType);
  const preExistingRowCount = await prisma.checklistField.count({
    where: { caseId: id },
  });
  const shouldSeed = preExistingRowCount === 0;
  const templatesToSeed = shouldSeed
    ? await prisma.checklistTemplate.findMany({
        where: { planType: effectivePlanType, isActive: true },
      })
    : [];

  // We always have at least the cached Zoho IDs in `updates`, so always
  // apply. `changed` for the response reflects real CRM-data changes only
  // (the cache refresh is internal bookkeeping).
  const [updated] = await prisma.$transaction([
    prisma.case.update({
      where: { id },
      data: updates,
      include: { provider: true, assignedTo: true, createdBy: true },
    }),
    ...(templatesToSeed.length > 0
      ? [
          prisma.checklistField.createMany({
            data: templatesToSeed.map((t) => ({
              caseId: id,
              templateId: t.id,
            })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ]);

  // H23: observability for the heal path. Audits are written OUTSIDE
  // the transaction — they are not required for state consistency, and
  // an audit-write failure must not roll back a successful seed.
  if (shouldSeed && templatesToSeed.length > 0) {
    await prisma.auditLog.create({
      data: {
        caseId: id,
        userId: req.user!.id,
        action: "SEEDING_HEAL_ON_SYNC",
        source: "SYSTEM",
        newValue: `/sync-from-zoho: seeded ${templatesToSeed.length} checklist row(s) for planType "${effectivePlanType}" on a previously-unseeded case`,
        metadata: {
          planType: effectivePlanType,
          seededCount: templatesToSeed.length,
          zohoTaskId: caseRecord.zohoTaskId,
        } as Prisma.InputJsonValue,
      },
    });
    console.warn(
      JSON.stringify({
        evt: "SEEDING_HEAL_ON_SYNC",
        caseRef: caseRecord.caseRef,
        planType: effectivePlanType,
        seededCount: templatesToSeed.length,
      }),
    );
  } else if (shouldSeed && templatesToSeed.length === 0) {
    // Heal was attempted but the effective planType has no active
    // templates today (still FINAL_SALARY / BOND). Case stays zero-row;
    // next /sync-from-zoho will retry (this block is idempotent, and
    // ops now has a signal on both intake and every subsequent sync).
    await prisma.auditLog.create({
      data: {
        caseId: id,
        userId: req.user!.id,
        action: "SEEDING_ZERO_TEMPLATES",
        source: "SYSTEM",
        newValue: `/sync-from-zoho: attempted to heal a zero-row case but planType "${effectivePlanType}" has no active templates`,
        metadata: {
          planType: effectivePlanType,
          source: "ZOHO_SYNC_HEAL_ATTEMPT",
          zohoTaskId: caseRecord.zohoTaskId,
        } as Prisma.InputJsonValue,
      },
    });
    console.warn(
      JSON.stringify({
        evt: "SEEDING_ZERO_TEMPLATES",
        caseRef: caseRecord.caseRef,
        planType: effectivePlanType,
        source: "ZOHO_SYNC_HEAL_ATTEMPT",
      }),
    );
  }

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
    // Diagnostic snapshot — shows exactly which Zoho task fields carried
    // values, what the mapping extracted from them, whether a Plans
    // record was fetched, and whether the Provider Directory found a
    // match. Non-sensitive; the UI shows this on the Refresh action
    // when `changed=false` so ops can see WHY a refresh did nothing.
    syncDebug,
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
      // Capture the existing linkage so the audit row can record what we
      // overwrote — re-linking on Stage 3 deliberately replaces any prior
      // (often auto-linked, possibly wrong) Plans record.
      select: { id: true, zohoTaskId: true, zohoCaseId: true, zohoPlanName: true },
    });
    if (!caseRow) return res.status(404).json({ error: "Case not found" });

    const { planRecordId } = parsed.data;
    const previousPlanRecordId = caseRow.zohoCaseId;
    const previousPlanName = caseRow.zohoPlanName;
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
        oldValue: previousPlanRecordId
          ? `Plans record ${previousPlanName ?? previousPlanRecordId}`
          : null,
        newValue: `Linked Plans record ${planName ?? planRecordId}`,
        metadata: {
          linkedPlan: { id: planRecordId, name: planName },
          previousPlan: previousPlanRecordId
            ? { id: previousPlanRecordId, name: previousPlanName }
            : null,
          taskLinkNote,
        } as Prisma.InputJsonValue,
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
        provider: { select: { name: true } },
      },
    });
    if (!caseRow) return res.status(404).json({ error: "Case not found" });
    if (!caseRow.policyRef) {
      return res.status(400).json({ error: "Case has no Policy Ref — cannot create a Plans record without it." });
    }

    // Provider fallback (L3.1 fix) — the sync caches zohoProviderRecordId but
    // findProviderRecordByName returns null on any name mismatch, so it's
    // frequently empty. Resolve live here so a new Plan still carries Provider.
    let resolvedProviderRecordId = caseRow.zohoProviderRecordId;
    if (!resolvedProviderRecordId && caseRow.provider?.name) {
      try {
        const hit = await findProviderRecordByName(caseRow.provider.name);
        if (hit) {
          resolvedProviderRecordId = hit.id;
          await prisma.case.update({
            where: { id: req.params.id },
            data: { zohoProviderRecordId: hit.id },
          });
        }
      } catch {
        // Best-effort — create proceeds without Provider rather than failing.
      }
    }

    const fields: Record<string, unknown> = {
      Policy_Ref: caseRow.policyRef,
      Plan_Type: mapPlanTypeToZoho(caseRow.planType),
    };
    // Field API name configurable via ZOHO_PLAN_PROVIDER_FIELD (default "Provider").
    if (resolvedProviderRecordId) {
      fields[planProviderField()] = { id: resolvedProviderRecordId };
    }
    // Diagnostic logging (survives — this bug class recurs).
    console.log(
      "[plan-provider] create-plan case=%s policyRef=%s cachedProviderId=%s payloadSent=%s",
      req.params.id,
      caseRow.policyRef,
      resolvedProviderRecordId,
      JSON.stringify(fields[planProviderField()] ?? null),
    );
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

// ─────────────────────────────────────────────────────────
// Ship #1 (H18) — Admin locked-field endpoints
//
// The guard above blocks writes to planType / providerId /
// policyRef once extraction has run. These three endpoints are
// the ONLY paths that can (a) explicitly override a locked field,
// (b) dismiss a Zoho drift without changing the local value, or
// (c) reset a case's planType to a target that has templates
// (needed for FH-010 remediation). All three are ADMIN-only.
// ─────────────────────────────────────────────────────────

// ── Explicit admin override of a single locked field ────
//
// Body: { value: string, reason: string }
// Emits: LOCKED_FIELD_CHANGED (source: MANUAL, userId: admin)
router.patch(
  "/:id/locked-field/:field",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const field = req.params.field;
    if (!isLockedField(field)) {
      return res.status(400).json({
        error: `Not a locked field: ${field}. Locked fields are: ${LOCKED_FIELDS.join(", ")}`,
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const value = body.value;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return res.status(400).json({ error: "`reason` is required (min 1 char)" });
    }

    const current = await prisma.case.findUnique({
      where: { id: req.params.id },
      select: { planType: true, providerId: true, policyRef: true },
    });
    if (!current) return res.status(404).json({ error: "Case not found" });

    // Sanity-check the value against the field type.
    if (field === "planType") {
      const requestedPlanType = typeof value === "string" ? value : "";
      if (!(Object.values(PlanType) as string[]).includes(requestedPlanType)) {
        return res.status(400).json({
          error: `Invalid planType: ${requestedPlanType}. Valid: ${Object.values(PlanType).join(", ")}`,
        });
      }
      if (!(await planTypeHasTemplates(requestedPlanType as PlanType))) {
        return res.status(422).json({
          error: `Plan type "${requestedPlanType}" has no active checklist templates. Use POST /admin/cases/:id/reset-plan-type to change with orphan cleanup, or roll templates first.`,
          code: "PLAN_TYPE_NOT_IMPLEMENTED",
        });
      }
    }
    if ((field === "providerId" || field === "policyRef") && value !== null && typeof value !== "string") {
      return res.status(400).json({ error: `${field} must be a string or null` });
    }

    const previousValue = (current as Record<string, unknown>)[field];
    const previousValueNorm =
      previousValue === null || previousValue === undefined ? null : String(previousValue);
    const newValueNorm = value === null || value === undefined ? null : String(value);
    if (previousValueNorm === newValueNorm) {
      return res.status(400).json({ error: "New value equals current value; nothing to change." });
    }

    const updated = await prisma.case.update({
      where: { id: req.params.id },
      data: { [field]: value } as Prisma.CaseUpdateInput,
      include: { provider: true, assignedTo: true, createdBy: true },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.id,
        userId: req.user!.id,
        action: field === "planType" ? "PLAN_TYPE_CHANGED" : "LOCKED_FIELD_CHANGED",
        source: "MANUAL",
        newValue: `${field}: "${previousValueNorm ?? "<null>"}" → "${newValueNorm ?? "<null>"}"`,
        metadata: {
          field,
          from: previousValueNorm,
          to: newValueNorm,
          reason,
        } as Prisma.InputJsonValue,
      },
    });

    res.json(updated);
  },
);

// ── Admin acknowledgement / dismissal (no local value change) ──
//
// Body: { attemptedValue: string | null, reason: string }
// Emits: LOCKED_FIELD_CHANGE_DISMISSED (source: MANUAL, userId: admin)
// Effect: guardLockedFields silently skips future sync attempts
// whose attempted value matches (until Zoho's value changes again).
router.post(
  "/:id/locked-field/:field/dismiss",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const field = req.params.field;
    if (!isLockedField(field)) {
      return res.status(400).json({ error: `Not a locked field: ${field}` });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const attemptedValueRaw = body.attemptedValue;
    const attemptedValue =
      attemptedValueRaw === null || attemptedValueRaw === undefined
        ? null
        : String(attemptedValueRaw);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return res.status(400).json({ error: "`reason` is required" });
    }

    const caseExists = await prisma.case.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!caseExists) return res.status(404).json({ error: "Case not found" });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.id,
        userId: req.user!.id,
        action: "LOCKED_FIELD_CHANGE_DISMISSED",
        source: "MANUAL",
        newValue: `Dismissed ${field} sync attempt: "${attemptedValue ?? "<null>"}"`,
        metadata: {
          field,
          attemptedValue,
          reason,
        } as Prisma.InputJsonValue,
      },
    });

    res.json({ ok: true, dismissed: { field, attemptedValue, reason } });
  },
);

// ── Reset case planType with orphan-row cleanup ─────────
//
// Body: { target: PlanType, reason: string }
// Effect:
//   1. Validate target has active templates.
//   2. Delete checklist_fields whose template.planType != target.
//      (This is why we can't just use PATCH /locked-field for the
//      FH-098 / FH-010 shape — those cases have real orphan rows.)
//   3. Delete checklist_fund_lines whose planType != target.
//   4. Update case.planType = target.
//   5. Audit as PLAN_TYPE_CHANGED with orphansDeleted in metadata.
//
// This is the ONLY code path that touches locked planType AND
// mutates checklist_fields — deliberately separate from the plain
// locked-field endpoint to force the admin to acknowledge the
// data-deletion side-effect.
router.post(
  "/admin/cases/:id/reset-plan-type",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const target = typeof body.target === "string" ? body.target : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return res.status(400).json({ error: "`reason` is required" });
    }
    if (!(Object.values(PlanType) as string[]).includes(target)) {
      return res.status(400).json({
        error: `Invalid target planType: ${target}. Valid: ${Object.values(PlanType).join(", ")}`,
      });
    }
    const targetTyped = target as PlanType;
    if (!(await planTypeHasTemplates(targetTyped))) {
      return res.status(422).json({
        error: `Target plan type "${target}" has no active checklist templates. Roll templates before resetting a case to this type.`,
        code: "PLAN_TYPE_NOT_IMPLEMENTED",
      });
    }

    const current = await prisma.case.findUnique({
      where: { id: req.params.id },
      select: { id: true, planType: true },
    });
    if (!current) return res.status(404).json({ error: "Case not found" });

    // Discover orphan rows BEFORE deletion. We fetch the FULL row
    // content (not just counts) for two reasons:
    //   1. FH-098's 70 orphan PENSION rows hold 25 AI-extracted
    //      values (e.g. transfer_value £28,990.52) plus 17
    //      manually-edited/approved cells. Counts alone would make
    //      the delete irreversible from Postgres.
    //   2. When force=true (see below), we snapshot the whole set
    //      into audit_logs.metadata so the data survives in the
    //      audit trail forever — deleting it from checklist_fields
    //      is a lossy operation on the live table, not on history.
    const orphanFields = await prisma.checklistField.findMany({
      where: {
        caseId: req.params.id,
        template: { planType: { not: targetTyped } },
      },
      include: {
        template: {
          select: {
            fieldKey: true,
            fieldName: true,
            planType: true,
            sectionName: true,
            displayOrder: true,
          },
        },
        manualEditedBy: { select: { id: true, name: true, email: true } },
      },
    });
    const orphanFundLines = await prisma.checklistFundLine.findMany({
      where: { caseId: req.params.id, planType: { not: targetTyped } },
    });

    // Safety guard: refuse the delete when any orphan row carries
    // real content — a non-null value, a manual override, or an
    // adviser approval. The caller must pass { force: true } to
    // proceed; with force, we snapshot every row into audit_logs
    // BEFORE the tx that deletes them.
    //
    // Rationale: FH-098 must be un-deletable by accident. Ordinary
    // FH-010-shape resets (all orphan rows are empty AI_EXTRACTED
    // placeholders from POST /cases seeding) go through without a
    // force flag; anything with real work in it needs an explicit
    // acknowledgement.
    const protectedOrphanFields = orphanFields.filter(
      (f) => f.value !== null || f.isManuallyOverridden || f.isApproved,
    );
    const hasProtectedContent =
      protectedOrphanFields.length > 0 || orphanFundLines.length > 0;
    const force = body.force === true;

    if (hasProtectedContent && !force) {
      return res.status(409).json({
        error:
          "Refusing to delete orphan rows that carry values, manual edits, approvals, or fund lines. Pass { \"force\": true } to override — the full row content will be recorded in audit_logs.metadata before deletion so the data remains recoverable from history.",
        code: "PROTECTED_ORPHAN_ROWS",
        counts: {
          orphanFieldsTotal: orphanFields.length,
          orphanFieldsWithContent: protectedOrphanFields.length,
          orphanFundLines: orphanFundLines.length,
        },
        // Sample the protected content so the caller can decide
        // knowingly. Full snapshot is written on force=true.
        protectedFields: protectedOrphanFields.map((f) => ({
          id: f.id,
          fieldKey: f.template.fieldKey,
          fieldName: f.template.fieldName,
          templatePlanType: f.template.planType,
          value: f.value,
          aiRawValue: f.aiRawValue,
          confidence: f.confidence,
          status: f.status,
          isManuallyOverridden: f.isManuallyOverridden,
          manualEditedBy: f.manualEditedBy?.name ?? null,
          manualEditedAt: f.manualEditedAt,
          isApproved: f.isApproved,
          approvedAt: f.approvedAt,
          reviewComment: f.reviewComment,
          sourceDocumentName: f.sourceDocumentName,
          aiJobId: f.aiJobId,
          aiExtractedAt: f.aiExtractedAt,
        })),
        protectedFundLines: orphanFundLines.map((fl) => ({
          id: fl.id,
          fundName: fl.fundName,
          value: fl.value,
          status: fl.status,
          planType: fl.planType,
          sourceDocumentId: fl.sourceDocumentId,
        })),
      });
    }

    // Build the pre-delete snapshot (only written when force=true
    // AND there is content to preserve). Kept out of the tx so a
    // giant metadata blob is prepared once and passed by reference.
    const preDeleteSnapshot = hasProtectedContent
      ? {
          orphanFields: orphanFields.map((f) => ({
            id: f.id,
            templateId: f.templateId,
            fieldKey: f.template.fieldKey,
            fieldName: f.template.fieldName,
            templatePlanType: f.template.planType,
            sectionName: f.template.sectionName,
            displayOrder: f.template.displayOrder,
            value: f.value,
            aiRawValue: f.aiRawValue,
            confidence: f.confidence,
            status: f.status,
            sourceDocumentId: f.sourceDocumentId,
            sourceDocumentName: f.sourceDocumentName,
            sourcePageNumber: f.sourcePageNumber,
            sourceSection: f.sourceSection,
            sourceQuote: f.sourceQuote,
            isManuallyOverridden: f.isManuallyOverridden,
            manualEditedById: f.manualEditedById,
            manualEditedByName: f.manualEditedBy?.name ?? null,
            manualEditedByEmail: f.manualEditedBy?.email ?? null,
            manualEditedAt: f.manualEditedAt,
            isApproved: f.isApproved,
            approvedAt: f.approvedAt,
            reviewComment: f.reviewComment,
            reviewRequestedAt: f.reviewRequestedAt,
            hasConflict: f.hasConflict,
            conflictValues: f.conflictValues,
            fromTranscript: f.fromTranscript,
            transcriptId: f.transcriptId,
            aiJobId: f.aiJobId,
            aiExtractedAt: f.aiExtractedAt,
            createdAt: f.createdAt,
            updatedAt: f.updatedAt,
          })),
          orphanFundLines: orphanFundLines.map((fl) => ({
            id: fl.id,
            fundName: fl.fundName,
            isinSedolCiti: fl.isinSedolCiti,
            numberOfUnits: fl.numberOfUnits,
            pricePerUnit: fl.pricePerUnit,
            value: fl.value,
            isWithProfits: fl.isWithProfits,
            confidence: fl.confidence,
            status: fl.status,
            planType: fl.planType,
            sourceDocumentId: fl.sourceDocumentId,
            displayOrder: fl.displayOrder,
            createdAt: fl.createdAt,
            updatedAt: fl.updatedAt,
          })),
        }
      : null;

    const result = await prisma.$transaction(async (tx) => {
      // Snapshot BEFORE deletion so the audit row commits in the
      // same tx as the delete — either both land or neither does.
      if (preDeleteSnapshot) {
        // Distinct action from the PLAN_TYPE_CHANGED outcome row
        // written after the tx: recovery queries can search by
        // action='CHECKLIST_ROWS_SNAPSHOTTED' without inspecting
        // metadata.snapshot on every PLAN_TYPE_CHANGED row.
        await tx.auditLog.create({
          data: {
            caseId: req.params.id,
            userId: req.user!.id,
            action: "CHECKLIST_ROWS_SNAPSHOTTED",
            source: "MANUAL",
            newValue: `Pre-delete snapshot of ${preDeleteSnapshot.orphanFields.length} orphan field(s) + ${preDeleteSnapshot.orphanFundLines.length} orphan fund line(s) — force=true reset-plan-type ${current.planType} → ${targetTyped}`,
            metadata: {
              force: true,
              reason,
              from: current.planType,
              to: targetTyped,
              ...preDeleteSnapshot,
              trigger: "reset-plan-type-snapshot",
            } as Prisma.InputJsonValue,
          },
        });
      }
      const deletedFields = await tx.checklistField.deleteMany({
        where: {
          caseId: req.params.id,
          template: { planType: { not: targetTyped } },
        },
      });
      const deletedFundLines = await tx.checklistFundLine.deleteMany({
        where: {
          caseId: req.params.id,
          planType: { not: targetTyped },
        },
      });
      const updated = await tx.case.update({
        where: { id: req.params.id },
        data: { planType: targetTyped },
        include: { provider: true, assignedTo: true, createdBy: true },
      });
      return {
        deletedFieldCount: deletedFields.count,
        deletedFundLineCount: deletedFundLines.count,
        updated,
      };
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.id,
        userId: req.user!.id,
        action: "PLAN_TYPE_CHANGED",
        source: "MANUAL",
        newValue: `Reset planType: "${current.planType}" → "${targetTyped}" (deleted ${result.deletedFieldCount} orphan field row(s), ${result.deletedFundLineCount} orphan fund line(s))`,
        metadata: {
          from: current.planType,
          to: targetTyped,
          reason,
          force,
          orphansDeleted: {
            checklistFields: result.deletedFieldCount,
            checklistFundLines: result.deletedFundLineCount,
            protectedFieldsSnapshotted: protectedOrphanFields.length,
          },
          trigger: "reset-plan-type",
        } as Prisma.InputJsonValue,
      },
    });

    res.json({
      ok: true,
      case: result.updated,
      deleted: {
        checklistFields: result.deletedFieldCount,
        checklistFundLines: result.deletedFundLineCount,
      },
      snapshotted: preDeleteSnapshot !== null,
    });
  },
);

export { router as caseRoutes };
