// backend/src/routes/users.ts
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/", requireAuth, requireRole(["ADMIN"]), async (_req, res: Response) => {
  const users = await prisma.user.findMany({ orderBy: { name: "asc" } });
  res.json(users);
});

router.post("/", requireAuth, requireRole(["ADMIN"]), async (req: Request, res: Response) => {
  const user = await prisma.user.create({ data: req.body });
  res.status(201).json(user);
});

router.patch("/:id", requireAuth, requireRole(["ADMIN"]), async (req: Request, res: Response) => {
  const user = await prisma.user.update({ where: { id: req.params.id }, data: req.body });
  res.json(user);
});

export { router as userRoutes };
