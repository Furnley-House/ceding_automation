// backend/src/services/aiBffApply.ts
// Shared idempotent logic for applying BFF extraction results to the DB.
// Used by BOTH the PATCH write-back endpoints and the background poller, so
// both paths follow identical preservation / conflict / audit semantics.
//
// Contract: docs/ai-integration-design.md §4(a), §4(b), §6.

import { PrismaClient, Prisma } from "@prisma/client";
import type { BffExtractedField, BffJobResult } from "./aiBffClient";
import { compareFieldValues } from "../utils/compareFieldValues";

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
  const isMissing = args.data.value === null || args.data.confidence === "MISSING";
  if (isMissing && field.value !== null) {
    return { outcome: "no-overwrite-missing", fieldId: field.id };
  }

  const newValueStr = args.data.value === null ? null : String(args.data.value);
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
  const oldValue = field.value;
  await prisma.checklistField.update({
    where: { id: field.id },
    data: {
      value: newValueStr,
      aiRawValue: rawValueStr,
      confidence: args.data.confidence,
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
