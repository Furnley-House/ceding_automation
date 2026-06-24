// backend/src/routes/users.ts
import { Router, Request, Response } from "express";
import { PrismaClient, UserRole, UserStatus } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";

const router = Router();
const prisma = new PrismaClient();

// What admins are allowed to send. We deliberately do NOT accept `id`,
// `email`, `ssoId`, `createdAt`, `updatedAt` on update — those are either
// system-managed (timestamps, ssoId) or the immutable identity for SSO
// dedupe (email).
const CreateUserSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().toLowerCase().email("Valid email required"),
  role: z.nativeEnum(UserRole),
  status: z.nativeEnum(UserStatus).optional(),
});

const UpdateUserSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    role: z.nativeEnum(UserRole).optional(),
    status: z.nativeEnum(UserStatus).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one of name / role / status must be provided",
  });

router.get("/", requireAuth, requireRole(["ADMIN"]), async (_req, res: Response) => {
  const users = await prisma.user.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      ssoId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  res.json(users);
});

router.post(
  "/",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const parsed = CreateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { email, name, role, status } = parsed.data;

    // Friendly-error for the most common admin mis-step: trying to create a
    // user who's already in the table.
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({
        error: `A user with email ${email} already exists.`,
        existingId: existing.id,
      });
    }

    try {
      const user = await prisma.user.create({
        data: { email, name, role, status: status ?? UserStatus.ACTIVE },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          ssoId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      res.status(201).json(user);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "P2002") {
        return res.status(409).json({ error: `A user with email ${email} already exists.` });
      }
      res.status(500).json({ error: e.message ?? "Create failed" });
    }
  },
);

router.patch(
  "/:id",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const parsed = UpdateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const targetId = req.params.id;
    const updates = parsed.data;

    // Self-protection: an admin can't lock themselves out of admin or disable
    // their own account. The frontend also blocks this, but we re-check
    // here since the backend is the only thing the audit trail trusts.
    if (req.user!.id === targetId) {
      if (updates.role && updates.role !== UserRole.ADMIN) {
        return res.status(400).json({
          error: "You can't demote your own admin account. Ask another admin to do this.",
        });
      }
      if (updates.status === UserStatus.INACTIVE) {
        return res.status(400).json({
          error: "You can't deactivate your own account.",
        });
      }
    }

    try {
      const user = await prisma.user.update({
        where: { id: targetId },
        data: updates,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          ssoId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      res.json(user);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "P2025") return res.status(404).json({ error: "User not found" });
      res.status(500).json({ error: e.message ?? "Update failed" });
    }
  },
);

export { router as userRoutes };
