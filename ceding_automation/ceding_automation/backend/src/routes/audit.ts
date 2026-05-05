// backend/src/routes/audit.ts
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/cases/:caseId", requireAuth, async (req: Request, res: Response) => {
  const logs = await prisma.auditLog.findMany({
    where: { caseId: req.params.caseId },
    include: { user: { select: { name: true, role: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(logs);
});

export { router as auditRoutes };
