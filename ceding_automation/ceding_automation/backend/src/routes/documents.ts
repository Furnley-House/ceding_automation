// backend/src/routes/documents.ts
import { Router, Request, Response } from "express";
import { Prisma, PrismaClient, DocumentStatus } from "@prisma/client";
import multer from "multer";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireInternalKey } from "../middleware/internalKey";
import { uploadToAzureBlob, generateSasUrl, downloadBlobAsBuffer } from "../services/storage";
import { extractDocumentWithAI } from "../services/aiExtraction";
import * as aiBff from "../services/aiBffClient";
import { compareFieldValues } from "../utils/compareFieldValues";

const router = Router();
// Internal router for PATCH /api/documents/:documentId — mounted at /api/documents
// in index.ts. Separate from `router` because BFF write-back uses a documentId
// path that doesn't carry a caseId.
const internalRouter = Router();
const prisma = new PrismaClient();

// Multer – store in memory, then stream to Azure Blob
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/plain",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// ── Upload Document ─────────────────────────────────────
router.post(
  "/:caseId/documents",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const caseRecord = await prisma.case.findUnique({ where: { id: req.params.caseId } });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    // Upload to Azure Blob Storage
    const storagePath = `cases/${req.params.caseId}/${Date.now()}-${req.file.originalname}`;
    await uploadToAzureBlob(storagePath, req.file.buffer, req.file.mimetype);

    const doc = await prisma.document.create({
      data: {
        caseId: req.params.caseId,
        filename: storagePath,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSizeBytes: req.file.size,
        storagePath,
        status: "UPLOADED",
      },
    });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "DOCUMENT_UPLOADED",
        newValue: req.file.originalname,
        metadata: { documentId: doc.id },
        source: "MANUAL",
      },
    });

    // Auto-trigger AI extraction.
    // When AI_VIA_BFF=true → submit to BFF (passes relative blob path; BFF
    // resolves via its own managed identity). Otherwise legacy in-process path.
    // Fire-and-forget — client polls /ai-status or Document.status for updates.
    submitOrTrigger(doc.id, req.params.caseId, req.user!.id).catch(console.error);

    res.status(201).json(doc);
  }
);

// ── Get Documents for Case ──────────────────────────────
router.get("/:caseId/documents", requireAuth, async (req: Request, res: Response) => {
  const docs = await prisma.document.findMany({
    where: { caseId: req.params.caseId },
    orderBy: { uploadedAt: "desc" },
  });
  res.json(docs);
});

// ── Get Document with Signed URL ────────────────────────
router.get("/:caseId/documents/:docId/url", requireAuth, async (req: Request, res: Response) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.docId } });
  if (!doc) return res.status(404).json({ error: "Document not found" });

  let url = await generateSasUrl(doc.storagePath, 60); // 60 min expiry

  // Local fallback paths are relative (/uploads/...) — make them absolute so the browser can load them
  if (url.startsWith("/")) {
    url = `${req.protocol}://${req.get("host")}${url}`;
  }

  res.json({ url });
});

