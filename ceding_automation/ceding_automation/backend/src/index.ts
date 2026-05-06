// backend/src/index.ts
import "dotenv/config";
import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { caseRoutes } from "./routes/cases";
import { documentRoutes } from "./routes/documents";
import { checklistRoutes } from "./routes/checklist";
import { fundLineRoutes } from "./routes/fundLines";
import { providerRoutes } from "./routes/providers";
import { userRoutes } from "./routes/users";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { notificationRoutes } from "./routes/notifications";
import { crmRoutes } from "./routes/crm";
import { callRoutes } from "./routes/calls";

const app = express();
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
});
app.use(limiter);

// ── Body parsing ─────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Local file uploads (dev fallback when Azure Storage not configured) ───
const uploadsDir = path.resolve(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

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
app.use("/api/users", userRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/crm", crmRoutes);
app.use("/api/cases", callRoutes);

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
});

export default app;
