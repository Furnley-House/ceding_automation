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
export const SYSTEM_USER_ID = "system-ai-bff";

// Outcomes the caller can surface to the BFF (and to telemetry).
export type ApplyFieldOutcome =
  | "applied"
  | "conflict"
  | "preserved" // isApproved or isManuallyOverridden
  | "no-overwrite-missing" // incoming was MISSING; existing value held
  | "skipped-manual-only" // template flagged manual-entry-only; AI never writes
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

  // Ship #1 (H18): scope the (caseId, fieldKey) lookup by the case's
  // current planType. Same rationale as checklist.ts:636-649 — without
  // scope, arbitrary matches when a case's planType flipped after an
  // earlier extraction seeded a different template set. Orphan rows
  // are treated as "field-not-found" here; the extract-submit route
  // logs one CHECKLIST_TEMPLATE_MISMATCH_DETECTED audit per run to
  // surface the case for admin repair.
  const caseRow = await prisma.case.findUnique({
    where: { id: args.caseId },
    select: { planType: true },
  });
  if (!caseRow) return { outcome: "field-not-found" };
  const field = await prisma.checklistField.findFirst({
    where: {
      caseId: args.caseId,
      template: { fieldKey: args.fieldKey, planType: caseRow.planType },
    },
    include: { template: true },
  });
  if (!field) return { outcome: "field-not-found" };

  // (0) Manual-entry-only guard — some templates are configured so that the
  // AI BFF must never populate them (e.g. DFM Charge, OCF / Transaction
  // Costs). We silently skip — no audit row, no conflict — so re-extraction
  // is safe to run repeatedly without side effects.
  if (field.template.isManualEntryOnly) {
    console.log(
      "[merge-outcome] outcome=skipped-manual-only case=%s field=%s job=%s doc=%s",
      args.caseId,
      args.fieldKey,
      args.jobId,
      args.documentId,
    );
    return { outcome: "skipped-manual-only", fieldId: field.id };
  }

  // (1) Preservation guard — never stomp CA-Team edits or adviser approvals.
  if (field.isApproved || field.isManuallyOverridden) {
    console.log(
      "[merge-outcome] outcome=preserved case=%s field=%s job=%s doc=%s",
      args.caseId,
      args.fieldKey,
      args.jobId,
      args.documentId,
    );
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
    console.log(
      "[merge-outcome] outcome=no-overwrite-missing case=%s field=%s job=%s doc=%s",
      args.caseId,
      args.fieldKey,
      args.jobId,
      args.documentId,
    );
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
    console.log(
      "[merge-outcome] outcome=conflict case=%s field=%s job=%s doc=%s existingLen=%s incomingLen=%s",
      args.caseId,
      args.fieldKey,
      args.jobId,
      args.documentId,
      field.value === null ? "null" : String(field.value.length),
      newValueStr === null ? "null" : String(newValueStr.length),
    );
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

  // Verify the source document still exists. The BFF can deliver a write-back
  // for an extraction whose source Document was hard-deleted between job
  // submission and completion (user-driven delete, retry-upload pattern,
  // or any race). Postgres enforces the FK at write-time and rejects with
  // P2003, which previously crashed the Node process — observed on
  // 2026-06-10 as a 13-restart loop on rev 0000022. We persist the
  // extracted value WITHOUT the dangling FK rather than throwing. The
  // field loses its "Jump to source PDF" linkage but keeps the value,
  // which is more useful than crashing the whole backend.
  //
  // The findUnique tolerates any string id — non-existent ids return
  // null, not an error. args.documentId is typed `string` (not nullable),
  // so we don't need a null guard here; if a caller ever violates the
  // type contract, the route-level try/catch on the BFF write-back will
  // contain the failure.
  // Widened to also pull the filename — needed for the sourceDocumentName
  // snapshot (S5 / Decision 6 step 2) so the audit trail survives FK SET NULL
  // on doc delete. Piggybacks the existing FK-validity round-trip; no extra
  // query.
  const sourceDoc = await prisma.document.findUnique({
    where: { id: args.documentId },
    select: { id: true, originalName: true, filename: true },
  });
  const safeSourceDocumentId = sourceDoc ? args.documentId : null;
  const safeSourceDocumentName = sourceDoc
    ? (sourceDoc.originalName ?? sourceDoc.filename ?? null)
    : null;
  if (!sourceDoc) {
    console.warn(
      "[applyFieldExtraction] source document not found — writing field value without sourceDocumentId. case=%s field=%s job=%s requestedDocId=%s",
      args.caseId,
      args.fieldKey,
      args.jobId,
      args.documentId,
    );
  }

  const oldValue = field.value;
  await prisma.checklistField.update({
    where: { id: field.id },
    data: {
      value: newValueStr,
      aiRawValue: rawValueStr,
      confidence: effectiveConfidence,
      status: "AI_EXTRACTED",
      sourceDocumentId: safeSourceDocumentId,
      sourceDocumentName: safeSourceDocumentName,
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
  console.log(
    "[merge-outcome] outcome=applied case=%s field=%s job=%s doc=%s existingLen=%s incomingLen=%s",
    args.caseId,
    args.fieldKey,
    args.jobId,
    args.documentId,
    oldValue === null ? "null" : String(oldValue.length),
    newValueStr === null ? "null" : String(newValueStr.length),
  );
  return { outcome: "applied", fieldId: field.id };
}

// H33 piece 1b: derive the reviewer-visible detection-notes payload
// from the pipeline's response.detection object.
//
// Returns null in two cases:
//   1. The BFF sent no detection object (old case-extractions doc from
//      before piece 1b shipped). Backward-compat: treat as happy path.
//   2. Neither provider nor plan_type detection failed. Nothing worth
//      surfacing to the reviewer — no banner should render.
//
// When either failed, returns the full object verbatim so the frontend
// can render whichever variant of the banner is appropriate (provider
// only / plan_type only / both). The shape is preserved end-to-end so
// piece 5's block fields slot in additively without a migration.
function buildAiExtractionNotes(
  result: BffJobResult
): BffJobResult["response"]["detection"] | null {
  const detection = result.response.detection;
  if (!detection) return null;
  if (!detection.provider.failed && !detection.planType.failed) {
    // Happy-path outcome — nothing to surface to the reviewer.
    return null;
  }
  return detection;
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

  // Fund Details table — shared helper so the doc-status PATCH push path
  // can persist atomically inside the SAME $transaction that flips
  // aiJobCompletedAt. Both paths produce byte-identical writes.
  await applyFundLines({
    caseId: doc.caseId,
    documentId,
    jobId: result.jobId,
    fundLines: result.response.fundLines,
  });

  // Pension contributions — same helper the PATCH push path uses. LOAD-
  // BEARING on the pull path today because H16 leaves COLLEAGUE_BACKEND_URL
  // unset on the prodai apps, so the poller is the ONLY functioning write-
  // back path in production. Wiring only the push path would produce the
  // exact H21 shape we're avoiding: pipeline emits, backend accepts on
  // paper, prod silently drops. Both paths carry the same shape so a
  // future H16 fix doesn't require touching this call site.
  await applyContributionTransactions({
    caseId: doc.caseId,
    documentId,
    jobId: result.jobId,
    // Wire keeps date as YYYY-MM-DD string (matches completedAt precedent);
    // convert to Date here at the persistence boundary.
    transactions: result.response.contributionTransactions.map((c) => ({
      type: c.type,
      taxYearLabel: c.taxYearLabel,
      date: c.date ? new Date(c.date) : null,
      amount: c.amount,
      description: c.description,
      sourcePage: c.sourcePage,
      sourceRef: c.sourceRef,
      confidence: c.confidence,
    })),
    totals: result.response.contributionTotals,
  });

  const submittedAt = doc.aiJobSubmittedAt ?? doc.uploadedAt;
  const elapsedMs = Date.now() - submittedAt.getTime();

  // H33 piece 1b: derive the reviewer-visible notes payload from the
  // pipeline's detection outcome. Null (old case-extractions docs
  // predating piece 1b) or a happy-path outcome (neither provider nor
  // plan_type failed) writes NULL so the frontend renders no banner.
  // Only fallback-fired jobs land a non-null value here.
  const aiExtractionNotes = buildAiExtractionNotes(result);

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
      aiExtractionNotes:
        aiExtractionNotes === null
          ? Prisma.DbNull
          : // DetectionOutcome is a plain data shape; the cast is safe.
            // Prisma's InputJsonValue requires an index signature that
            // our named interfaces don't declare — same pattern used
            // elsewhere in this file for auditLog metadata.
            (aiExtractionNotes as unknown as Prisma.InputJsonValue),
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
        promptTemplateId: result.promptTemplateId ?? null,
      } as Prisma.InputJsonValue,
    },
  });

  return { outcome: "applied" };
}

