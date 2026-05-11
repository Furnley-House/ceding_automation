// backend/src/routes/audit.ts
//
// Read-only access to the immutable audit log. Two endpoints:
//   GET /audit/cases/:caseId  — per-case timeline (any authenticated user)
//   GET /audit                — global timeline across all cases (admin /
//                                paraplanner / adviser only). Supports
//                                ?action, ?source, ?caseId, ?userId, ?from,
//                                ?to, ?search, ?page, ?limit.
//
// Response shape is flattened + snake_case to match the frontend's expected
// shape (`AuditRow` in AuditTimeline.tsx). Joined `user` relation becomes
// `actor_name` + `actor_role`.

import { Router, Request, Response } from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

type AuditWithUserAndCase = Prisma.AuditLogGetPayload<{
  include: {
    user: { select: { name: true; role: true } };
    case: { select: { caseRef: true; clientName: true; providerId: true } };
  };
}>;

// Flatten + snake_case the audit row so the frontend can consume it without
// extra mapping. We also pull field label / notes / confidence out of
// metadata when present (extractions / approvals stash them there).
function serializeAuditLog(row: AuditWithUserAndCase) {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const fieldLabel =
    typeof meta.fieldLabel === "string" ? meta.fieldLabel : null;
  const notes = typeof meta.notes === "string" ? meta.notes : null;
  const confidence =
    typeof meta.confidence === "string" ? meta.confidence : null;
  return {
    id: row.id,
    case_id: row.caseId,
    case_ref: row.case?.caseRef ?? null,
    client_name: row.case?.clientName ?? null,
    user_id: row.userId,
    action: row.action,
    source: row.source,
    field_id: row.fieldId,
    field_key: row.fieldKey,
    field_label: fieldLabel,
    old_value: row.oldValue,
    new_value: row.newValue,
    confidence,
    notes,
    metadata: row.metadata,
    actor_name: row.user?.name ?? null,
    actor_role: row.user?.role ?? null,
    created_at: row.createdAt,
  };
}

// ── Per-case audit timeline ──────────────────────────────
router.get(
  "/cases/:caseId",
  requireAuth,
  async (req: Request, res: Response) => {
    const logs = await prisma.auditLog.findMany({
      where: { caseId: req.params.caseId },
      include: {
        user: { select: { name: true, role: true } },
        case: { select: { caseRef: true, clientName: true, providerId: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(logs.map(serializeAuditLog));
  },
);

// ── Global audit timeline (admin / paraplanner / adviser) ─
//
// Returns the latest 500 entries across all cases by default. Filterable by
// action / source / caseId / userId / search / date-range, paginated.
//
// CA team are intentionally excluded — they can read their own cases'
// timelines via the per-case endpoint, but global cross-case access is
// reserved for review + compliance roles.
router.get(
  "/",
  requireAuth,
  requireRole(["ADMIN", "PARAPLANNER", "ADVISER"]),
  async (req: Request, res: Response) => {
    const {
      action,
      source,
      caseId,
      userId,
      search,
      from,
      to,
      page = "1",
      limit = "100",
    } = req.query;

    const where: Prisma.AuditLogWhereInput = {};
    if (typeof action === "string" && action) where.action = action as never;
    if (typeof source === "string" && source) where.source = source;
    if (typeof caseId === "string" && caseId) where.caseId = caseId;
    if (typeof userId === "string" && userId) where.userId = userId;
    if (typeof from === "string" && from) {
      where.createdAt = { ...(where.createdAt ?? {}), gte: new Date(from) };
    }
    if (typeof to === "string" && to) {
      where.createdAt = { ...(where.createdAt ?? {}), lte: new Date(to) };
    }
    if (typeof search === "string" && search.trim()) {
      const q = search.trim();
      where.OR = [
        { fieldKey: { contains: q, mode: "insensitive" } },
        { oldValue: { contains: q, mode: "insensitive" } },
        { newValue: { contains: q, mode: "insensitive" } },
      ];
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const skip = (pageNum - 1) * lim;

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
        user: { select: { name: true, role: true } },
        case: { select: { caseRef: true, clientName: true, providerId: true } },
      },
        orderBy: { createdAt: "desc" },
        skip,
        take: lim,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      logs: rows.map(serializeAuditLog),
      total,
      page: pageNum,
      limit: lim,
    });
  },
);

// ── Log an export action ─────────────────────────────────
//
// Frontend uses this to record CHECKLIST_EXPORTED (after .xlsx download) and
// WORKDRIVE_EXPORTED (after WorkDrive upload). The export itself can be
// driven client-side, but the audit row has to come from the server so it
// can't be tampered with and so the actor's identity is the JWT subject,
// not a client-supplied value.

const LogExportSchema = z.object({
  action: z.enum(["CHECKLIST_EXPORTED", "WORKDRIVE_EXPORTED"]),
  fileName: z.string().trim().min(1).optional(),
  destination: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

router.post(
  "/cases/:caseId/log-export",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = LogExportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { action, fileName, destination, notes } = parsed.data;

    // Ensure the case exists — better to 404 here than write an orphan row.
    const exists = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { id: true },
    });
    if (!exists) return res.status(404).json({ error: "Case not found" });

    const log = await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action,
        source: "MANUAL",
        newValue: fileName ?? null,
        metadata: {
          ...(fileName ? { fileName } : {}),
          ...(destination ? { destination } : {}),
          ...(notes ? { notes } : {}),
        },
      },
      include: {
        user: { select: { name: true, role: true } },
        case: { select: { caseRef: true, clientName: true, providerId: true } },
      },
    });

    res.status(201).json(serializeAuditLog(log));
  },
);

export { router as auditRoutes };
