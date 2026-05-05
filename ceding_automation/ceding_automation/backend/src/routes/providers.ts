// backend/src/routes/providers.ts
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/", requireAuth, async (_req: Request, res: Response) => {
  const providers = await prisma.provider.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
  res.json(providers);
});

router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  const provider = await prisma.provider.findUnique({ where: { id: req.params.id } });
  if (!provider) return res.status(404).json({ error: "Provider not found" });
  res.json(provider);
});

router.post("/", requireAuth, requireRole(["ADMIN"]), async (req: Request, res: Response) => {
  const provider = await prisma.provider.create({ data: req.body });
  res.status(201).json(provider);
});

router.put("/:id", requireAuth, requireRole(["ADMIN"]), async (req: Request, res: Response) => {
  const provider = await prisma.provider.update({
    where: { id: req.params.id },
    data: req.body,
  });
  res.json(provider);
});

router.delete("/:id", requireAuth, requireRole(["ADMIN"]), async (req: Request, res: Response) => {
  await prisma.provider.update({
    where: { id: req.params.id },
    data: { isActive: false },
  });
  res.json({ message: "Provider deactivated" });
});

export { router as providerRoutes };
