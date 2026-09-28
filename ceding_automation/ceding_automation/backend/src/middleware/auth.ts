// backend/src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        role: UserRole;
        canAccessAiTraining: boolean;
      };
    }
  }
}

// Per-user permission keys that can be checked by requirePermission.
// Keep as a union so a typo (e.g. requirePermission("canAccessAiTrain"))
// is a compile-time error.
export type UserPermission = "canAccessAiTraining";

// Kill-switch shape used by BOTH requireAuth (JWT verification path) and
// the /auth/login endpoint (password verification path). Phase 1 password
// login deliberately does NOT enforce SSO-or-password mutual exclusion —
// a user can hold both — so `status = 'INACTIVE'` is the single control
// that must block every login route. Extracted so the two callers cannot
// diverge; if a future change adds a third auth route (e.g. API key), it
// must call this too.
//
// Return shape is a discriminated union so the caller can narrow to the
// non-null user branch after the check without a redundant guard. The
// generic parameter preserves the caller's field selection.
export function checkUserActive<T extends { status: string }>(
  user: T | null | undefined,
):
  | { active: true; user: T }
  | { active: false; message: string } {
  if (!user) return { active: false, message: "Invalid or inactive user" };
  if (user.status === "INACTIVE") {
    return { active: false, message: "Invalid or inactive user" };
  }
  return { active: true, user };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      userId: string;
    };

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        canAccessAiTraining: true,
      },
    });

    const activeCheck = checkUserActive(user);
    if (!activeCheck.active) {
      return res.status(401).json({ error: activeCheck.message });
    }

    req.user = {
      id: activeCheck.user.id,
      email: activeCheck.user.email,
      name: activeCheck.user.name,
      role: activeCheck.user.role,
      canAccessAiTraining: activeCheck.user.canAccessAiTraining,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

// Per-user permission gate. Explicitly NOT a role check: the AI Training
// Hub grantees span CA_TEAM and ADMIN, so any endpoint backing that page
// must gate on the flag directly rather than a role list.
export function requirePermission(perm: UserPermission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.user[perm]) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
