// backend/src/routes/providers.ts
import { Router, Request, Response } from "express";
import { PrismaClient, LOAFormat } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";

const router = Router();
const prisma = new PrismaClient();

// Coerce empty strings to null so optional fields don't hit Prisma as "".
function clean<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v === "" ? null : v;
  }
  return out as T;
}

const ProviderCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  phoneMain: z.string().trim().optional().nullable(),
  phoneCedingDept: z.string().trim().optional().nullable(),
  emailMain: z.string().trim().optional().nullable(),
  emailCedingDept: z.string().trim().optional().nullable(),
  postalAddress: z.string().trim().optional().nullable(),
  loaFormat: z.nativeEnum(LOAFormat).optional(),
  isOnOrigo: z.boolean().optional(),
  acceptedSigType: z.string().trim().optional().nullable(),
  planTypePrefixes: z.array(z.string().trim().min(1)).optional(),
  notes: z.string().trim().optional().nullable(),
  isActive: z.boolean().optional(),
});

const ProviderUpdateSchema = ProviderCreateSchema.partial();

router.get("/", requireAuth, async (req: Request, res: Response) => {
  const includeInactive = req.query.includeInactive === "true";
  const providers = await prisma.provider.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { name: "asc" },
  });
  res.json(providers);
});

router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const provider = await prisma.provider.findUnique({ where: { id: req.params.id } });
  if (!provider) return res.status(404).json({ error: "Provider not found" });
  res.json(provider);
});

router.post(
  "/",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const parsed = ProviderCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const provider = await prisma.provider.create({ data: clean(parsed.data) });
      res.status(201).json(provider);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "P2002") {
        return res
          .status(409)
          .json({ error: `A provider with name "${parsed.data.name}" already exists.` });
      }
      res.status(500).json({ error: e.message ?? "Create failed" });
    }
  },
);

router.put(
  "/:id",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const parsed = ProviderUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const provider = await prisma.provider.update({
        where: { id: req.params.id },
        data: clean(parsed.data),
      });
      res.json(provider);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "P2025") return res.status(404).json({ error: "Provider not found" });
      if (e.code === "P2002")
        return res.status(409).json({ error: "Another provider already has that name." });
      res.status(500).json({ error: e.message ?? "Update failed" });
    }
  },
);

// Soft delete — flips isActive to false. Existing cases keep their providerId
// link, the directory list just hides the provider unless ?includeInactive.
router.delete(
  "/:id",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    try {
      await prisma.provider.update({
        where: { id: req.params.id },
        data: { isActive: false },
      });
      res.json({ message: "Provider deactivated" });
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "P2025") return res.status(404).json({ error: "Provider not found" });
      res.status(500).json({ error: "Deactivate failed" });
    }
  },
);

export { router as providerRoutes };