// ── ChecklistFundLine persistence — shared by push + pull paths ─────────────
//
// Called from BOTH:
//   - applyExtractionResult (poller / PULL path) — passes no tx; uses prisma.
//   - PATCH /api/documents/:id (BFF doc-status PUSH path) — passes tx so the
//     fund-line writes happen inside the SAME prisma.$transaction as the
//     document.update that flips aiJobCompletedAt. If applyFundLines throws,
//     the whole tx rolls back, aiJobCompletedAt is NOT set, and the poller
//     later picks the doc up and runs the SAME helper via the pull path —
//     self-healing.
//
// Behavior contract (must match the pre-refactor inline block byte-for-byte
// when called without a tx):
//   - No-op when fundLines is empty / undefined.
//   - Looks up the case row to get planType (required column on
//     checklist_fund_lines).
//   - No-op if the case row is missing.
//   - Deletes ONLY prior AI_EXTRACTED rows for THIS sourceDocumentId — manual
//     rows (MANUALLY_ENTERED / OVERRIDDEN) are preserved, rows from OTHER
//     documents on the same case are preserved.
//   - Inserts one row per fund_lines entry: fundName, isinSedolCiti (ISIN
//     preferred, SEDOL fallback), numberOfUnits, pricePerUnit, value (from
//     valueGbp), isWithProfits, honest per-row confidence (MISSING fallback),
//     sourceDocumentId, displayOrder=idx, status=AI_EXTRACTED.
//   - OCF and Transaction Costs are manual-entry only and intentionally NOT
//     populated by AI — they are left null on AI-inserted rows.
//   - Writes one FUND_LINE_ADDED audit log entry (count = rows inserted).
//
// `fundLines` accepts the BffJobResult.response.fundLines shape (camelCase,
// 9 fields). Callers that have snake_case wire data must map first.
type FundLinesTx = Pick<
  PrismaClient,
  "case" | "checklistFundLine" | "auditLog"
