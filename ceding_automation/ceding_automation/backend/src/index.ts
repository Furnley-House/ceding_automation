// backend/src/index.ts
import "dotenv/config";
import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { caseRoutes } from "./routes/cases";
import { documentRoutes, documentInternalRoutes } from "./routes/documents";
import { checklistRoutes } from "./routes/checklist";
import { fundLineRoutes } from "./routes/fundLines";
import { providerRoutes } from "./routes/providers";
import { checklistTemplateRoutes } from "./routes/checklistTemplates";
import { userRoutes } from "./routes/users";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { notificationRoutes } from "./routes/notifications";
import { crmRoutes } from "./routes/crm";
import { callRoutes } from "./routes/calls";
import { exportRoutes } from "./routes/export";
import { startPoller } from "./services/aiBffPoller";

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
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 200,
  // BFF write-back is server-to-server (X-Internal-Key auth) and bursts
  // 66 requests per doc per submission (65 field PATCHes + 1 doc-level).
  // Multi-doc cases (3-4 docs) blew the shared human-IP budget and 429'd.
  // Internal routes are already guarded by requireInternalKey middleware.
  skip: (req) => !!req.headers["x-internal-key"],
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
app.use("/api/cases", caseRoutes);
app.use("/api/cases", documentRoutes);
app.use("/api/cases", checklistRoutes);
app.use("/api/cases", fundLineRoutes);
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
});

export default app;
