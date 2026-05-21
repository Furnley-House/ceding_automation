// backend/src/routes/calls.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  initiateRingOut,
  getRingOutStatus,
  cancelRingOut,
  isRingCentralConfigured,
  getAccessToken,
  AGENT_PHONE,
  fetchCallTranscript,
  listCallRecordings,
  listCallRecordingsWithToken,
  transcribeRecordingWithToken,
  transcribeRecording,
  transcribeAudioBuffer,
} from "../services/ringcentral";
import { uploadToWorkDrive, listWorkDriveFiles, downloadWorkDriveFile } from "../services/workdrive";
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

// ── List recordings using a caller-supplied RC access token ──────────────────
// The token is obtained by the logged-in user from the RC widget's network
// requests (DevTools → Network → any platform.ringcentral.com call →
// Request Headers → Authorization: Bearer <TOKEN>).
// This bypasses server-side JWT config so any team member can use their own token.
router.get(
  "/:caseId/calls/rc-recordings-token",
  requireAuth,
  async (req: Request, res: Response) => {
    const { rcToken } = req.query as { rcToken?: string };
    if (!rcToken) return res.status(400).json({ error: "rcToken query param is required" });
    res.set('Cache-Control', 'no-store'); // prevent 304 caching — token + recordings change frequently
    try {
      const recordings = await listCallRecordingsWithToken(rcToken, { perPage: 30 });
      res.json({ recordings });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to fetch recordings";
      // Use 403 (not 401) so the frontend's global auth interceptor doesn't log the user out
      const httpStatus = (err as any)?.rcStatus === 403 || msg.includes("expired") || msg.includes("Unauthorized") ? 403 : 503;
      res.status(httpStatus).json({ error: msg });
    }
  }
);

