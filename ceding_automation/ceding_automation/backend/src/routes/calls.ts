// backend/src/routes/calls.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import multer from "multer";
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
  findRecordingForSession,
  listCallRecordingsWithToken,
  transcribeRecordingWithToken,
  transcribeAudioBuffer,
} from "../services/ringcentral";
import {
  uploadToWorkDrive,
  listWorkDriveFiles,
  downloadWorkDriveFile,
  resolveCaseFolderId,
  WorkDriveFolderResolutionError,
} from "../services/workdrive";
import { getUserRcExtensionId } from "../services/rcUserAuth";
import { generateCallScript, analyseTranscript } from "../services/aiCallAssist";
import {
  ensureCaseCallFolders,
  submitCallForTranscription,
  getPalindromeJobStatus,
  isPalindromeConfigured,
  isPalindromeEnabled,
  PalindromeNotConfiguredError,
} from "../services/palindrome";

const router = Router();
const prisma = new PrismaClient();

// Call recordings arrive as multipart from the browser and are streamed
// straight to WorkDrive — same memory-storage pattern export.ts uses for the
// Stage 9 workbook. 250MB because provider calls run long and RingCentral
// exports are not aggressively compressed; a 15-minute call is ~6MB, so this
// leaves generous headroom without letting an arbitrary file through.
const AUDIO_MIME = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "video/mp4", // some recorders emit .mp4 containers for audio-only calls
];
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|mp4)$/i;

const recordingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Accept on EITHER mime or extension: browsers are inconsistent about
    // audio mime types, and a correct file with an odd mime shouldn't be
    // rejected. Flag rejections on the request so the route can answer 415
    // with a useful message rather than a generic "no file".
    const ok =
      AUDIO_MIME.includes(file.mimetype) || AUDIO_EXT_RE.test(file.originalname ?? "");
    if (ok) return cb(null, true);
    (req as Request & { audioRejected?: string }).audioRejected =
      `${file.mimetype} (${file.originalname})`;
    cb(null, false);
  },
});

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
    // Ship #1 (H18): scope the (caseId, fieldKey) lookup by the case's
    // current planType. See checklist.ts:636-649 and aiBffApply.ts:48-51
    // for the same fix in the BFF push/pull paths. Fetch case.planType
    // ONCE before the loop rather than per iteration.
    const transcriptCaseRow = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { planType: true },
    });
    if (!transcriptCaseRow) {
      return res.status(404).json({ error: "Case not found" });
    }
    let updated = 0;
    for (const f of acceptedFields ?? []) {
      const field = await prisma.checklistField.findFirst({
        where: {
          caseId: req.params.caseId,
          template: { fieldKey: f.fieldKey, planType: transcriptCaseRow.planType },
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

// ── List MP3 recordings already saved in the case's WorkDrive folder ──────
// Resolves the folder per-client from Contact.Client_Record_Folder_ID (same
// path the Stage 9 export uses), so each client's recordings stay in their
// own folder. Falls back to ZOHO_WORKDRIVE_FOLDER_ID env in lenient mode
// (staging / local); hard-fails 422 in strict mode (prod, where
// WORKDRIVE_REQUIRE_PER_CLIENT_FOLDER=true).
//
// Caching: Zoho WorkDrive's API has a tight per-org burst limit that returned
// 429 (Zoho code F7008) on real prod usage. We cache the file list per folder
// for 60s in memory. Pages can navigate away/back and panel can be reopened
// without re-hitting Zoho. The "Refresh" button bypasses the cache by sending
// ?fresh=1.
const WORKDRIVE_LIST_TTL_MS = 60_000;
interface WorkDriveListCacheEntry {
  files: unknown[];
  expiresAt: number;
}
const workdriveListCache = new Map<string, WorkDriveListCacheEntry>();

router.get(
  "/:caseId/calls/workdrive-recordings",
  requireAuth,
  async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try {
      const caseRecord = await prisma.case.findUnique({
        where: { id: req.params.caseId },
        select: { caseRef: true, clientZohoId: true },
      });
      if (!caseRecord) return res.status(404).json({ error: "Case not found" });

      // List the case's "Ceding Call Recordings" subfolder, not the client
      // folder root — that is where both the Transcribe and Save-to-WorkDrive
      // paths file audio. Reading the root here would show an empty panel
      // while recordings sat one level down.
      let folderId: string;
      try {
        const folders = await ensureCaseCallFolders(
          caseRecord.clientZohoId,
          caseRecord.caseRef,
        );
        folderId = folders.recordingsFolderId;
      } catch (err) {
        if (err instanceof WorkDriveFolderResolutionError) {
          return res.status(422).json({
            error: "WorkDrive folder not resolvable",
            code: err.code,
            contactZohoId: err.contactZohoId,
            message: err.message,
          });
        }
        throw err;
      }

      // Cache check (skipped when ?fresh=1 — the "Refresh" button)
      const bypassCache = String(req.query.fresh ?? "").toLowerCase() === "1";
      if (!bypassCache) {
        const hit = workdriveListCache.get(folderId);
        if (hit && hit.expiresAt > Date.now()) {
          return res.json({ files: hit.files, folderId, cached: true });
        }
      }

      const files = await listWorkDriveFiles(folderId);
      workdriveListCache.set(folderId, {
        files,
        expiresAt: Date.now() + WORKDRIVE_LIST_TTL_MS,
      });
      res.json({ files, folderId, cached: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to list WorkDrive files";
      const respStatus = (err as any)?.response?.status;
      const respData = (err as any)?.response?.data;
      // Surface Zoho's actual error body server-side for triage.
      console.error(
        "[calls] workdrive list error:",
        msg,
        respStatus !== undefined ? `zohoStatus=${respStatus}` : "",
        respData !== undefined ? `zohoBody=${typeof respData === "string" ? respData : JSON.stringify(respData)}` : "",
      );

      // 429 from Zoho (rate limit / F7008): pass it through as a 429 with
      // Retry-After so the UI can show "Zoho is throttling — try again in
      // a moment" instead of looking like a generic server crash. If we
      // have a stale-but-recent cache entry for the folder, also serve it
      // alongside the warning so the user sees what we last knew.
      if (respStatus === 429) {
        res.set("Retry-After", "60");
        return res.status(429).json({
          error: "Zoho WorkDrive rate limit hit — try again in ~1 minute",
          code: "ZOHO_RATE_LIMIT",
          zohoCode: (respData as any)?.errors?.[0]?.id ?? null,
        });
      }
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
      // 1. Download MP3 from RC using the admin JWT (works for any extension's recordings)
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

      // 2. Upload to Zoho WorkDrive — into the client's "Ceding Call
      //    Recordings" subfolder, the same place the Transcribe button files
      //    recordings. Without this the two buttons put the same audio in
      //    different places: this one used to fall through to the bare
      //    ZOHO_WORKDRIVE_FOLDER_ID root.
      //    An explicit folderId in the body still wins, so callers that know
      //    exactly where they want the file keep control.
      let targetFolderId = folderId;
      let storedName = fileName;
      const caseRecord = await prisma.case.findUnique({
        where: { id: req.params.caseId },
        select: { caseRef: true, clientZohoId: true },
      });

      if (caseRecord) {
        if (!targetFolderId) {
          const folders = await ensureCaseCallFolders(
            caseRecord.clientZohoId,
            caseRecord.caseRef,
          );
          targetFolderId = folders.recordingsFolderId;
        }

        // Prefix with the case ref. The recordings folder hangs off the
        // CLIENT record folder, so one folder can serve several cases — and
        // recordingWatcher.ts uses this prefix to decide which case a file
        // belongs to. Without it, a client with more than one open case gets
        // its recordings skipped as unattributable.
        if (!storedName.toLowerCase().startsWith(caseRecord.caseRef.toLowerCase())) {
          storedName = `${caseRecord.caseRef}_${storedName}`;
        }
      }

      const result = await uploadToWorkDrive(buffer, storedName, targetFolderId, "audio/mpeg");

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
      // Use admin JWT (covers any extension's recordings); fall back to user-supplied token
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

// ── Transcribe using the logged-in user's RC token ───────────────────────────
router.post(
  "/:caseId/calls/rc-transcribe",
  requireAuth,
  async (req: Request, res: Response) => {
    const { contentUri } = req.body as { contentUri?: string };
    if (!contentUri) return res.status(400).json({ error: "contentUri required" });
    if (!isRingCentralConfigured()) return res.status(503).json({ error: "RC not configured" });
    try {
      // Admin JWT downloads the audio; works for any extension's recordings
      const token = await getAccessToken();
      const result = await transcribeRecordingWithToken(contentUri, token);
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
    const { perPage } = req.query as { perPage?: string };
    res.set("Cache-Control", "no-store");
    try {
      // Per-user OAuth: use THIS user's RC token so they only see their own calls.
      // Step 1: get the logged-in user's mapped RC extension (throws 403 if not mapped yet)
      const extensionId = await getUserRcExtensionId(req.user!.id);
      // Step 2: use admin JWT to query THAT extension's call-log
      if (!isRingCentralConfigured()) {
        return res.status(503).json({ error: "RC admin JWT not configured" });
      }
      const token = await getAccessToken();
      const recordings = await listCallRecordingsWithToken(token, {
        perPage: perPage ? parseInt(perPage, 10) : 20,
        extensionOnly: true,
        extensionId,
      });
      res.json({ recordings });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to fetch recordings";
      const status = (err as any)?.rcStatus === 403 ? 403 : 503;
      console.error("[calls] rc-recordings error:", msg);
      res.status(status).json({ error: msg, needsRcConnect: status === 403 });
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

// ══════════════════════════════════════════════════════════════════════════
// PALINDROME TRANSCRIPTION
// ══════════════════════════════════════════════════════════════════════════
// Alternative to the Azure AI Speech path above (workdrive-transcribe /
// rc-transcribe), gated by TRANSCRIPT_VIA_PALINDROME so both engines can
// coexist and the switch is a single env change — same pattern as AI_VIA_BFF.
//
// Unlike Azure Speech this is asynchronous: submit returns a transcript row
// in a pending state, and the caller polls /palindrome-status until the
// Creator row reports a terminal Processing Status. See services/palindrome.ts
// for why (Palindrome is a queue worker, not a request/response API).

// ── Config probe (mirrors rc-status) ─────────────────────────────────────
router.get(
  "/:caseId/calls/palindrome-status",
  requireAuth,
  (_req: Request, res: Response) => {
    res.json({
      enabled: isPalindromeEnabled(),
      configured: isPalindromeConfigured(),
    });
  }
);

// Shared tail for every route that hands a recording to Palindrome:
// enqueue on Creator, park a pending Transcript row so the UI has something
// to poll and the job survives a restart, and audit it. The poller
// (services/palindromePoller.ts) takes over from here.
async function submitAndTrack(args: {
  caseId: string;
  userId: string;
  /** Signed-in user's email — labels their turns in the transcript. */
  adviserEmail?: string;
  recordingFileId: string;
  recordingFileName: string;
  recordingsFolderId: string;
  transcriptsFolderId: string;
}) {
  const submitted = await submitCallForTranscription({
    caseId: args.caseId,
    recordingFileId: args.recordingFileId,
    recordingFileName: args.recordingFileName,
    recordingsFolderId: args.recordingsFolderId,
    transcriptsFolderId: args.transcriptsFolderId,
    adviserEmail: args.adviserEmail,
  });

  const transcript = await prisma.transcript.create({
    data: {
      caseId: args.caseId,
      source: "PALINDROME",
      rawText: "",
      palindromeRecordId: submitted.creatorRecordId,
      palindromeStatus: "Ready For Processing",
      requestedAt: new Date(),
      workdriveRecordingFileId: args.recordingFileId || null,
      workdriveTranscriptsFolder: args.transcriptsFolderId,
    },
  });

  await prisma.auditLog.create({
    data: {
      caseId: args.caseId,
      userId: args.userId,
      action: "TRANSCRIPT_UPLOADED",
      source: "MANUAL",
      newValue: `Submitted ${args.recordingFileName} to Palindrome`,
      metadata: {
        transcriptId: transcript.id,
        creatorRecordId: submitted.creatorRecordId,
        recordingsFolderId: args.recordingsFolderId,
        transcriptsFolderId: args.transcriptsFolderId,
        sharedWith: submitted.sharedWith,
        shareExpiresOnUtc: submitted.shareExpiresOnUtc,
      },
    },
  });

  return { submitted, transcript };
}

// ── Upload a call recording from the browser ──────────────────────────────
// The whole Stage 5 flow in one call: the CA picks the MP3 on the case, and
//
//   1. the client's WorkDrive folder is resolved from the linked Zoho Contact
//   2. "Ceding Call Recordings" / "Ceding Call Transcripts" are created inside
//      it if they aren't there yet (ensureCaseCallFolders is find-or-create)
//   3. the audio is uploaded into the recordings folder
//   4. Palindrome is triggered automatically — no second click
//
// The transcript comes back into "Ceding Call Transcripts" and the poller
// stores it on the Transcript row, which the case screen reads through
// GET /calls/transcripts.
router.post(
  "/:caseId/calls/upload-recording",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  recordingUpload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      const rejected = (req as Request & { audioRejected?: string }).audioRejected;
      if (rejected) {
        return res.status(415).json({
          error: `Unsupported file type: ${rejected}. Upload an audio recording (mp3, wav, m4a, mp4).`,
        });
      }
      return res.status(400).json({ error: "No file uploaded" });
    }

    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { id: true, caseRef: true, clientZohoId: true },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    try {
      // Folders are created here if absent — both of them, every time.
      const folders = await ensureCaseCallFolders(
        caseRecord.clientZohoId,
        caseRecord.caseRef,
      );

      // Prefix with the case ref so a client folder holding calls from
      // several cases stays readable, and collisions can't silently
      // overwrite (override-name-exist is true on the WorkDrive upload).
      const safeName = req.file.originalname.replace(/[\\/:*?"<>|]/g, "_");
      const fileName = safeName.startsWith(caseRecord.caseRef)
        ? safeName
        : `${caseRecord.caseRef}_${safeName}`;

      const uploaded = await uploadToWorkDrive(
        req.file.buffer,
        fileName,
        folders.recordingsFolderId,
        req.file.mimetype || "audio/mpeg",
      );

      const { submitted, transcript } = await submitAndTrack({
        caseId: caseRecord.id,
        userId: req.user!.id,
        adviserEmail: req.user!.email,
        recordingFileId: uploaded.id,
        recordingFileName: uploaded.name,
        recordingsFolderId: folders.recordingsFolderId,
        transcriptsFolderId: folders.transcriptsFolderId,
      });

      res.status(202).json({
        transcriptId: transcript.id,
        creatorRecordId: submitted.creatorRecordId,
        status: "Ready For Processing",
        recordingFileId: uploaded.id,
        recordingFileName: uploaded.name,
        recordingPermalink: uploaded.permalink ?? null,
        folders,
      });
    } catch (err: unknown) {
      if (err instanceof PalindromeNotConfiguredError) {
        return res.status(503).json({ error: err.message });
      }
      if (err instanceof WorkDriveFolderResolutionError) {
        return res.status(422).json({
          error: "WorkDrive folder not resolvable",
          code: err.code,
          contactZohoId: err.contactZohoId,
          message: err.message,
        });
      }
      const msg = err instanceof Error ? err.message : "Upload failed";
      console.error("[calls] upload-recording error:", msg);
      res.status(500).json({ error: msg });
    }
  },
);

// ── Auto-submit after a RingCentral call ends ─────────────────────────────
// Called by the call workspace when rc-call-end-notify fires, so the CA never
// has to upload anything for a call placed through the app.
//
// The one wrinkle is timing: RingCentral finalises recordings asynchronously,
// so for the first several seconds after hang-up the call log has the call but
// no recording. Rather than block the request or spin server-side, we answer
// 202 { status: "pending" } and let the caller ask again. That keeps the state
// visible to the CA ("waiting for the recording…") instead of hiding it in a
// retry loop that dies with the process.
//
// Idempotent per session: if a transcript row already exists for this
// telephonySessionId we return it rather than submitting the call twice —
// polling would otherwise create a job on every attempt.
router.post(
  "/:caseId/calls/rc-auto-submit",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const { telephonySessionId } = req.body as { telephonySessionId?: string };
    if (!telephonySessionId) {
      return res.status(400).json({ error: "telephonySessionId is required" });
    }
    if (!isRingCentralConfigured()) {
      return res.status(503).json({ error: "RingCentral not configured" });
    }

    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { id: true, caseRef: true, clientZohoId: true },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    // Already submitted for this call?
    const existing = await prisma.transcript.findFirst({
      where: { caseId: caseRecord.id, ringCentralId: telephonySessionId },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      return res.json({
        status: "already-submitted",
        transcriptId: existing.id,
        palindromeStatus: existing.palindromeStatus,
        hasText: (existing.rawText ?? "").length > 0,
      });
    }

    try {
      const recording = await findRecordingForSession(telephonySessionId);
      if (!recording) {
        // Normal for the first ~10-60s after hang-up.
        return res.status(202).json({
          status: "pending",
          message: "RingCentral has not published the recording yet — retry shortly",
        });
      }

      const folders = await ensureCaseCallFolders(
        caseRecord.clientZohoId,
        caseRecord.caseRef,
      );

      // Pull the audio from RC with the admin JWT (works for any extension's
      // recordings) and push it into the client's recordings folder.
      const token = await getAccessToken();
      const audio = await axios.get(recording.contentUri, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: "arraybuffer",
      });

      const stamp = (recording.startTime ?? new Date().toISOString())
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const fileName = `${caseRecord.caseRef}_call_${stamp}.mp3`;

      const uploaded = await uploadToWorkDrive(
        Buffer.from(audio.data as ArrayBuffer),
        fileName,
        folders.recordingsFolderId,
        "audio/mpeg",
      );

      const { submitted, transcript } = await submitAndTrack({
        caseId: caseRecord.id,
        userId: req.user!.id,
        adviserEmail: req.user!.email,
        recordingFileId: uploaded.id,
        recordingFileName: uploaded.name,
        recordingsFolderId: folders.recordingsFolderId,
        transcriptsFolderId: folders.transcriptsFolderId,
      });

      // Bind the row to the call so a repeat poll is recognised as a
      // duplicate rather than submitting again.
      await prisma.transcript.update({
        where: { id: transcript.id },
        data: { ringCentralId: telephonySessionId },
      });

      res.status(202).json({
        status: "submitted",
        transcriptId: transcript.id,
        creatorRecordId: submitted.creatorRecordId,
        recordingFileId: uploaded.id,
        recordingFileName: uploaded.name,
        durationSeconds: recording.durationSeconds,
        folders,
      });
    } catch (err: unknown) {
      if (err instanceof PalindromeNotConfiguredError) {
        return res.status(503).json({ error: err.message });
      }
      if (err instanceof WorkDriveFolderResolutionError) {
        return res.status(422).json({
          error: "WorkDrive folder not resolvable",
          code: err.code,
          contactZohoId: err.contactZohoId,
          message: err.message,
        });
      }
      const msg = err instanceof Error ? err.message : "Auto-submit failed";
      console.error("[calls] rc-auto-submit error:", msg);
      res.status(500).json({ error: msg });
    }
  },
);

// ── Submit a recording already in WorkDrive or RingCentral ────────────────
// Two ways in:
//   { workdriveFileId, fileName }  → an MP3 already sitting in WorkDrive
//   { contentUri, fileName }       → pull it from RingCentral first
//
// Either way the file ends up in the case's own recordings subfolder, which
// is the only folder shared with Palindrome's service account.
router.post(
  "/:caseId/calls/palindrome-submit",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const { workdriveFileId, contentUri, fileName, rcToken: userToken } = req.body as {
      workdriveFileId?: string;
      contentUri?: string;
      fileName?: string;
      rcToken?: string;
    };

    if (!workdriveFileId && !contentUri) {
      return res
        .status(400)
        .json({ error: "Provide either workdriveFileId or contentUri" });
    }

    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { id: true, caseRef: true, clientZohoId: true },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    try {
      // 1. Per-case Recordings + Transcripts subfolders. Idempotent, so
      //    re-submitting for a case reuses the folders it already has.
      const folders = await ensureCaseCallFolders(
        caseRecord.clientZohoId,
        caseRecord.caseRef,
      );

      // 2. Make sure the audio is in the recordings subfolder.
      let recordingFileId = workdriveFileId ?? "";
      let recordingFileName =
        fileName ?? `${caseRecord.caseRef}_call_${Date.now()}.mp3`;

      if (!recordingFileId && contentUri) {
        // Pull the MP3 from RingCentral, then push it to WorkDrive. Admin JWT
        // works for any extension's recordings; fall back to a user token.
        let bearerToken: string;
        if (isRingCentralConfigured()) {
          bearerToken = await getAccessToken();
        } else if (userToken) {
          bearerToken = userToken;
        } else {
          return res.status(503).json({ error: "RingCentral not configured" });
        }
        const audioResp = await axios.get(contentUri, {
          headers: { Authorization: `Bearer ${bearerToken}` },
          responseType: "arraybuffer",
        });
        const uploaded = await uploadToWorkDrive(
          Buffer.from(audioResp.data as ArrayBuffer),
          recordingFileName,
          folders.recordingsFolderId,
          "audio/mpeg",
        );
        recordingFileId = uploaded.id;
        recordingFileName = uploaded.name;
      }

      // 3. Share → enqueue on the Creator form → poke Palindrome.
      const submitted = await submitCallForTranscription({
        caseId: caseRecord.id,
        recordingFileId,
        recordingFileName,
        recordingsFolderId: folders.recordingsFolderId,
        transcriptsFolderId: folders.transcriptsFolderId,
        adviserEmail: req.user!.email,
      });

      // 4. Park a pending transcript row so the UI has something to poll and
      //    the job survives a server restart.
      const transcript = await prisma.transcript.create({
        data: {
          caseId: caseRecord.id,
          source: "PALINDROME",
          rawText: "",
          palindromeRecordId: submitted.creatorRecordId,
          palindromeStatus: "Ready For Processing",
          requestedAt: new Date(),
          workdriveRecordingFileId: recordingFileId || null,
          workdriveTranscriptsFolder: folders.transcriptsFolderId,
        },
      });

      await prisma.auditLog.create({
        data: {
          caseId: caseRecord.id,
          userId: req.user!.id,
          action: "TRANSCRIPT_UPLOADED",
          source: "MANUAL",
          newValue: `Submitted ${recordingFileName} to Palindrome`,
          metadata: {
            transcriptId: transcript.id,
            creatorRecordId: submitted.creatorRecordId,
            recordingsFolderId: folders.recordingsFolderId,
            transcriptsFolderId: folders.transcriptsFolderId,
            sharedWith: submitted.sharedWith,
            shareExpiresOnUtc: submitted.shareExpiresOnUtc,
          },
        },
      });

      res.status(202).json({
        transcriptId: transcript.id,
        creatorRecordId: submitted.creatorRecordId,
        status: "Ready For Processing",
        recordingFileId,
        recordingFileName,
        folders,
        sharedWith: submitted.sharedWith,
        shareExpiresOnUtc: submitted.shareExpiresOnUtc,
        triggerResponse: submitted.triggerResponse,
      });
    } catch (err: unknown) {
      if (err instanceof PalindromeNotConfiguredError) {
        return res.status(503).json({ error: err.message });
      }
      if (err instanceof WorkDriveFolderResolutionError) {
        return res.status(422).json({
          error: "WorkDrive folder not resolvable",
          code: err.code,
          contactZohoId: err.contactZohoId,
          message: err.message,
        });
      }
      const msg = err instanceof Error ? err.message : "Palindrome submit failed";
      console.error("[calls] palindrome-submit error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Poll one submitted job ───────────────────────────────────────────────
// Re-reads the Creator row and mirrors what it says onto our transcript row.
// Terminal states settle completedAt so the UI can stop polling.
router.get(
  "/:caseId/calls/palindrome-job/:transcriptId",
  requireAuth,
  async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");

    const transcript = await prisma.transcript.findUnique({
      where: { id: req.params.transcriptId },
    });
    if (!transcript || transcript.caseId !== req.params.caseId) {
      return res.status(404).json({ error: "Transcript not found" });
    }
    if (!transcript.palindromeRecordId) {
      return res
        .status(409)
        .json({ error: "This transcript was not submitted to Palindrome" });
    }

    try {
      const status = await getPalindromeJobStatus(transcript.palindromeRecordId);

      // "Completed" is what the meeting pipeline's report shows on success.
      // Anything starting with "Error" is Palindrome's failure vocabulary.
      const raw = status.processingStatus ?? "";
      const isDone = /^completed$/i.test(raw.trim());
      const isFailed = /^error/i.test(raw.trim()) || Boolean(status.palindromeError);

      const updated = await prisma.transcript.update({
        where: { id: transcript.id },
        data: {
          palindromeStatus: status.processingStatus ?? transcript.palindromeStatus,
          palindromeCode: status.palindromeCode ?? transcript.palindromeCode,
          palindromeError:
            status.palindromeError ?? status.errorMessage ?? transcript.palindromeError,
          lastPolledAt: new Date(),
          ...(isDone || isFailed ? { completedAt: new Date() } : {}),
        },
      });

      res.json({
        transcriptId: updated.id,
        processingStatus: updated.palindromeStatus,
        palindromeCode: updated.palindromeCode,
        palindromeError: updated.palindromeError,
        done: isDone,
        failed: isFailed,
        hasText: (updated.rawText ?? "").length > 0,
        completedAt: updated.completedAt,
        // Echoed so the spike can see exactly which fields Creator returned
        // and under which spellings — drives the ingestion work that follows.
        creatorRow: status.raw,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Status check failed";
      console.error("[calls] palindrome-job error:", msg);
      res.status(502).json({ error: msg });
    }
  }
);

// ── List whatever Palindrome has written back ────────────────────────────
// Deliberately unfiltered by extension: the whole point of the first live run
// is to discover what format the artefact arrives in (.txt / .docx / .pdf),
// which decides which parser the ingestion step needs.
router.get(
  "/:caseId/calls/palindrome-output",
  requireAuth,
  async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");

    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { caseRef: true, clientZohoId: true },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    try {
      const folders = await ensureCaseCallFolders(
        caseRecord.clientZohoId,
        caseRecord.caseRef,
      );
      const files = await listWorkDriveFiles(folders.transcriptsFolderId, {
        extensions: [],
      });
      res.json({ folderId: folders.transcriptsFolderId, files });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to list output";
      console.error("[calls] palindrome-output error:", msg);
      res.status(500).json({ error: msg });
    }
  }
);

// ── Stored transcripts ────────────────────────────────────────────────────
// The Palindrome path stores its transcript on the Transcript row rather than
// handing it straight to the UI, so these endpoints let the case screen list
// what exists, read one, run extraction against it, and commit the results.
//
// Deliberately split analyse (read-only, returns candidates) from apply
// (writes to the checklist). Extraction is probabilistic and the CA must see
// what it proposes before any field changes — same stance as the AI document
// pipeline.

router.get(
  "/:caseId/calls/transcripts",
  requireAuth,
  async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const rows = await prisma.transcript.findMany({
      where: { caseId: req.params.caseId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        source: true,
        createdAt: true,
        requestedAt: true,
        completedAt: true,
        analysedAt: true,
        fieldsUpdated: true,
        palindromeStatus: true,
        palindromeError: true,
        workdriveTranscriptFileId: true,
        rawText: true,
      },
    });

    // rawText can be 20k+ chars; the list only needs to know whether it
    // landed and how big it is.
    res.json(
      rows.map(({ rawText, ...r }) => ({
        ...r,
        hasText: rawText.length > 0,
        chars: rawText.length,
      })),
    );
  },
);

router.get(
  "/:caseId/calls/transcripts/:transcriptId",
  requireAuth,
  async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const row = await prisma.transcript.findUnique({
      where: { id: req.params.transcriptId },
    });
    if (!row || row.caseId !== req.params.caseId) {
      return res.status(404).json({ error: "Transcript not found" });
    }
    res.json(row);
  },
);

// Build the extraction targets from the case's own checklist: the fields a
// call is actually meant to fill. Approved and manually-overridden rows are
// excluded — the CA rang the provider about the gaps, not the settled values.
async function buildTargetsForCase(caseId: string) {
  const fields = await prisma.checklistField.findMany({
    where: {
      caseId,
      isApproved: false,
      isManuallyOverridden: false,
      OR: [
        { confidence: { in: ["MISSING", "LOW"] } },
        { value: null },
        { value: "" },
      ],
    },
    include: { template: true },
    orderBy: { template: { displayOrder: "asc" } },
  });

  return fields.map((f) => ({
    key: f.template.fieldKey,
    label: f.template.fieldName,
    type: f.template.fieldType,
    hint: f.template.sectionName,
  }));
}

router.post(
  "/:caseId/calls/transcripts/:transcriptId/analyse",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const row = await prisma.transcript.findUnique({
      where: { id: req.params.transcriptId },
    });
    if (!row || row.caseId !== req.params.caseId) {
      return res.status(404).json({ error: "Transcript not found" });
    }
    if (!row.rawText || row.rawText.length < 20) {
      return res.status(409).json({
        error: "Transcript has no text yet",
        palindromeStatus: row.palindromeStatus,
      });
    }

    const caseRecord = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      include: { provider: { select: { name: true } } },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    try {
      const targets = await buildTargetsForCase(req.params.caseId);
      const result = await analyseTranscript({
        transcript: row.rawText,
        targets,
        clientName: caseRecord.clientName,
        providerName: caseRecord.provider?.name ?? "Provider",
        planNumber: caseRecord.policyRef ?? "",
      });

      res.json({
        transcriptId: row.id,
        targetsConsidered: targets.length,
        ...result,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Analysis failed";
      console.error("[calls] transcript analyse error:", msg);
      res.status(500).json({ error: msg });
    }
  },
);

router.post(
  "/:caseId/calls/transcripts/:transcriptId/apply",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const { acceptedFields, summary } = req.body as {
      acceptedFields?: Array<{
        fieldKey: string;
        value: string;
        confidence: "HIGH" | "MEDIUM" | "LOW";
        evidenceQuote?: string;
      }>;
      summary?: string;
    };

    const row = await prisma.transcript.findUnique({
      where: { id: req.params.transcriptId },
    });
    if (!row || row.caseId !== req.params.caseId) {
      return res.status(404).json({ error: "Transcript not found" });
    }

    // Scope the (caseId, fieldKey) lookup by the case's current planType —
    // same fix as checklist.ts and aiBffApply.ts. A case whose planType was
    // changed can carry orphaned rows keyed to the old type.
    const caseRow = await prisma.case.findUnique({
      where: { id: req.params.caseId },
      select: { planType: true },
    });
    if (!caseRow) return res.status(404).json({ error: "Case not found" });

    let updated = 0;
    for (const f of acceptedFields ?? []) {
      const field = await prisma.checklistField.findFirst({
        where: {
          caseId: req.params.caseId,
          template: { fieldKey: f.fieldKey, planType: caseRow.planType },
        },
      });
      if (!field) continue;
      // Never overwrite a human decision.
      if (field.isManuallyOverridden || field.isApproved) continue;

      await prisma.checklistField.update({
        where: { id: field.id },
        data: {
          value: f.value,
          confidence: f.confidence,
          status: "AI_EXTRACTED",
          fromTranscript: true,
          transcriptId: row.id,
          sourceSection: "Call transcript",
          sourceQuote: f.evidenceQuote?.slice(0, 500) ?? null,
        },
      });
      updated++;
    }

    await prisma.transcript.update({
      where: { id: row.id },
      data: { analysedAt: new Date(), fieldsUpdated: updated },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "TRANSCRIPT_ANALYSED",
        source: "AI",
        newValue: `${updated} field(s) updated from call transcript`,
        metadata: {
          transcriptId: row.id,
          transcriptSource: row.source,
          summary: summary ?? null,
          proposed: (acceptedFields ?? []).length,
          applied: updated,
        },
      },
    });

    res.json({ transcriptId: row.id, fieldsUpdated: updated });
  },
);

export { router as callRoutes };