> | Prisma.TransactionClient;

export interface ApplyFundLinesArgs {
  caseId: string;
  documentId: string;
  jobId: string;
  fundLines: BffJobResult["response"]["fundLines"] | undefined | null;
  /** Optional transaction client. Falls back to the module-level prisma. */
  tx?: FundLinesTx;
}

export async function applyFundLines(
  args: ApplyFundLinesArgs
): Promise<{ count: number }> {
  const client: FundLinesTx = args.tx ?? prisma;
  const fundLines = args.fundLines;
  if (!Array.isArray(fundLines) || fundLines.length === 0) {
    return { count: 0 };
  }

  const caseRow = await client.case.findUnique({
    where: { id: args.caseId },
    select: { id: true, planType: true },
  });
  if (!caseRow) return { count: 0 };

  // Delete prior AI rows for this document so re-extraction doesn't pile up.
  await client.checklistFundLine.deleteMany({
    where: {
      caseId: caseRow.id,
      sourceDocumentId: args.documentId,
      status: { in: ["AI_EXTRACTED"] },
    },
  });
  await client.checklistFundLine.createMany({
    data: fundLines.map((f, idx) => ({
      caseId: caseRow.id,
      planType: caseRow.planType,
      fundName: f.fundName || `Fund ${idx + 1}`,
      // isin and sedol arrive as separate fields from the BFF; the Prisma
      // column collapses them into one TEXT (isinSedolCiti). Prefer ISIN
      // when present (more specific), fall back to SEDOL.
      isinSedolCiti: f.isin ?? f.sedol ?? null,
      numberOfUnits:
        f.numberOfUnits != null ? new Prisma.Decimal(f.numberOfUnits) : null,
      pricePerUnit:
        f.pricePerUnit != null ? new Prisma.Decimal(f.pricePerUnit) : null,
      value: f.valueGbp != null ? new Prisma.Decimal(f.valueGbp) : null,
      // OCF and Transaction Costs are intentionally NOT set here — they are
      // manual-entry-only columns and the AI BFF never supplies them.
      isWithProfits: f.isWithProfits ?? false,
      // Honest per-row confidence from the LLM. Falls back to MISSING if
      // the BFF omitted it — never invent HIGH.
      confidence: f.confidence ?? "MISSING",
      sourceDocumentId: args.documentId,
      displayOrder: idx,
      status: "AI_EXTRACTED",
    })),
  });
  await client.auditLog.create({
    data: {
      caseId: caseRow.id,
      userId: SYSTEM_USER_ID,
      action: "FUND_LINE_ADDED",
      source: "AI",
      newValue: `${fundLines.length} fund rows extracted`,
      metadata: {
        jobId: args.jobId,
        documentId: args.documentId,
        count: fundLines.length,
      } as Prisma.InputJsonValue,
    },
  });

  return { count: fundLines.length };
}

