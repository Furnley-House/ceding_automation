// backend/src/routes/notifications.ts
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/", requireAuth, async (req: Request, res: Response) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(notifications);
});

router.patch("/:id/read", requireAuth, async (req: Request, res: Response) => {
  const n = await prisma.notification.update({
    where: { id: req.params.id },
    data: { isRead: true, readAt: new Date() },
  });
  res.json(n);
});

router.patch("/read-all", requireAuth, async (req: Request, res: Response) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  res.json({ message: "All marked read" });
});

export { router as notificationRoutes };
