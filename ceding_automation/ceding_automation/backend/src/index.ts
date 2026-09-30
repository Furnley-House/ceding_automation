// backend/src/index.ts
import "dotenv/config";
// Patches Express 4's Layer.prototype.handle_request to await async
// handlers and forward rejections to the app.use((err, ...)) error
// handler at the bottom of this file. MUST be imported before any
// route module that declares an async handler — placing it here, on
// line three, guarantees that order regardless of hoisting.
//
// Why not per-route try/catch: 23 of the 28 routes in calls.ts already
// wrap; five don't (routes L219, L755, L1298, L1334, L1425 as of
// 2026-09-28). A CA hitting a Prisma error on one of those five would
// otherwise crash the container. One import fixes all of them and
// every future async handler in the app.
import "express-async-errors";
import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { buildRateLimitKey } from "./utils/rateLimitKey";
import { caseRoutes } from "./routes/cases";
import { documentRoutes, documentInternalRoutes } from "./routes/documents";
import { checklistRoutes } from "./routes/checklist";
import { fundLineRoutes } from "./routes/fundLines";
import { contributionRoutes } from "./routes/contributions";
import { providerRoutes } from "./routes/providers";
import { checklistTemplateRoutes } from "./routes/checklistTemplates";
import { userRoutes } from "./routes/users";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { notificationRoutes } from "./routes/notifications";
import { crmRoutes } from "./routes/crm";
import { callRoutes } from "./routes/calls";
import { rcAuthRoutes } from "./routes/rcAuth";
import { exportRoutes } from "./routes/export";
import { publicRecordingRoutes } from "./routes/publicRecordings";
import { startPoller } from "./services/aiBffPoller";
import { startPalindromePoller } from "./services/palindromePoller";
import { startRecordingWatcher } from "./services/recordingWatcher";

const app = express();

// Trust the Container Apps ingress proxy (one hop) so req.ip reflects
// the real client IP, not the proxy IP. Needed for express-rate-limit
// to work per-client rather than per-proxy.
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3001;

// ── Security middleware ──────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);

// ── Rate limiting ────────────────────────────────────────
// Default raised from 200 → 500 with the switch to per-user keying: one
// heavy triage session opens ~15 cases in 15 min at ~8 calls each ≈ 120
// requests, and header/list refreshes stack on top. 500 gives ~3-4×
// headroom over that observed pattern while still catching runaway
// client loops. Env var `RATE_LIMIT_MAX_REQUESTS` overrides if set —
// staging/prod may need re-checking after this deploys.
//
// Keying: authenticated user id (via buildRateLimitKey → jwt.verify),
// falls back to req.ip for unauthenticated traffic. Fixes item 3 —
// office NAT put every user in one 200-request bucket.
//
// SEE ALSO KI-15: unauthenticated /auth/* still shares the per-IP
// bucket. A stricter, second limiter for auth routes is deferred.
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 500,
  keyGenerator: (req) =>
    buildRateLimitKey({
      authHeader: req.headers.authorization,
      ip: req.ip,
      jwtSecret: process.env.JWT_SECRET!,
    }),
  // BFF write-back is server-to-server (X-Internal-Key auth) and bursts
  // 66 requests per doc per submission (65 field PATCHes + 1 doc-level).
  // Multi-doc cases (3-4 docs) blew the shared human-IP budget and 429'd.
  // Internal routes are already guarded by requireInternalKey middleware.
  skip: (req) =>
    !!req.headers["x-internal-key"] ||
    req.path.endsWith("/ai-status") ||
    (req.method === "GET" && /^\/api\/cases\/[^/]+\/documents$/.test(req.path)),
});
app.use(limiter);

// ── Body parsing ─────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Local uploads fallback — only when Azure Blob Storage isn't configured.
// In production (Azure), AZURE_STORAGE_ACCOUNT_NAME is always set, so this
// block is skipped and we don't need a writable disk location.
if (!process.env.AZURE_STORAGE_ACCOUNT_NAME) {
  const uploadsDir = path.resolve(__dirname, "../uploads");
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.use("/uploads", express.static(uploadsDir));
}

// ── Health check ─────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Routes ───────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/auth", rcAuthRoutes);
app.use("/api/cases", caseRoutes);
app.use("/api/cases", documentRoutes);
app.use("/api/cases", checklistRoutes);
app.use("/api/cases", fundLineRoutes);
app.use("/api/cases", contributionRoutes);
app.use("/api/providers", providerRoutes);
app.use("/api/checklist-templates", checklistTemplateRoutes);
app.use("/api/users", userRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/crm", crmRoutes);
app.use("/api/cases", callRoutes);
app.use("/api/cases", exportRoutes);
// Internal BFF write-back endpoints (X-Internal-Key auth, no human users).
app.use("/api/documents", documentInternalRoutes);
// Unauthenticated by design — Palindrome fetches call recordings from here
// over the public internet using a signed, expiring, single-file token.
// Auth is the token itself; see services/recordingLinks.ts.
app.use("/api/public", publicRecordingRoutes);

// ── 404 handler ──────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ── Error handler ────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`🚀 Ceding Automation API running on port ${PORT}`);
  // Background poller is a safety net for missed BFF write-backs.
  // No-op when AI_VIA_BFF !== "true" or NODE_ENV === "test".
  startPoller();
  // Palindrome has no callback at all, so for transcription this poller is
  // the only completion path, not a safety net.
  // No-op when TRANSCRIPT_VIA_PALINDROME !== "true" or NODE_ENV === "test".
  startPalindromePoller();
  // Picks up recordings dropped straight into a client's "Ceding Call
  // Recordings" folder in WorkDrive, for CAs who file audio there rather than
  // using the app. No-op unless WATCH_RECORDING_FOLDER="true".
  startRecordingWatcher();
});

export default app;