// ── ChecklistContribution + ContributionTransaction persistence ─────────────
//
// Called from BOTH the PATCH /api/documents/:id push path AND the poller's
// applyExtractionResult pull path (same shape, one helper). Pull-path
// coverage is LOAD-BEARING in production: H16 leaves COLLEAGUE_BACKEND_URL
// unset on the prodai apps so the BFF cannot push, and the poller is the
// only functioning write-back today. If we shipped push-only, contributions
// would emit from the pipeline and never reach Postgres — the exact H21
// shape (silent-drop between contract layers) we're building this to avoid.
//
// Contract:
//   - No-op when BOTH transactions and totals are empty / missing.
//   - Upserts ChecklistContribution parents from totals[] keyed on
//     (caseId, position). taxYearLabel is CREATE-only; a re-extraction
//     does NOT overwrite a CA relabel. AI totals are written on both
//     CREATE and UPDATE.
//   - Supersedes (stamps supersededAt=now) any non-superseded AI rows
//     previously inserted from THIS sourceDocumentId. MANUAL rows are
//     never touched. Matches the schema.prisma header comment on
//     contribution_transactions: "Nothing is deleted."
//   - Resolves each transaction to a parent row: primary by taxYearLabel
//     string match against DB; fallback via the pipeline's own
//     (taxYearLabel → position) map so a CA relabel does not strand
//     the new children. No-parent transactions are counted-and-skipped.
//   - Per (parentId, type) cell, if any non-superseded MANUAL child
//     exists the CA owns that cell — SKIP inserting AI children into
//     it. The parent's *AiTotal is still written (forensics record;
//     see schema.prisma:employerAiTotal comment — FH-2026-000188). PR3
//     decides whether a manually-owned cell renders a conflict marker.
//   - Inserts surviving transactions as source='AI' with documentId,
//     sourcePage, sourceRef populated.
//   - Writes ONE audit row per batch — action CONTRIBUTION_TRANSACTION_ADDED
//     (enum reused; the manual path uses the same action with
//     source='MANUAL'), source='AI', metadata carries counts AND the
//     list of skipped cells so the trail records WHICH cells were held
//     back by manual ownership, not just how many. Row-level audit is
//     intentionally omitted for parity with applyFundLines's batch audit
//     — same asymmetry-with-manual-path exists there.
type ContributionsTx = Pick<
  PrismaClient,
  "checklistContribution" | "contributionTransaction" | "auditLog"
> | Prisma.TransactionClient;

export interface WireContributionTransaction {
  type: "EMPLOYER" | "PERSONAL";
  taxYearLabel: string;
  /** Nullable — a total-without-breakdown synthetic row carries no date. */
  date: Date | null;
  amount: number;
  description: string;
  sourcePage?: number | null;
  sourceRef?: string | null;
  /** Accepted from the pipeline but not persisted today — no column exists
   *  on ContributionTransaction. Reserved for a future migration; keeping
   *  it in the interface avoids a signature churn when that lands. */
  confidence?: string | null;
}

export interface WireContributionTotal {
  position: number;
  taxYearLabel: string;
  employerAiTotal: number | null;
  personalAiTotal: number | null;
}

export interface ApplyContributionsArgs {
  caseId: string;
  documentId: string;
  jobId: string;
  transactions?: WireContributionTransaction[] | null;
  totals?: WireContributionTotal[] | null;
  /** Optional transaction client. Falls back to the module-level prisma. */
  tx?: ContributionsTx;
}

export interface ApplyContributionsResult {
  parentsUpserted: number;
  supersededPriorAiCount: number;
  transactionsInserted: number;
  cellsSkippedManuallyOwned: number;
  transactionsSkippedNoParent: number;
}

