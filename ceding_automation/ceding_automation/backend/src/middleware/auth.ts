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

    if (!user || user.status === "INACTIVE") {
      return res.status(401).json({ error: "Invalid or inactive user" });
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      canAccessAiTraining: user.canAccessAiTraining,
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
