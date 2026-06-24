// backend/src/routes/checklistTemplates.ts
//
// Admin CRUD for the checklist template definitions (one row per field per
// plan type). Templates drive the per-case checklists — when a new case is
// imported, the active templates for its plan type are cloned into
// `checklistField` rows. So changes here only affect FUTURE cases, not past
// ones.
import { Router, Request, Response } from "express";
import { PrismaClient, PlanType } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";

const router = Router();
const prisma = new PrismaClient();

const FIELD_TYPES = [
  "text",
  "number",
  "currency",
  "date",
  "dropdown",
  "yes_no",
  "percentage",
  "url",
  "free_text",
] as const;

const CreateSchema = z.object({
  planType: z.nativeEnum(PlanType),
  sectionName: z.string().trim().min(1, "Section is required"),
  fieldName: z.string().trim().min(1, "Field name is required"),
  fieldKey: z
    .string()
    .trim()
    .min(1, "Field key is required")
    .regex(/^[a-z][a-z0-9_]*$/, "Use snake_case (lowercase, underscores)"),
  fieldType: z.enum(FIELD_TYPES),
  dropdownOptions: z.array(z.string().trim().min(1)).optional(),
  isRequired: z.boolean().optional(),
  displayOrder: z.number().int().nonnegative().optional(),
  conditionalNote: z.string().trim().optional().nullable(),
});

const UpdateSchema = z
  .object({
    sectionName: z.string().trim().min(1).optional(),
    fieldName: z.string().trim().min(1).optional(),
    fieldKey: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*$/, "Use snake_case")
      .optional(),
    fieldType: z.enum(FIELD_TYPES).optional(),
    dropdownOptions: z.array(z.string().trim().min(1)).optional(),
    isRequired: z.boolean().optional(),
    displayOrder: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
    conditionalNote: z.string().trim().optional().nullable(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "Provide at least one field to update",
  });

const ReorderSchema = z
  .array(z.object({ id: z.string().min(1), displayOrder: z.number().int().nonnegative() }))
  .min(1, "At least one item is required");

// ── List ──────────────────────────────────────────────────────
// Filter by `?planType=ISA`, include inactive with `?includeInactive=true`.
// Open to any authenticated user since the checklist UI also reads templates,
// but writes are admin-only.
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const planTypeRaw = req.query.planType as string | undefined;
  const includeInactive = req.query.includeInactive === "true";

  const where: Record<string, unknown> = {};
  if (planTypeRaw) {
    if (!(Object.values(PlanType) as string[]).includes(planTypeRaw)) {
      return res.status(400).json({ error: `Unknown plan type: ${planTypeRaw}` });
    }
    where.planType = planTypeRaw;
  }
  if (!includeInactive) where.isActive = true;

  const templates = await prisma.checklistTemplate.findMany({
    where,
    orderBy: [{ planType: "asc" }, { displayOrder: "asc" }],
  });
  res.json(templates);
});

// ── Create ────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    // Default displayOrder = max-existing + 1 for the plan type, so new
    // fields land at the bottom of the list rather than colliding with 0.
    let { displayOrder } = parsed.data;
    if (displayOrder === undefined) {
      const max = await prisma.checklistTemplate.findFirst({
        where: { planType: parsed.data.planType },
        orderBy: { displayOrder: "desc" },
        select: { displayOrder: true },
      });
      displayOrder = (max?.displayOrder ?? 0) + 1;
    }

    try {
      const template = await prisma.checklistTemplate.create({
        data: { ...parsed.data, displayOrder },
      });
      res.status(201).json(template);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "P2002") {
        return res.status(409).json({
          error: `Field key "${parsed.data.fieldKey}" already exists for ${parsed.data.planType}.`,
        });
      }
      res.status(500).json({ error: e.message ?? "Create failed" });
    }
  },
);

// ── Update single template ───────────────────────────────────
// Note: changing fieldKey on a template does NOT rename existing per-case
// rows (those are linked by templateId, which is stable). Renaming fieldKey
// is mostly cosmetic for the API view layer.
router.patch(
  "/:id",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const template = await prisma.checklistTemplate.update({
        where: { id: req.params.id },
        data: parsed.data,
      });
      res.json(template);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "P2025") return res.status(404).json({ error: "Template not found" });
      if (e.code === "P2002")
        return res.status(409).json({ error: "That field key is already in use for this plan type." });
      res.status(500).json({ error: e.message ?? "Update failed" });
    }
  },
);

// ── Bulk reorder ─────────────────────────────────────────────
// Accepts a list of {id, displayOrder} objects and applies them atomically.
// The frontend uses this when the admin drags rows up/down.
router.post(
  "/reorder",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const parsed = ReorderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      await prisma.$transaction(
        parsed.data.map((item) =>
          prisma.checklistTemplate.update({
            where: { id: item.id },
            data: { displayOrder: item.displayOrder },
          }),
        ),
      );
      res.json({ updated: parsed.data.length });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "P2025") return res.status(404).json({ error: "One or more templates not found" });
      res.status(500).json({ error: e.message ?? "Reorder failed" });
    }
  },
);

// ── Soft delete (deactivate) ─────────────────────────────────
// We never hard-delete — existing cases reference these via checklistField.
// Deactivating just hides the field from the active checklist for new cases
// (and from the default GET filter).
router.delete(
  "/:id",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    try {
      await prisma.checklistTemplate.update({
        where: { id: req.params.id },
        data: { isActive: false },
      });
      res.json({ message: "Template deactivated" });
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "P2025") return res.status(404).json({ error: "Template not found" });
      res.status(500).json({ error: "Deactivate failed" });
    }
  },
);

export { router as checklistTemplateRoutes };