// ── List MP3 recordings already saved in the WorkDrive folder ──────────────
router.get(
  "/:caseId/calls/workdrive-recordings",
  requireAuth,
  async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try {
      const files = await listWorkDriveFiles();
      res.json({ files });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to list WorkDrive files";
      console.error("[calls] workdrive list error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Stream a WorkDrive file's audio through the backend (for the play button) ──
router.get(
  "/:caseId/calls/workdrive-audio",
  requireAuth,
  async (req: Request, res: Response) => {
    const { fileId } = req.query as { fileId?: string };
    if (!fileId) return res.status(400).json({ error: "fileId required" });
    try {
      const { buffer, contentType } = await downloadWorkDriveFile(fileId);
      res.set("Content-Type", contentType);
      res.set("Content-Disposition", "inline; filename=recording.mp3");
      res.send(buffer);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to stream WorkDrive file";
      console.error("[calls] workdrive-audio error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Transcribe a WorkDrive recording via Azure Whisper ────────────────────
router.post(
  "/:caseId/calls/workdrive-transcribe",
  requireAuth,
  async (req: Request, res: Response) => {
    const { fileId, filename } = req.body as { fileId?: string; filename?: string };
    if (!fileId) return res.status(400).json({ error: "fileId required" });
    try {
      const { buffer } = await downloadWorkDriveFile(fileId);
      const result = await transcribeAudioBuffer(buffer, filename ?? "recording.mp3");
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transcription failed";
      console.error("[calls] workdrive-transcribe error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Upload an RC recording to Zoho WorkDrive ──────────────────────────────
router.post(
  "/:caseId/calls/upload-recording-to-workdrive",
  requireAuth,
  async (req: Request, res: Response) => {
    const { contentUri, fileName, folderId, rcToken: userToken } = req.body as {
      contentUri?: string;
      fileName?: string;
      folderId?: string;
      rcToken?: string;
    };
    if (!contentUri || !fileName) {
      return res.status(400).json({ error: "contentUri and fileName required" });
    }
    try {
      // 1. Download MP3 from RC using server JWT (or user token if not configured)
      let bearerToken: string;
      if (isRingCentralConfigured()) {
        bearerToken = await getAccessToken();
      } else if (userToken) {
        bearerToken = userToken;
      } else {
        return res.status(503).json({ error: "RC not configured" });
      }
      const audioResp = await axios.get(contentUri, {
        headers: { Authorization: `Bearer ${bearerToken}` },
        responseType: "arraybuffer",
      });
      const buffer = Buffer.from(audioResp.data as ArrayBuffer);

      // 2. Upload to Zoho WorkDrive
      const result = await uploadToWorkDrive(buffer, fileName, folderId, "audio/mpeg");

      // 3. Audit log
      await prisma.auditLog.create({
        data: {
          caseId: req.params.caseId,
          userId: req.user!.id,
          action: "WORKDRIVE_EXPORTED",
          newValue: `${result.name} (${result.id})`,
          metadata: { workdriveId: result.id, permalink: result.permalink, fileName },
          source: "USER",
        },
      });

      res.json({ success: true, file: result });
    } catch (err: unknown) {
      // Surface the actual Zoho/RC error body so the frontend toast shows something useful
      const responseData = (err as any)?.response?.data;
      const responseStatus = (err as any)?.response?.status;
      const responseUrl = (err as any)?.config?.url;
      const baseMsg = err instanceof Error ? err.message : "Upload failed";
      const detail = typeof responseData === "string" ? responseData : JSON.stringify(responseData);
      console.error("[calls] workdrive upload error:", { baseMsg, responseStatus, responseUrl, responseData });
      res.status(500).json({
        error: baseMsg,
        zohoStatus: responseStatus,
        zohoUrl: responseUrl,
        zohoError: detail,
      });
    }
  }
);

// ── Stream recording audio through backend (server JWT — browser never sees the token) ──
router.get(
  "/:caseId/calls/rc-recording-audio",
  requireAuth,
  async (req: Request, res: Response) => {
    const { contentUri, rcToken: userToken } = req.query as { contentUri?: string; rcToken?: string };
    if (!contentUri) return res.status(400).json({ error: "contentUri required" });
    try {
      // Prefer server JWT; fall back to user-supplied token
      let bearerToken: string;
      if (isRingCentralConfigured()) {
        bearerToken = await getAccessToken();
      } else if (userToken) {
        bearerToken = userToken;
      } else {
        return res.status(503).json({ error: "RC not configured and no token provided" });
      }
      const audioResp = await axios.get(decodeURIComponent(contentUri), {
        headers: { Authorization: `Bearer ${bearerToken}` },
        responseType: "stream",
      });
      res.set("Content-Type", (audioResp.headers as Record<string, string>)["content-type"] || "audio/mpeg");
      res.set("Content-Disposition", (audioResp.headers as Record<string, string>)["content-disposition"] || "inline; filename=recording.mp3");
      (audioResp.data as NodeJS.ReadableStream).pipe(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to stream recording";
      console.error("[calls] rc-recording-audio error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Transcribe using server-side JWT (no user token needed) ──────────────────────
router.post(
  "/:caseId/calls/rc-transcribe",
  requireAuth,
  async (req: Request, res: Response) => {
    const { contentUri } = req.body as { contentUri?: string };
    if (!contentUri) return res.status(400).json({ error: "contentUri required" });
    try {
      const result = await transcribeRecording(contentUri);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transcription failed";
      console.error("[calls] rc-transcribe error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Transcribe a recording using Azure Whisper + caller-supplied RC token ────────
// Frontend passes the recording's contentUri and the user's RC bearer token.
// Backend downloads the MP3 from RC's media server and sends it to Azure Whisper.
router.post(
  "/:caseId/calls/rc-transcribe-recording",
  requireAuth,
  async (req: Request, res: Response) => {
    const { contentUri, rcToken } = req.body as { contentUri?: string; rcToken?: string };
    if (!contentUri || !rcToken) {
      return res.status(400).json({ error: "contentUri and rcToken are required" });
    }
    try {
      const result = await transcribeRecordingWithToken(contentUri, rcToken);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transcription failed";
      console.error("[calls] rc-transcribe error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Debug: return raw RC call-log response to diagnose recording field structure ──
router.get(
  "/:caseId/calls/rc-debug",
  requireAuth,
  async (req: Request, res: Response) => {
    const { rcToken } = req.query as { rcToken?: string };
    if (!rcToken) return res.status(400).json({ error: "rcToken required" });
    res.set("Cache-Control", "no-store");
    const servers = ["https://platform.ringcentral.com", "https://platform.devtest.ringcentral.com"];
    const out: Record<string, unknown> = {};
    for (const server of servers) {
      try {
        const { data } = await (await import("axios")).default.get(
          `${server}/restapi/v1.0/account/~/extension/~/call-log`,
          { headers: { Authorization: `Bearer ${rcToken}` }, params: { type: "Voice", showRecording: true, perPage: 10 } }
        );
        const records = ((data as Record<string, unknown>)?.records ?? []) as Record<string, unknown>[];
        out[server] = {
          ok: true,
          totalCount: (data as Record<string, unknown>).totalCount,
          records: records.slice(0, 5).map((r) => ({
            id: r.id,
            direction: r.direction,
            startTime: r.startTime,
            recording: r.recording,
          })),
        };
      } catch (err: unknown) {
        out[server] = { ok: false, status: (err as any)?.response?.status, msg: (err as Error).message };
      }
    }
    res.json(out);
  }
);

// ── List recent RC call recordings (filterable by provider phone) ─────────────
router.get(
  "/:caseId/calls/rc-recordings",
  requireAuth,
  async (req: Request, res: Response) => {
    const { phoneNumber, dateFrom, perPage } = req.query as {
      phoneNumber?: string;
      dateFrom?: string;
      perPage?: string;
    };
    try {
      const recordings = await listCallRecordings({
        phoneNumber,
        dateFrom,
        perPage: perPage ? parseInt(perPage, 10) : 20,
      });
      res.json({ recordings });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to fetch recordings";
      console.error("[calls] rc-recordings error:", msg);
      res.status(503).json({ error: msg });
    }
  }
);

// ── Fetch RC call transcript by telephony session ID ─────────────────────────
// Called automatically by the frontend after rc-call-end-notify fires.
// Looks up the call recording via RC call-log, then submits to RC AI STT.
router.get(
  "/:caseId/calls/rc-transcript",
  requireAuth,
  async (req: Request, res: Response) => {
    const { telephonySessionId } = req.query as { telephonySessionId?: string };
    if (!telephonySessionId) {
      return res.status(400).json({ error: "telephonySessionId is required" });
    }
    try {
      const result = await fetchCallTranscript(telephonySessionId);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to fetch transcript";
      console.error("[calls] rc-transcript error:", msg);
      res.status(503).json({ error: msg });
    }
  }
);

export { router as callRoutes };
