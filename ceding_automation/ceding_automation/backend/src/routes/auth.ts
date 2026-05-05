// backend/src/routes/auth.ts
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const router = Router();
const prisma = new PrismaClient();

// Demo login (no password – role-selector for prototype, SSO in prod)
router.post("/login", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true, status: true },
  });

  if (!user || user.status === "INACTIVE") {
    return res.status(401).json({ error: "User not found or inactive" });
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, {
    expiresIn: process.env.JWT_EXPIRES_IN || "8h",
  });

  res.json({ token, user });
});

router.get("/me", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, name: true, role: true },
    });
    res.json(user);
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

export { router as authRoutes };
