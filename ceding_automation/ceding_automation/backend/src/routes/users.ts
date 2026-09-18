// backend/src/routes/users.ts
import { Router, Request, Response } from "express";
import { PrismaClient, UserRole, UserStatus, UserAuditAction } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import { z } from "zod";
import { diffUserFields } from "../utils/diffUserFields";
import { generateTemporaryPassword, hashPassword } from "../utils/password";

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
  // Phase 1 password login (2026-09-17): admin ticks a box in
  // UserManagementPanel to give the new account a password on creation.
  // Anchor Wealth users get true; Furnley House users stay false and
  // authenticate via SSO. Server generates the temp; admin does NOT
  // supply one, both to keep the entropy floor consistent and so no
  // password material comes over the wire before hashing.
  withPassword: z.boolean().optional(),
});

const UpdateUserSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    role: z.nativeEnum(UserRole).optional(),
    status: z.nativeEnum(UserStatus).optional(),
    canAccessAiTraining: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one of name / role / status / canAccessAiTraining must be provided",
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
      canAccessAiTraining: true,
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

    const { email, name, role, status, withPassword } = parsed.data;

    // Friendly-error for the most common admin mis-step: trying to create a
    // user who's already in the table.
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({
        error: `A user with email ${email} already exists.`,
        existingId: existing.id,
      });
    }

    // Phase 1: when withPassword=true, generate a 16-char temp, hash it,
    // set mustChangePassword. Response body carries the plaintext temp
    // ONCE — admin must copy it out-of-band to the user (Teams DM, phone).
    // Not logged, not persisted anywhere except as its argon2id hash on
    // the row we're about to create. Until the ceding mailbox lands in
    // phase 2 this is the only handoff channel.
    let tempPassword: string | null = null;
    let passwordHash: string | null = null;
    if (withPassword) {
      tempPassword = generateTemporaryPassword();
      passwordHash = await hashPassword(tempPassword);
    }

    try {
      const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            email,
            name,
            role,
            status: status ?? UserStatus.ACTIVE,
            ...(passwordHash
              ? {
                  passwordHash,
                  mustChangePassword: true,
                  passwordUpdatedAt: new Date(),
                }
              : {}),
          },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            status: true,
            canAccessAiTraining: true,
            ssoId: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        if (passwordHash) {
          await tx.userAuditLog.create({
            data: {
              actorUserId: req.user!.id,
              targetUserId: u.id,
              action: UserAuditAction.USER_PASSWORD_SET,
              field: "passwordHash",
              oldValue: null,
              newValue: "***",
              metadata: {
                targetUserEmail: u.email,
                actorEmail: req.user!.email,
                initialSet: true,
              },
            },
          });
        }
        return u;
      });
      // Return the temp password to the admin ONCE. Frontend must show it
      // in a "copy this now" modal — it will never be retrievable again.
      res.status(201).json({
        ...user,
        ...(tempPassword ? { temporaryPassword: tempPassword } : {}),
      });
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

    // Snapshot the audit-relevant fields BEFORE the update so we can diff
    // against the incoming values. A no-op PATCH (same values) writes no
    // audit rows — the audit trail represents state transitions, not
    // intent. See diffUserFields.test.ts for the full behaviour matrix.
    const before = await prisma.user.findUnique({
      where: { id: targetId },
      select: { role: true, status: true, canAccessAiTraining: true },
    });
    if (!before) {
      return res.status(404).json({ error: "User not found" });
    }
    const changes = diffUserFields(before, updates);

    try {
      // Update + write one UserAuditLog row per actually-changed field, in
      // a single transaction so a mid-flight crash cannot leave the
      // audit-vs-state pair inconsistent.
      const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: targetId },
          data: updates,
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            status: true,
            canAccessAiTraining: true,
            ssoId: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        if (changes.length > 0) {
          await tx.userAuditLog.createMany({
            data: changes.map((c) => ({
              actorUserId: req.user!.id,
              targetUserId: targetId,
              action: c.action as UserAuditAction,
              field: c.field,
              oldValue: c.oldValue,
              newValue: c.newValue,
              metadata: {
                targetUserEmail: u.email,
                actorEmail: req.user!.email,
              },
            })),
          });
        }
        return u;
      });
      res.json(user);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "P2025") return res.status(404).json({ error: "User not found" });
      res.status(500).json({ error: e.message ?? "Update failed" });
    }
  },
);

// POST /users/:id/set-password — admin resets a user's password.
// Phase 1 self-service reset is out of scope (no mailbox yet); this
// endpoint is the ONLY way a forgotten password becomes usable again.
// Server generates a 16-char temp; admin must convey it out-of-band.
//
// The action is idempotent-safe: calling it on a user who already has a
// passwordHash overwrites with a new temp and re-flags mustChangePassword,
// which is the correct behaviour for "user forgot their password, reset
// them so they can rotate again on next sign-in." It also clears
// failedLoginAttempts and lockedUntil so a locked-out user is immediately
// unblocked once they receive the new temp.
//
// Does NOT enforce ssoId-null — a user can have both an ssoId and a
// passwordHash (see the migration for the intent). Admin discretion
// governs whether an FH user needs a password; the runbook item is that
// they must set INACTIVE when the user departs regardless.
router.post(
  "/:id/set-password",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req: Request, res: Response) => {
    const targetId = req.params.id;

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, email: true, status: true },
    });
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.status === UserStatus.INACTIVE) {
      // Setting a password on a deactivated user does no harm functionally
      // (they still can't log in because the login endpoint refuses
      // INACTIVE), but it is a confusing admin action — either the admin
      // meant to reactivate first, or they are about to reactivate and
      // forgot the intended order. Refuse and prompt the correct sequence.
      return res.status(400).json({
        error: "Reactivate the user before setting a password. Deactivated users cannot log in regardless.",
      });
    }

    const tempPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(tempPassword);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: targetId },
        data: {
          passwordHash,
          mustChangePassword: true,
          passwordUpdatedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      await tx.userAuditLog.create({
        data: {
          actorUserId: req.user!.id,
          targetUserId: targetId,
          action: UserAuditAction.USER_PASSWORD_SET,
          field: "passwordHash",
          oldValue: null,
          newValue: "***",
          metadata: {
            targetUserEmail: target.email,
            actorEmail: req.user!.email,
            initialSet: false,
          },
        },
      });
    });

    // Same "show once" contract as the create path: response body is the
    // only chance the admin has to see the plaintext.
    res.json({ temporaryPassword: tempPassword, mustChangePassword: true });
  },
);

export { router as userRoutes };
