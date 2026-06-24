// backend/src/routes/rcAuth.ts
// Per-user RC extension mapping using admin JWT — no OAuth dance.
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  listRcExtensions,
  autoConnectUserByEmail,
  connectUserByWidgetLogin,
  setUserRcExtension,
  disconnectRcUser,
  getRcConnectionStatus,
} from "../services/rcUserAuth";
import { isRingCentralConfigured } from "../services/ringcentral";

const router = Router();
const prisma = new PrismaClient();

// ── Status: is the logged-in user mapped to an RC extension? ────────────
router.get("/rc/status", requireAuth, async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  if (!isRingCentralConfigured()) {
    return res.json({ connected: false, configured: false });
  }
  try {
    const status = await getRcConnectionStatus(req.user!.id);
    res.json({ ...status, configured: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Connect: map the Ceding user to their RC extension ──────────────────
// Strategy:
//   1. If the frontend sent widgetLoginNumber (the user IS signed into the RC
//      widget as some extension), map to THAT extension. Proves ownership
//      because only someone with valid RC credentials can sign in there.
//   2. Otherwise fall back to email auto-match.
router.post("/rc/connect", requireAuth, async (req: Request, res: Response) => {
  if (!isRingCentralConfigured()) {
    return res.status(503).json({ error: "RC admin JWT not configured on server" });
  }
  const { widgetLoginNumber } = req.body as { widgetLoginNumber?: string };
  try {
    if (widgetLoginNumber) {
      const result = await connectUserByWidgetLogin(req.user!.id, widgetLoginNumber);
      if (result.matched) return res.json({ matched: true, extension: result.extension });
      return res.status(404).json({
        matched: false,
        error: result.error ?? `Could not match RC widget login ${widgetLoginNumber}`,
      });
    }

    // Fallback: email auto-match
    const me = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true },
    });
    if (!me?.email) return res.status(400).json({ error: "User has no email on file" });
    const result = await autoConnectUserByEmail(req.user!.id, me.email);
    if (result.matched) {
      return res.json({ matched: true, extension: result.extension });
    }
    res.status(404).json({
      matched: false,
      error: `No RC extension found with email ${me.email}. Sign into the RC widget first, then click Connect again.`,
    });
  } catch (err: unknown) {
    console.error("[rc-auth] connect error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Admin-only: list all extensions (e.g. for admin mapping UI) ─────────
// Returns the full directory of RC extensions — exposes emails of all users,
// so this must NEVER be reachable by regular CA team members.
router.get("/rc/extensions", requireAuth, requireRole(["ADMIN"]), async (_req: Request, res: Response) => {
  if (!isRingCentralConfigured()) {
    return res.status(503).json({ error: "RC admin JWT not configured on server" });
  }
  try {
    const extensions = await listRcExtensions();
    res.json({ extensions });
  } catch (err: unknown) {
    console.error("[rc-auth] list extensions error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Admin-only: manually map a specific Ceding user → RC extension ──────
// Body: { targetUserId, extensionId }. Used by admin UI when email auto-match fails.
router.post("/rc/pick-extension", requireAuth, requireRole(["ADMIN"]), async (req: Request, res: Response) => {
  const { extensionId, targetUserId } = req.body as { extensionId?: string; targetUserId?: string };
  if (!extensionId) return res.status(400).json({ error: "extensionId required" });
  try {
    const userId = targetUserId ?? req.user!.id;
    const ext = await setUserRcExtension(userId, extensionId);
    res.json({ matched: true, extension: ext });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Disconnect: clear the user's RC extension mapping ───────────────────
router.post("/rc/disconnect", requireAuth, async (req: Request, res: Response) => {
  try {
    await disconnectRcUser(req.user!.id);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as rcAuthRoutes };