export async function applyContributionTransactions(
  args: ApplyContributionsArgs,
): Promise<ApplyContributionsResult> {
  const client: ContributionsTx = args.tx ?? prisma;
  const totals = args.totals ?? [];
  const txs = args.transactions ?? [];
  const empty: ApplyContributionsResult = {
    parentsUpserted: 0,
    supersededPriorAiCount: 0,
    transactionsInserted: 0,
    cellsSkippedManuallyOwned: 0,
    transactionsSkippedNoParent: 0,
  };
  if (totals.length === 0 && txs.length === 0) return empty;

  // (1) Upsert parents. taxYearLabel is CREATE-only (preserves CA relabel).
  for (const t of totals) {
    await client.checklistContribution.upsert({
      where: { caseId_position: { caseId: args.caseId, position: t.position } },
      create: {
        caseId: args.caseId,
        position: t.position,
        taxYearLabel: t.taxYearLabel,
        employerAiTotal:
          t.employerAiTotal != null ? new Prisma.Decimal(t.employerAiTotal) : null,
        personalAiTotal:
          t.personalAiTotal != null ? new Prisma.Decimal(t.personalAiTotal) : null,
      },
      update: {
        // taxYearLabel intentionally omitted — a CA edit is authoritative.
        employerAiTotal:
          t.employerAiTotal != null ? new Prisma.Decimal(t.employerAiTotal) : null,
        personalAiTotal:
          t.personalAiTotal != null ? new Prisma.Decimal(t.personalAiTotal) : null,
      },
    });
  }

  // (2) Supersede prior AI rows from THIS document. Idempotent.
  const superseded = await client.contributionTransaction.updateMany({
    where: {
      documentId: args.documentId,
      source: "AI",
      supersededAt: null,
    },
    data: { supersededAt: new Date() },
  });

  // (3) Read parents once; build lookup maps.
  const parents = await client.checklistContribution.findMany({
    where: { caseId: args.caseId },
    select: { id: true, position: true, taxYearLabel: true },
  });
  const parentByLabel = new Map<string, { id: string; position: number }>();
  const parentByPosition = new Map<number, { id: string; taxYearLabel: string }>();
  for (const p of parents) {
    parentByLabel.set(p.taxYearLabel, { id: p.id, position: p.position });
    parentByPosition.set(p.position, { id: p.id, taxYearLabel: p.taxYearLabel });
  }
  const pipelineLabelToPosition = new Map<string, number>();
  for (const t of totals) pipelineLabelToPosition.set(t.taxYearLabel, t.position);

  const resolveParentId = (label: string): string | null => {
    const direct = parentByLabel.get(label);
    if (direct) return direct.id;
    const pos = pipelineLabelToPosition.get(label);
    if (pos != null) {
      const fallback = parentByPosition.get(pos);
      if (fallback) return fallback.id;
    }
    return null;
  };

  // (4) Identify manually-owned (parentId, type) cells. Single bulk read.
  const manuallyOwned = await client.contributionTransaction.findMany({
    where: {
      contribution: { caseId: args.caseId },
      source: "MANUAL",
      supersededAt: null,
    },
    select: { contributionId: true, type: true },
  });
  const manualCells = new Set<string>(
    manuallyOwned.map((r) => `${r.contributionId}::${r.type}`),
  );

  // (5) Insert AI rows, skipping manually-owned cells and no-parent txs.
  const rowsToInsert: Prisma.ContributionTransactionCreateManyInput[] = [];
  const skippedCells = new Set<string>();
  let noParentCount = 0;
  for (const t of txs) {
    const parentId = resolveParentId(t.taxYearLabel);
    if (!parentId) {
      noParentCount += 1;
      continue;
    }
    const cellKey = `${parentId}::${t.type}`;
    if (manualCells.has(cellKey)) {
      skippedCells.add(cellKey);
      continue;
    }
    rowsToInsert.push({
      contributionId: parentId,
      type: t.type,
      date: t.date,
      amount: new Prisma.Decimal(t.amount),
      description: t.description,
      documentId: args.documentId,
      sourcePage: t.sourcePage ?? null,
      sourceRef: t.sourceRef ?? null,
      source: "AI",
    });
  }
  if (rowsToInsert.length > 0) {
    await client.contributionTransaction.createMany({ data: rowsToInsert });
  }

  const result: ApplyContributionsResult = {
    parentsUpserted: totals.length,
    supersededPriorAiCount: superseded.count,
    transactionsInserted: rowsToInsert.length,
    cellsSkippedManuallyOwned: skippedCells.size,
    transactionsSkippedNoParent: noParentCount,
  };

  await client.auditLog.create({
    data: {
      caseId: args.caseId,
      userId: SYSTEM_USER_ID,
      action: "CONTRIBUTION_TRANSACTION_ADDED",
      source: "AI",
      newValue:
        `${result.transactionsInserted} contribution rows extracted ` +
        `(${result.cellsSkippedManuallyOwned} cell(s) preserved as manual)`,
      metadata: {
        jobId: args.jobId,
        documentId: args.documentId,
        parentsUpserted: result.parentsUpserted,
        supersededPriorAiCount: result.supersededPriorAiCount,
        transactionsInserted: result.transactionsInserted,
        cellsSkippedManuallyOwned: result.cellsSkippedManuallyOwned,
        transactionsSkippedNoParent: result.transactionsSkippedNoParent,
        skippedCells: Array.from(skippedCells).map((k) => {
          const [contributionId, type] = k.split("::");
          return { contributionId, type };
        }),
      } as Prisma.InputJsonValue,
    },
  });

  return result;
}
