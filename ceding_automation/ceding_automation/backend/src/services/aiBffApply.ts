// backend/src/services/aiBffApply.ts
// Shared idempotent logic for applying BFF extraction results to the DB.
// Used by BOTH the PATCH write-back endpoints and the background poller, so
// both paths follow identical preservation / conflict / audit semantics.
//
// Contract: docs/ai-integration-design.md §4(a), §4(b), §6.

import { PrismaClient, Prisma } from "@prisma/client";
import type { BffExtractedField, BffJobResult } from "./aiBffClient";
import { compareFieldValues } from "../utils/compareFieldValues";
import { mirrorChecklistToCase } from "./caseFieldMirror";

const prisma = new PrismaClient();
const SYSTEM_USER_ID = "system-ai-bff";

// Outcomes the caller can surface to the BFF (and to telemetry).
export type ApplyFieldOutcome =
  | "applied"
  | "conflict"
  | "preserved" // isApproved or isManuallyOverridden
  | "no-overwrite-missing" // incoming was MISSING; existing value held
  | "field-not-found";

export interface ApplyFieldResult {
  outcome: ApplyFieldOutcome;
  fieldId?: string;
}

// Per-field idempotent application. Both PATCH and poller call this for each
// extracted field. Preservation + skip-on-MISSING guards live here so neither
// path can drift.
export async function applyFieldExtraction(args: {
  caseId: string;
  fieldKey: string;
  data: BffExtractedField;
  jobId: string;
  documentId: string;
  userId?: string;
  /** Canonical provider name passed from the caller (poller has BFF's
   *  detectedProvider.canonical; the PATCH path doesn't have it). When set,
   *  compareFieldValues uses it to treat alias variants of provider_name as
   *  equivalent rather than CONFLICT. */
  providerCanonical?: string;
}): Promise<ApplyFieldResult> {
  const userId = args.userId ?? SYSTEM_USER_ID;

  const field = await prisma.checklistField.findFirst({
    where: { caseId: args.caseId, template: { fieldKey: args.fieldKey } },
    include: { template: true },
  });
  if (!field) return { outcome: "field-not-found" };

  // (1) Preservation guard — never stomp CA-Team edits or adviser approvals.
  if (field.isApproved || field.isManuallyOverridden) {
    return { outcome: "preserved", fieldId: field.id };
  }

  // (2) Skip-on-MISSING guard — don't replace a real value with a fresh MISSING.
  // Treat the LITERAL string "MISSING" coming back from the BFF as a missing
  // signal too — it shows up when the source document itself prints "MISSING"
  // in the form field. Storing "MISSING" as the value confuses every
  // downstream counter (Stage 6, Approval, export) and shows the word
  // "MISSING" as a real value on screen.
  const looksMissing =
    args.data.value === null ||
    args.data.confidence === "MISSING" ||
    (typeof args.data.value === "string" && args.data.value.trim().toUpperCase() === "MISSING");
  if (looksMissing && field.value !== null) {
    return { outcome: "no-overwrite-missing", fieldId: field.id };
  }

  // Normalise: if BFF returned literal "MISSING", store as null so the rest
  // of the app's "is this missing?" logic works without per-row string checks.
  const incomingRaw = args.data.value;
  const incomingNormalised =
    incomingRaw === null
      ? null
      : typeof incomingRaw === "string" && incomingRaw.trim().toUpperCase() === "MISSING"
        ? null
        : incomingRaw;
  const newValueStr = incomingNormalised === null ? null : String(incomingNormalised);
  const rawValueStr = args.data.rawValue ?? newValueStr;

  // (3) Conflict path — existing value differs from new value.
  // Uses compareFieldValues so semantically-equivalent values (e.g.
  // "Aviva" vs "Aviva Life & Pensions UK Limited", "£10,558.60" vs "10558.6")
  // don't trigger CONFLICT.
  const isDifferent =
    field.value !== null &&
    compareFieldValues(
      field.value,
      newValueStr,
      field.template.fieldType,
      field.template.fieldKey,
      { providerCanonical: args.providerCanonical },
    ) === "different";
  if (isDifferent) {
    await prisma.checklistField.update({
      where: { id: field.id },
      data: {
        hasConflict: true,
        conflictValues: {
          existing: field.value,
          new: newValueStr,
          newJobId: args.jobId,
          newDocumentId: args.documentId,
          newPage: args.data.sourcePage,
        } as Prisma.InputJsonValue,
        confidence: "CONFLICT",
        aiJobId: args.jobId,
        aiExtractedAt: new Date(),
      },
    });
    await prisma.auditLog.create({
      data: {
        caseId: args.caseId,
        userId,
        action: "FIELD_EXTRACTED",
        source: "AI",
        fieldId: field.id,
        fieldKey: field.template.fieldKey,
        oldValue: field.value,
        newValue: newValueStr,
        metadata: {
          fieldLabel: field.template.fieldName,
          confidence: "CONFLICT",
          jobId: args.jobId,
          documentId: args.documentId,
          page: args.data.sourcePage ?? null,
          quote: args.data.sourceQuote ?? null,
          reasoning: args.data.reasoning ?? null,
          conflictedWith: field.value,
        } as Prisma.InputJsonValue,
      },
    });
    return { outcome: "conflict", fieldId: field.id };
  }

  // (4) Apply path.
  // If we normalised "MISSING" → null above, force confidence to MISSING too
  // so the stored row is internally consistent (no nulls with HIGH conf).
  const valueWasNormalised =
    typeof incomingRaw === "string" &&
    incomingRaw.trim().toUpperCase() === "MISSING" &&
    newValueStr === null;
  const effectiveConfidence = valueWasNormalised ? "MISSING" : args.data.confidence;

  const oldValue = field.value;
  await prisma.checklistField.update({
    where: { id: field.id },
    data: {
      value: newValueStr,
      aiRawValue: rawValueStr,
      confidence: effectiveConfidence,
      status: "AI_EXTRACTED",
      sourceDocumentId: args.documentId,
      sourcePageNumber: args.data.sourcePage,
      sourceSection: "BFF",
      sourceQuote: args.data.sourceQuote,
      hasConflict: false,
      aiJobId: args.jobId,
      aiExtractedAt: new Date(),
    },
  });
  await prisma.auditLog.create({
    data: {
      caseId: args.caseId,
      userId,
      action: "FIELD_EXTRACTED",
      source: "AI",
      fieldId: field.id,
      fieldKey: field.template.fieldKey,
      oldValue,
      newValue: newValueStr,
      metadata: {
        fieldLabel: field.template.fieldName,
        confidence: args.data.confidence,
        jobId: args.jobId,
        documentId: args.documentId,
        page: args.data.sourcePage ?? null,
        quote: args.data.sourceQuote ?? null,
        reasoning: args.data.reasoning ?? null,
      } as Prisma.InputJsonValue,
    },
  });
  // Propagate this field's value to the Case row (provider, policy_ref,
  // plan_start_date). Fail-soft — checklist write already succeeded.
  await mirrorChecklistToCase(args.caseId, field.template.fieldKey, newValueStr);
  return { outcome: "applied", fieldId: field.id };
}

