// backend/src/routes/calls.ts
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  initiateRingOut,
  getRingOutStatus,
  cancelRingOut,
  isRingCentralConfigured,
  AGENT_PHONE,
} from "../services/ringcentral";
import { generateCallScript, analyseTranscript } from "../services/aiCallAssist";

const router = Router();
const prisma = new PrismaClient();

// ── RingCentral config probe ──────────────────────────────────────────────
router.get("/:caseId/calls/rc-status", requireAuth, (_req: Request, res: Response) => {
  res.json({
    configured: isRingCentralConfigured(),
    agentPhone: AGENT_PHONE ? `***${AGENT_PHONE.slice(-4)}` : null,
  });
});

// ── Initiate outbound ring-out ────────────────────────────────────────────
router.post(
  "/:caseId/calls/ring-out",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const { toPhone } = req.body as { toPhone?: string };
    if (!toPhone) return res.status(400).json({ error: "toPhone is required" });

    try {
      const session = await initiateRingOut(toPhone);
      res.json(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to initiate call";
      console.error("[calls] ring-out error:", msg);
      res.status(503).json({ error: msg });
    }
  }
);

// ── Poll ring-out status ──────────────────────────────────────────────────
router.get(
  "/:caseId/calls/ring-out/:sessionId/status",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const status = await getRingOutStatus(req.params.sessionId);
      res.json(status);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to get status";
      res.status(503).json({ error: msg });
    }
  }
);

// ── Hang up / cancel ring-out ─────────────────────────────────────────────
router.delete(
  "/:caseId/calls/ring-out/:sessionId",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      await cancelRingOut(req.params.sessionId);
      res.json({ message: "Call ended" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to end call";
      res.status(503).json({ error: msg });
    }
  }
);

// ── Generate AI call script ───────────────────────────────────────────────
router.post(
  "/:caseId/calls/script",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const { missingFields, reviewFields, clientName, providerName, planNumber, planType } =
      req.body;

    try {
      const script = await generateCallScript({
        missingFields: missingFields ?? [],
        reviewFields: reviewFields ?? [],
        clientName: clientName ?? "Client",
        providerName: providerName ?? "Provider",
        planNumber: planNumber ?? "",
        planType: planType ?? "PENSION",
      });

      // Persist to call_scripts table
      const fieldIds = await prisma.checklistField.findMany({
        where: { caseId: req.params.caseId, confidence: { in: ["MISSING", "LOW"] } },
        select: { id: true },
      });

      await prisma.callScript.create({
        data: {
          caseId: req.params.caseId,
          scriptContent: script as object,
          missingFieldIds: fieldIds.map((f) => f.id),
          providerPhone: (req.body.providerPhone as string | undefined) ?? null,
          providerDept: "Ceding / Transfers",
        },
      });

      await prisma.auditLog.create({
        data: {
          caseId: req.params.caseId,
          userId: req.user!.id,
          action: "CALL_SCRIPT_GENERATED",
          newValue: `${(missingFields ?? []).length + (reviewFields ?? []).length} questions`,
          source: "AI",
        },
      });

      res.json({ script });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to generate script";
      console.error("[calls] script error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Analyse transcript (AI) ───────────────────────────────────────────────
router.post(
  "/:caseId/calls/analyse",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const { transcript, targets, clientName, providerName, planNumber } = req.body;
    if (!transcript) return res.status(400).json({ error: "transcript is required" });

    try {
      const result = await analyseTranscript({
        transcript,
        targets: targets ?? [],
        clientName: clientName ?? "Client",
        providerName: providerName ?? "Provider",
        planNumber: planNumber ?? "",
      });
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to analyse transcript";
      console.error("[calls] analyse error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Save call log + merge accepted fields into checklist ──────────────────
router.post(
  "/:caseId/calls/log",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const {
      transcript,
      ringCentralId,
      durationSeconds,
      summary,
      acceptedFields, // Array<{ fieldKey, value, confidence, evidenceQuote }>
    } = req.body as {
      transcript?: string;
      ringCentralId?: string;
      durationSeconds?: number;
      summary?: string;
      acceptedFields?: Array<{
        fieldKey: string;
        value: string;
        confidence: "HIGH" | "MEDIUM" | "LOW";
        evidenceQuote?: string;
      }>;
    };

    // 1. Persist transcript
    const saved = await prisma.transcript.create({
      data: {
        caseId: req.params.caseId,
        source: ringCentralId ? "PALINDROME" : "MANUAL_PASTE",
        rawText: transcript ?? "",
        ringCentralId: ringCentralId ?? null,
        analysedAt: new Date(),
        fieldsUpdated: (acceptedFields ?? []).length,
      },
    });

    // 2. Update checklist fields (never overwrite manually-edited or approved)
    let updated = 0;
    for (const f of acceptedFields ?? []) {
      const field = await prisma.checklistField.findFirst({
        where: {
          caseId: req.params.caseId,
          template: { fieldKey: f.fieldKey },
        },
      });
      if (!field) continue;
      if (field.isManuallyOverridden || field.isApproved) continue;

      await prisma.checklistField.update({
        where: { id: field.id },
        data: {
          value: f.value,
          confidence: f.confidence,
          status: "AI_EXTRACTED",
          fromTranscript: true,
          transcriptId: saved.id,
          sourceSection: "Call transcript",
          sourceQuote: f.evidenceQuote?.slice(0, 500) ?? null,
        },
      });
      updated++;
    }

    // 3. Audit log
    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "TRANSCRIPT_ANALYSED",
        newValue: `${updated} fields updated from call`,
        metadata: { transcriptId: saved.id, ringCentralId, durationSeconds, summary },
        source: "AI",
      },
    });

    res.json({ transcriptId: saved.id, fieldsUpdated: updated });
  }
);

export { router as callRoutes };
