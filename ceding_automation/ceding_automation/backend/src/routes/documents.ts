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
import { applyFundLines } from "../services/aiBffApply";
import { compareFieldValues } from "../utils/compareFieldValues";

const router = Router();
// Internal router for PATCH /api/documents/:documentId — mounted at /api/documents
// in index.ts. Separate from `router` because BFF write-back uses a documentId
// path that doesn't carry a caseId.
const internalRouter = Router();
const prisma = new PrismaClient();

// Multer – store in memory, then stream to Azure Blob
//
// PDF only. Word/Excel/plain-text were accepted historically, but the AI BFF
// can only extract from PDFs end-to-end — other formats just produced failed
// extractions, so this gate now matches reality. Accept on EITHER the
// application/pdf MIME OR the .pdf extension (belt-and-braces). A non-PDF is
// flagged on the request so the route can answer with a precise 415 rather
// than a generic 500 from a thrown fileFilter error.
const ALLOWED_MIME_TYPES = ["application/pdf"];
const ALLOWED_EXTENSIONS_RE = /\.pdf$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const mimeOk = ALLOWED_MIME_TYPES.includes(file.mimetype);
    const extOk = ALLOWED_EXTENSIONS_RE.test(file.originalname ?? "");
    if (mimeOk || extOk) {
      cb(null, true);
    } else {
      (req as Request & { fileTypeRejected?: string }).fileTypeRejected =
        `${file.mimetype} (${file.originalname})`;
      cb(null, false);
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
    if (!req.file) {
      // multer's fileFilter skipped a non-PDF — answer with a precise 415.
      const rejected = (req as Request & { fileTypeRejected?: string }).fileTypeRejected;
      if (rejected) {
        return res
          .status(415)
          .json({ error: `Unsupported file type: ${rejected}. Only PDF files are accepted.` });
      }
      return res.status(400).json({ error: "No file uploaded" });
    }

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
//
// S5 / Decision 6: cleanup BEFORE document.delete inside one $transaction.
// The FK is ON DELETE SET NULL — once the doc row is gone, sourceDocumentId
// on dependent rows is already null, and our updateMany/deleteMany WHEREs
// would match nothing. Doing it inside the same tx makes the whole thing
// all-or-nothing: cleanup failure rolls back the delete.
router.delete(
  "/:caseId/documents/:docId",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const doc = await prisma.document.findUnique({ where: { id: req.params.docId } });
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const docId = req.params.docId;
    const documentName = doc.originalName ?? doc.filename ?? doc.id;

    const { revertedFieldCount, deletedFundCount } = await prisma.$transaction(
      async (tx) => {
        // 1) Revert AI-only checklist fields whose source just vanished.
        //    Preserves human-edited (isManuallyOverridden) and adviser-approved
        //    (isApproved) fields — those survive even when their citation does.
        const revertedFields = await tx.checklistField.updateMany({
          where: {
            sourceDocumentId: docId,
            isManuallyOverridden: false,
            isApproved: false,
          },
          data: {
            value: null,
            confidence: "MISSING",
            status: "AI_EXTRACTED",
          },
        });

        // 2) Delete AI-extracted fund rows from this doc. Mirrors the
        //    re-extraction cleanup pattern in aiBffApply.applyFundLines —
        //    MANUALLY_ENTERED / OVERRIDDEN rows are preserved.
        const deletedFunds = await tx.checklistFundLine.deleteMany({
          where: {
            sourceDocumentId: docId,
            status: "AI_EXTRACTED",
          },
        });

        // 3) Now safe to drop the document row. The FK SET NULL cascade
        //    nulls sourceDocumentId on any remaining dependents (the
        //    human-preserved fields, manual fund rows). The
        //    sourceDocumentName snapshot persists on those rows.
        await tx.document.delete({ where: { id: docId } });

        // 4) Original DOCUMENT_DELETED audit row — unchanged shape.
        await tx.auditLog.create({
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

        // 5) Cleanup-breadcrumb audit row — only if cleanup actually did
        //    something. Lets the audit timeline distinguish "doc deleted,
        //    took N rows with it" from "doc deleted, nothing to clean".
        if (revertedFields.count > 0 || deletedFunds.count > 0) {
          await tx.auditLog.create({
            data: {
              caseId: req.params.caseId,
              userId: req.user!.id,
              action: "FIELDS_REVERTED_ON_DOC_DELETE",
              source: "MANUAL",
              newValue: `${revertedFields.count} field(s) reverted, ${deletedFunds.count} fund row(s) removed — source document deleted: ${documentName}`,
              metadata: {
                documentId: doc.id,
                revertedFieldCount: revertedFields.count,
                deletedFundCount: deletedFunds.count,
                documentName,
              },
            },
          });
        }

        return {
          revertedFieldCount: revertedFields.count,
          deletedFundCount: deletedFunds.count,
        };
      }
    );

    res.json({
      message: "Document deleted",
      revertedFieldCount,
      deletedFundCount,
    });
  }
);

// ── Batch Trigger Extraction (Extract All Pending) ───────
//
// S3 of the Stage 3/4 redesign (docs/stage3_4_redesign_design.md,
// Decision 2). Stage 4's "Extract All" button POSTs here. Finds every
// doc on the case still in UPLOADED status and submits each through
// submitOrTrigger. Strict scope: UPLOADED only — ERROR docs are NOT
// retried by this route, the per-doc /extract route below stays as
// the escape hatch (γ in the design doc) for retrying a specific
// failure.
//
// Per-doc state transitions are identical to the single-doc route
// directly below: status flips to PROCESSING, processedAt and
// errorMessage clear, submitOrTrigger handles BFF dispatch and
// catches its own failures (sets status=ERROR on submission failure).
// The fire-and-forget catch is therefore safe.
//
// Path is 3-segment (after /api/cases): /:caseId/documents/extract-pending.
// The single-doc /extract route below is 4-segment, so no path-collision
// regardless of registration order. Registered first for defensive
// clarity (literal-path before param-path).
//
// Loop is sequential: realistic case has 1-5 docs; even 10+ completes
// in 2-3s total. Not worth parallelising.
router.post(
  "/:caseId/documents/extract-pending",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN"]),
  async (req: Request, res: Response) => {
    const pending = await prisma.document.findMany({
      where: { caseId: req.params.caseId, status: "UPLOADED" },
      select: { id: true },
    });
    for (const doc of pending) {
      await prisma.document.update({
        where: { id: doc.id },
        data: { status: "PROCESSING", processedAt: null, errorMessage: null },
      });
      submitOrTrigger(doc.id, req.params.caseId, req.user!.id).catch(console.error);
    }
    res.json({ count: pending.length, documentIds: pending.map((d) => d.id) });
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
// Contract is intentionally lenient on optional metadata blocks:
// detected_provider / llm_call_meta are passed through from the pipeline whose
// model shapes evolve independently. We pin only the fields we actually consume
// downstream; anything else is accepted-and-ignored via .passthrough().
// Snake_case wire shape mirroring the BFF /result reshape (extract.py) and
// the pipeline's FundLine Pydantic model. Optional at the body level — every
// existing caller (and any non-fund document) simply omits the key.
const fundLineWireSchema = z.object({
  fund_name: z.string(),
  isin: z.string().optional().nullable(),
  sedol: z.string().optional().nullable(),
  number_of_units: z.number().optional().nullable(),
  price_per_unit: z.number().optional().nullable(),
  value_gbp: z.number().optional().nullable(),
  // OCF / Transaction Costs are manual-entry only — not part of the BFF
  // contract, so no wire field here.
  is_with_profits: z.boolean().optional(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW", "MISSING"]).optional(),
});

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
      name: z.string().optional(),
      canonical: z.string().optional(),
      confidence: z.string().optional(),
    })
    .passthrough()
    .optional()
    .nullable(),
  detected_plan_type: z.string().optional().nullable(),
  llm_call_meta: z
    .object({
      // Backend only reads total_tokens + total_cost_usd. Both optional —
      // pipeline's per-stage LLMCallMeta uses prompt_tokens/completion_tokens
      // and may omit the rolled-up totals entirely. The PATCH handler guards
      // with `if (body.llm_call_meta?.total_tokens != null)` style checks.
      total_tokens: z.number().int().nonnegative().optional(),
      total_cost_usd: z.number().nonnegative().optional(),
    })
    .passthrough()
    .optional()
    .nullable(),
  // Identifier of the Stage 4 prompt template that produced this extraction
  // (e.g. "stage4_extraction_PENSION_v2"). Pipeline writes it onto the Cosmos
  // doc; BFF will forward it as a sibling on the write-back body. Persisted
  // into the AI_EXTRACTION_RUN audit row's metadata (Gap 2) so prompt-version
  // is retrievable per-run for analysis. Optional — pre-Gap-2 callers omit it.
  prompt_template_id: z.string().optional().nullable(),
  // Fund Details rows piggy-backed on the doc-status PATCH so they persist
  // atomically with the aiJobCompletedAt flip. Optional — non-fund docs and
  // every pre-existing caller omit this. When present, the handler wraps the
  // document.update + audit + applyFundLines in a single $transaction; if
  // anything throws, the doc isn't marked complete and the poller picks up
  // the doc and retries via applyExtractionResult (which calls the SAME
  // applyFundLines helper).
  fund_lines: z.array(fundLineWireSchema).optional(),
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
      if (body.llm_call_meta.total_cost_usd != null) {
        updateData.aiJobCostUsd = new Prisma.Decimal(body.llm_call_meta.total_cost_usd);
      }
      if (body.llm_call_meta.total_tokens != null) {
        updateData.aiJobTokens = body.llm_call_meta.total_tokens;
      }
    }
    if (isTerminal && !doc.aiJobCompletedAt) {
      updateData.aiJobCompletedAt = completedAtFromBody;
      updateData.processedAt = completedAtFromBody;
      updateData.extractionMs = completedAtFromBody.getTime() - submittedAt.getTime();
    }

    // Map snake_case wire shape → applyFundLines's camelCase BffJobResult
    // shape. Done outside the tx so a malformed body fails cheaply.
    const mappedFundLines =
      body.fund_lines && body.fund_lines.length > 0
        ? body.fund_lines.map((fl) => ({
            fundName: fl.fund_name,
            isin: fl.isin ?? null,
            sedol: fl.sedol ?? null,
            numberOfUnits: fl.number_of_units ?? null,
            pricePerUnit: fl.price_per_unit ?? null,
            valueGbp: fl.value_gbp ?? null,
            isWithProfits: fl.is_with_profits ?? false,
            confidence: fl.confidence ?? "MISSING",
          }))
        : null;

    // Audit-log entry — fields identical to the prior inline write. Pulled
    // into a builder so both branches (with-tx, without-tx) can reuse it.
    const buildAuditCreate = (): Prisma.AuditLogCreateArgs["data"] => ({
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
        promptTemplateId: body.prompt_template_id ?? null,
      } as Prisma.InputJsonValue,
    });

    if (mappedFundLines) {
      // Fund-lines path: persist funds + flip aiJobCompletedAt atomically.
      // If applyFundLines throws, the whole tx rolls back, aiJobCompletedAt
      // stays null, and the poller picks the doc up to retry via
      // applyExtractionResult (which uses the SAME applyFundLines helper).
      await prisma.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: doc.id },
          data: updateData,
        });
        if (isTerminal && !doc.aiJobCompletedAt) {
          await tx.auditLog.create({ data: buildAuditCreate() });
        }
        await applyFundLines({
          caseId: doc.caseId,
          documentId: doc.id,
          jobId: body.job_id,
          fundLines: mappedFundLines,
          tx,
        });
      });
    } else {
      // No fund_lines on the body — preserves the EXACT pre-refactor path
      // for every caller (non-fund docs + the existing scalar-only flow).
      // Same two writes, same order, NO transaction wrapping, NO behavior
      // change.
      await prisma.document.update({
        where: { id: doc.id },
        data: updateData,
      });
      if (isTerminal && !doc.aiJobCompletedAt) {
        await prisma.auditLog.create({ data: buildAuditCreate() });
      }
    }

    return res.json({
      ok: true,
      documentId: doc.id,
      status: updateData.status,
    });
  }
);

export { router as documentRoutes, internalRouter as documentInternalRoutes };