// Document-level idempotent application. Called from the poller after a
// successful GET /result. The PATCH /api/documents/:id endpoint handles its
// own (simpler) document-state update — this helper is the "I have the full
// result, apply everything" path.
export async function applyExtractionResult(
  documentId: string,
  result: BffJobResult
): Promise<{ outcome: "applied" | "already-complete" | "not-found" }> {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) return { outcome: "not-found" };

  // Idempotency guard: whichever path settled first wins; the other no-ops.
  // Race window between this check and the update below is acceptable — at
  // worst we get duplicate audit rows, never duplicate field state changes
  // (each field write is itself idempotent via the preservation/value guards).
  if (doc.aiJobCompletedAt) return { outcome: "already-complete" };

  // BFF gives us a canonicalised provider name when its detector is
  // confident. Plumb it through so provider_name conflicts collapse on alias.
  const providerCanonical = result.response.detectedProvider?.canonical || undefined;

  for (const field of result.response.fields) {
    await applyFieldExtraction({
      caseId: doc.caseId,
      fieldKey: field.fieldKey,
      data: field,
      jobId: result.jobId,
      documentId,
      providerCanonical,
    });
  }

  // ── Fund Details table ─────────────────────────────────────
  // BFF returns a `fund_lines` array alongside the scalar fields. Previous
  // versions silently dropped these; we now persist them in ChecklistFundLine.
  // Strategy: REPLACE existing AI-extracted rows for this document, keep
  // manual rows untouched (status === MANUALLY_ENTERED / OVERRIDDEN).
  if (Array.isArray(result.response.fundLines) && result.response.fundLines.length > 0) {
    const caseRow = await prisma.case.findUnique({
      where: { id: doc.caseId },
      select: { id: true, planType: true },
    });
    if (caseRow) {
      // Delete prior AI rows for this document so re-extraction doesn't pile up.
      await prisma.checklistFundLine.deleteMany({
        where: {
          caseId: caseRow.id,
          sourceDocumentId: documentId,
          status: { in: ["AI_EXTRACTED"] },
        },
      });
      await prisma.checklistFundLine.createMany({
        data: result.response.fundLines.map((f, idx) => ({
          caseId: caseRow.id,
          planType: caseRow.planType,
          fundName: f.fundName || `Fund ${idx + 1}`,
          numberOfUnits: f.units != null ? new Prisma.Decimal(f.units) : null,
          pricePerUnit: f.price != null ? new Prisma.Decimal(f.price) : null,
          value: f.value != null ? new Prisma.Decimal(f.value) : null,
          sourceDocumentId: documentId,
          displayOrder: idx,
          status: "AI_EXTRACTED",
          confidence: "HIGH",
        })),
      });
      await prisma.auditLog.create({
        data: {
          caseId: caseRow.id,
          userId: SYSTEM_USER_ID,
          action: "FUND_LINE_ADDED",
          source: "AI",
          newValue: `${result.response.fundLines.length} fund rows extracted`,
          metadata: {
            jobId: result.jobId,
            documentId,
            count: result.response.fundLines.length,
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  const submittedAt = doc.aiJobSubmittedAt ?? doc.uploadedAt;
  const elapsedMs = Date.now() - submittedAt.getTime();

  await prisma.document.update({
    where: { id: documentId },
    data: {
      status: "EXTRACTED",
      aiJobStatus: "completed",
      aiJobStage: "done",
      aiJobProgress: 100,
      aiJobCompletedAt: new Date(),
      processedAt: new Date(),
      extractionMs: elapsedMs,
      aiJobCostUsd: new Prisma.Decimal(result.llmCallMeta.totalCostUsd),
      aiJobTokens: result.llmCallMeta.totalTokens,
    },
  });

  await prisma.auditLog.create({
    data: {
      caseId: doc.caseId,
      userId: SYSTEM_USER_ID,
      action: "AI_EXTRACTION_RUN",
      source: "AI",
      newValue: `${result.response.fields.length} fields processed`,
      metadata: {
        jobId: result.jobId,
        documentId,
        elapsedMs,
        costUsd: result.llmCallMeta.totalCostUsd,
        tokens: result.llmCallMeta.totalTokens,
        detectedProvider: result.response.detectedProvider,
        detectedPlanType: result.response.detectedPlanType,
        fieldsExtracted: result.response.summary.fieldsExtracted,
        fieldsMissing: result.response.summary.fieldsMissing,
        highConfidenceCount: result.response.summary.highConfidenceCount,
      } as Prisma.InputJsonValue,
    },
  });

  return { outcome: "applied" };
}
