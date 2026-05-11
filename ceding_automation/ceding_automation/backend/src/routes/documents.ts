// backend/src/routes/documents.ts
import { Router, Request, Response } from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import multer from "multer";
import { requireAuth, requireRole } from "../middleware/auth";
import { uploadToAzureBlob, generateSasUrl } from "../services/storage";
import { extractDocumentWithAI } from "../services/aiExtraction";

const router = Router();
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

    // Auto-trigger AI extraction
    // Fire and forget – client polls for status
    triggerExtraction(doc.id, req.params.caseId, req.user!.id).catch(console.error);

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
          uploadedAt: doc.createdAt,
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

    triggerExtraction(doc.id, req.params.caseId, req.user!.id).catch(console.error);

    res.json({ message: "Extraction started" });
  }
);

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

      // Check for conflict with existing value
      if (field.value && field.value !== result.value) {
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

export { router as documentRoutes };