// ── Stream the document bytes back through the API ──────
//
// Why this exists: react-pdf fetches the file URL directly from the browser.
// When the URL is a SAS link to Azure Blob Storage, the request is blocked by
// CORS unless the storage account explicitly allows the frontend origin.
// Proxying the bytes through this endpoint sidesteps that — the browser only
// ever talks to our own API (same-origin / already-CORS-allowed), and the
// SAS / connection string never leaves the server. The trade-off is that the
// whole file moves through our backend instead of being downloaded directly.
router.get(
  "/:caseId/documents/:docId/raw",
  requireAuth,
  async (req: Request, res: Response) => {
    const doc = await prisma.document.findUnique({
      where: { id: req.params.docId },
    });
    if (!doc) return res.status(404).json({ error: "Document not found" });
    if (doc.caseId !== req.params.caseId) {
      // Prevent the docId-guessing path from leaking documents across cases.
      return res.status(404).json({ error: "Document not found" });
    }

    try {
      const buffer = await downloadBlobAsBuffer(doc.storagePath);
      res.setHeader("Content-Type", doc.mimeType || "application/pdf");
      // Inline so the browser renders it; filename helps when the user saves.
      const safeName = (doc.originalName || "document.pdf").replace(/"/g, "");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeName}"`
      );
      // SAS URLs expire in 60min; cache for 5min so the PDF viewer doesn't
      // re-fetch on every page render but stale content is short-lived.
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Content-Length", buffer.length.toString());
      res.send(buffer);
    } catch (err) {
      console.error("[documents/raw] failed to stream blob", err);
      res.status(502).json({ error: "Failed to load document" });
    }
  }
);

// ── Delete Document ─────────────────────────────────────
//
// Hard-delete (rare in production — usually we'd soft-delete instead). The
// audit row is the only post-hoc evidence the file ever existed, so it's
// captured before the row is removed and includes the filename + metadata.
router.delete(
  "/:caseId/documents/:docId",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const doc = await prisma.document.findUnique({ where: { id: req.params.docId } });
    if (!doc) return res.status(404).json({ error: "Document not found" });

    await prisma.document.delete({ where: { id: req.params.docId } });

    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "DOCUMENT_DELETED",
        source: "MANUAL",
        oldValue: doc.filename ?? doc.originalName ?? doc.id,
        metadata: {
          documentId: doc.id,
          filename: doc.filename,
          originalName: doc.originalName,
          status: doc.status,
          pageCount: doc.pageCount,
          uploadedAt: doc.uploadedAt,
        },
      },
    });

    res.json({ message: "Document deleted" });
  }
);

// ── Manually Trigger Extraction ─────────────────────────
router.post(
  "/:caseId/documents/:docId/extract",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const doc = await prisma.document.findUnique({ where: { id: req.params.docId } });
    if (!doc) return res.status(404).json({ error: "Document not found" });

    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "PROCESSING", processedAt: null, errorMessage: null },
    });

    submitOrTrigger(doc.id, req.params.caseId, req.user!.id).catch(console.error);

    res.json({ message: "Extraction started" });
  }
);

// ── Cancel In-flight Extraction ─────────────────────────
//
// Marks the document as a failed/cancelled job so:
//   - the background poller stops checking on it (aiJobStatus = "failed")
//   - the UI's "Extracting…" badge flips to "Error" (status = ERROR)
//   - the idempotency guard on applyExtractionResult prevents a late
//     write-back from re-opening the field state
//
// We do NOT attempt to cancel the job on the BFF side — the BFF API
// doesn't expose a cancel endpoint and the queued worker will just be
// wasted compute. That's acceptable: cancellation is a UX action to
// unblock the user, not a cost-control mechanism. The BFF will finish
// or time out on its own; our idempotency guard ignores its eventual
// response.
router.post(
  "/:caseId/documents/:docId/cancel",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const doc = await prisma.document.findUnique({
      where: { id: req.params.docId },
    });
    if (!doc || doc.caseId !== req.params.caseId) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Only meaningful while the doc is in flight. Cancelling an already-
    // settled doc would clobber its EXTRACTED state — guard explicitly.
    if (doc.status !== "PROCESSING" && doc.status !== "UPLOADED") {
      return res
        .status(409)
        .json({ error: `Document is in ${doc.status} — nothing to cancel` });
    }

    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: {
        status: "ERROR",
        aiJobStatus: "failed",
        aiJobCompletedAt: new Date(),
        aiJobError: "Cancelled by user",
        errorMessage: "Cancelled by user",
      },
    });

    // Audit using AI_EXTRACTION_RUN (we don't have a dedicated cancel enum
    // value; metadata carries the intent so reports can still tell them
    // apart from real failures).
    await prisma.auditLog.create({
      data: {
        caseId: req.params.caseId,
        userId: req.user!.id,
        action: "AI_EXTRACTION_RUN",
        source: "MANUAL",
        newValue: "cancelled",
        metadata: {
          documentId: doc.id,
          previousStatus: doc.status,
          aiJobId: doc.aiJobId,
        },
      },
    });

    res.json({ message: "Extraction cancelled", document: updated });
  }
);

// ── Internal: route to BFF or legacy extractor based on feature flag ────
// Single dispatch point so both upload and manual-re-trigger paths agree on
// which AI backend is in use. Flag-flip in env is the only knob.
async function submitOrTrigger(docId: string, caseId: string, userId: string): Promise<void> {
  if (process.env.AI_VIA_BFF !== "true") {
    await triggerExtraction(docId, caseId, userId);
    return;
  }

  // BFF path — submit job, persist job_id, return immediately. Result arrives
  // via write-back PATCH /api/documents/:id (or the poller as fallback).
  try {
    const doc = await prisma.document.findUnique({ where: { id: docId } });
    if (!doc) throw new Error(`Document ${docId} not found`);

    const caseRecord = await prisma.case.findUnique({
      where: { id: caseId },
      include: {
        provider: true,
        checklistFields: { include: { template: true } },
      },
    });
    if (!caseRecord) throw new Error(`Case ${caseId} not found`);

    const submission = await aiBff.submitExtractionJob({
      storagePath: doc.storagePath, // relative path; BFF uses managed identity
      caseId,
      documentId: docId,
      planType: aiBff.mapPlanTypeToBff(caseRecord.planType),
      providerName: caseRecord.provider?.name,
      policyRef: caseRecord.policyRef ?? undefined,
      clientName: caseRecord.clientName,
      zohoTaskId: caseRecord.zohoTaskId ?? undefined,
      checklistFields: caseRecord.checklistFields.map((f) => ({
        fieldKey: f.template.fieldKey,
        fieldName: f.template.fieldName,
        fieldType: f.template.fieldType,
        isRequired: f.template.isRequired,
        dropdownOptions: f.template.dropdownOptions ?? undefined,
      })),
    });

    await prisma.document.update({
      where: { id: docId },
      data: {
        status: "PROCESSING",
        aiJobId: submission.jobId,
        aiJobStatus: submission.status,
        // Use local clock — aiJobSubmittedAt represents WHEN WE SUBMITTED,
        // not the BFF's clock. BFF's submitted_at field may be missing or
        // unparseable; either way, we know now is the right time.
        aiJobSubmittedAt: new Date(),
        // Clear terminal-state fields in case this is a re-extraction.
        aiJobCompletedAt: null,
        aiJobError: null,
        aiJobStage: null,
        aiJobProgress: null,
        errorMessage: null,
        extractionModel: `bff:${submission.jobId}`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[submitOrTrigger] BFF submission failed:", message);
    await prisma.document.update({
      where: { id: docId },
      data: {
        status: "ERROR",
        errorMessage: message,
        aiJobError: message,
      },
    });
  }
}

// ── Internal: run extraction ─────────────────────────────
async function triggerExtraction(docId: string, caseId: string, userId: string) {
  const start = Date.now();
  try {
    await prisma.document.update({
      where: { id: docId },
      data: { status: "PROCESSING" },
    });

    const caseRecord = await prisma.case.findUnique({
      where: { id: caseId },
      include: {
        checklistFields: { include: { template: true } },
      },
    });

    if (!caseRecord) throw new Error("Case not found");

    const doc = await prisma.document.findUnique({ where: { id: docId } });
    if (!doc) throw new Error("Document not found");

    // Run Azure OpenAI extraction
    const extracted = await extractDocumentWithAI({
      storagePath: doc.storagePath,
      planType: caseRecord.planType,
      checklistFields: caseRecord.checklistFields.map((f) => ({
        id: f.id,
        key: f.template.fieldKey,
        label: f.template.fieldName,
        type: f.template.fieldType,
      })),
    });

    // Save extracted values to checklist fields and stage per-field audit
    // entries. We accumulate audit rows in `fieldAudits` and write them in a
    // single `createMany` after the loop — a 50-field extraction would
    // otherwise be 50 sequential round-trips.
    const fieldAudits: Prisma.AuditLogCreateManyInput[] = [];

    for (const result of extracted.fields) {
      const field = caseRecord.checklistFields.find(
        (f) => f.template.fieldKey === result.fieldKey
      );
      if (!field) continue;

      // Check for conflict with existing value. Routes through
      // compareFieldValues so semantically-equivalent values (currency
      // formatting, date format, none-aliases, etc.) don't raise CONFLICT.
      const isConflict =
        !!field.value &&
        compareFieldValues(
          field.value,
          result.value,
          field.template.fieldType,
          field.template.fieldKey,
        ) === "different";
      if (isConflict) {
        await prisma.checklistField.update({
          where: { id: field.id },
          data: {
            hasConflict: true,
            conflictValues: {
              existing: field.value,
              new: result.value,
              newDocId: docId,
              newPage: result.pageNumber,
            },
            confidence: "CONFLICT",
          },
        });
        // Conflict — log so the audit trail shows which field / page caused it
        fieldAudits.push({
          caseId,
          userId,
          action: "FIELD_EXTRACTED",
          source: "AI",
          fieldId: field.id,
          fieldKey: field.template.fieldKey,
          oldValue: field.value,
          newValue: result.value,
          metadata: {
            fieldLabel: field.template.fieldName,
            confidence: "CONFLICT",
            documentId: docId,
            page: result.pageNumber ?? null,
            section: result.section ?? null,
            quote: result.quote ?? null,
            conflictedWith: field.value,
          },
        });
      } else {
        await prisma.checklistField.update({
          where: { id: field.id },
          data: {
            value: result.value,
            aiRawValue: result.value,
            confidence: result.confidence,
            status: "AI_EXTRACTED",
            sourceDocumentId: docId,
            sourcePageNumber: result.pageNumber,
            sourceSection: result.section,
            sourceQuote: result.quote,
            hasConflict: false,
          },
        });
        fieldAudits.push({
          caseId,
          userId,
          action: "FIELD_EXTRACTED",
          source: "AI",
          fieldId: field.id,
          fieldKey: field.template.fieldKey,
          oldValue: field.value,
          newValue: result.value,
          metadata: {
            fieldLabel: field.template.fieldName,
            confidence: result.confidence,
            documentId: docId,
            page: result.pageNumber ?? null,
            section: result.section ?? null,
            quote: result.quote ?? null,
          },
        });
      }
    }

    // Batch-insert per-field audit rows (skipped if extraction returned zero).
    if (fieldAudits.length > 0) {
      await prisma.auditLog.createMany({ data: fieldAudits });
    }

    const elapsedMs = Date.now() - start;

    await prisma.document.update({
      where: { id: docId },
      data: {
        status: "EXTRACTED",
        processedAt: new Date(),
        pageCount: extracted.pageCount,
        extractionModel: extracted.model,
        extractionMs: elapsedMs,
      },
    });

    // Document-level summary entry — sits alongside the per-field rows so the
    // timeline can group them visually.
    await prisma.auditLog.create({
      data: {
        caseId,
        userId,
        action: "AI_EXTRACTION_RUN",
        newValue: `${extracted.fields.length} fields extracted`,
        metadata: {
          documentId: docId,
          elapsedMs,
          model: extracted.model,
          fieldCount: extracted.fields.length,
        },
        source: "AI",
      },
    });
  } catch (error) {
    await prisma.document.update({
      where: { id: docId },
      data: {
        status: "ERROR",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }
}

// ── Frontend: poll AI extraction status for a document ─────────────
// Pure read; any logged-in user can call. Frontend hook
// `useExtractionStatus` polls this every 3s while a doc is in PROCESSING.
router.get(
  "/:caseId/documents/:documentId/ai-status",
  requireAuth,
  async (req: Request, res: Response) => {
    const doc = await prisma.document.findFirst({
      where: { id: req.params.documentId, caseId: req.params.caseId },
      select: {
        id: true,
        status: true,
        aiJobId: true,
        aiJobStatus: true,
        aiJobStage: true,
        aiJobProgress: true,
        aiJobSubmittedAt: true,
        aiJobCompletedAt: true,
        aiJobError: true,
      },
    });
    if (!doc) return res.status(404).json({ error: "Document not found" });

    res.set("Cache-Control", "no-store");
    res.json({
      documentId: doc.id,
      documentStatus: doc.status,
      jobId: doc.aiJobId,
      status: doc.aiJobStatus,
      stage: doc.aiJobStage,
      progressPct: doc.aiJobProgress,
      submittedAt: doc.aiJobSubmittedAt,
      completedAt: doc.aiJobCompletedAt,
      error: doc.aiJobError,
      elapsedMs: doc.aiJobSubmittedAt
        ? Date.now() - doc.aiJobSubmittedAt.getTime()
        : null,
    });
  }
);

// ── BFF write-back: document-level status update ───────────────────
// Mounted at /api/documents/:documentId. Called by the BFF only.
// Contract: docs/ai-integration-design.md §4(b).
const aiDocWriteBackSchema = z.object({
  job_id: z.string().regex(/^bff-[0-9a-f]{8,16}$/),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  stage: z
    .enum(["stage1", "stage2", "stage3", "stage4", "done"])
    .optional(),
  progress_pct: z.number().int().min(0).max(100).optional(),
  completed_at: z.string().datetime().optional(),
  error: z.string().max(2000).optional(),
  page_count: z.number().int().positive().optional(),
  detected_provider: z
    .object({
      name: z.string(),
      canonical: z.string(),
      confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    })
    .optional(),
  detected_plan_type: z.string().optional(),
  llm_call_meta: z
    .object({
      total_tokens: z.number().int().nonnegative(),
      total_cost_usd: z.number().nonnegative(),
    })
    .optional(),
});

function bffStatusToDocumentStatus(s: string): DocumentStatus {
  switch (s) {
    case "completed":
      return DocumentStatus.EXTRACTED;
    case "failed":
      return DocumentStatus.ERROR;
    default:
      return DocumentStatus.PROCESSING;
  }
}

internalRouter.patch(
  "/:documentId",
  requireInternalKey,
  async (req: Request, res: Response) => {
    const parse = aiDocWriteBackSchema.safeParse(req.body);
    if (!parse.success) {
      return res
        .status(400)
        .json({ error: "Invalid payload", details: parse.error.flatten() });
    }
    const body = parse.data;

    const doc = await prisma.document.findFirst({
      where: { id: req.params.documentId, aiJobId: body.job_id },
    });
    if (!doc) {
      return res
        .status(404)
        .json({ error: "Document not found for this job_id" });
    }

    // Idempotency: if we already settled this job, no-op.
    if (doc.aiJobCompletedAt && body.status === "completed") {
      return res.json({
        ok: true,
        documentId: doc.id,
        alreadyComplete: true,
      });
    }

    const now = new Date();
    const isTerminal = body.status === "completed" || body.status === "failed";
    const completedAtFromBody = body.completed_at
      ? new Date(body.completed_at)
      : now;
    const submittedAt = doc.aiJobSubmittedAt ?? doc.uploadedAt;

    const updateData: Prisma.DocumentUpdateInput = {
      status: bffStatusToDocumentStatus(body.status),
      aiJobStatus: body.status,
      aiJobStage: body.stage ?? doc.aiJobStage,
      aiJobProgress: body.progress_pct ?? doc.aiJobProgress,
    };

    if (body.page_count !== undefined) updateData.pageCount = body.page_count;
    if (body.error !== undefined) {
      updateData.aiJobError = body.error;
      updateData.errorMessage = body.error;
    }
    if (body.llm_call_meta) {
      updateData.aiJobCostUsd = new Prisma.Decimal(
        body.llm_call_meta.total_cost_usd
      );
      updateData.aiJobTokens = body.llm_call_meta.total_tokens;
    }
    if (isTerminal && !doc.aiJobCompletedAt) {
      updateData.aiJobCompletedAt = completedAtFromBody;
      updateData.processedAt = completedAtFromBody;
      updateData.extractionMs = completedAtFromBody.getTime() - submittedAt.getTime();
    }

    await prisma.document.update({
      where: { id: doc.id },
      data: updateData,
    });

    // Audit only on terminal transitions (avoid noise on stage progression).
    if (isTerminal && !doc.aiJobCompletedAt) {
      await prisma.auditLog.create({
        data: {
          caseId: doc.caseId,
          userId: req.user!.id,
          action: "AI_EXTRACTION_RUN",
          source: "AI",
          newValue:
            body.status === "completed"
              ? `Extraction completed (${body.job_id})`
              : `Extraction failed: ${body.error ?? "unknown error"}`,
          metadata: {
            jobId: body.job_id,
            documentId: doc.id,
            bffStatus: body.status,
            stage: body.stage ?? null,
            error: body.error ?? null,
            detectedProvider: body.detected_provider ?? null,
            detectedPlanType: body.detected_plan_type ?? null,
            costUsd: body.llm_call_meta?.total_cost_usd ?? null,
            tokens: body.llm_call_meta?.total_tokens ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    }

    return res.json({
      ok: true,
      documentId: doc.id,
      status: updateData.status,
    });
  }
);

export { router as documentRoutes, internalRouter as documentInternalRoutes };
