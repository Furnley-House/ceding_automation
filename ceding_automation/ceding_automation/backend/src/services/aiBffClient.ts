// backend/src/services/aiBffClient.ts
// HTTP client for the deployed Ceding AI BFF.
// Contract: docs/ai-integration-design.md §5(a) and project-context BFF API Contract.
// BFF speaks snake_case; we convert at the boundary so the rest of the backend stays camelCase.

import axios, { AxiosInstance } from "axios";
import { PlanType } from "@prisma/client";

const BFF_BASE_URL = process.env.BFF_BASE_URL ?? "";
const BFF_SHARED_SECRET = process.env.BFF_SHARED_SECRET ?? "";

export function isBffConfigured(): boolean {
  return BFF_BASE_URL.length > 0 && BFF_SHARED_SECRET.length > 0;
}

// Lazily constructed axios instance. We avoid module-load construction so importing
// this module in a test or unconfigured environment doesn't crash.
let cachedClient: AxiosInstance | null = null;
function getClient(): AxiosInstance {
  if (cachedClient) return cachedClient;
  if (!isBffConfigured()) {
    throw new Error(
      "BFF not configured: set BFF_BASE_URL and BFF_SHARED_SECRET in env"
    );
  }
  cachedClient = axios.create({
    baseURL: BFF_BASE_URL,
    headers: { "X-API-Key": BFF_SHARED_SECRET },
    timeout: 10_000,
  });
  console.log(`[aiBffClient] configured for ${BFF_BASE_URL}`);
  return cachedClient;
}

// ── Errors ─────────────────────────────────────────────────────────────────
// Preserve jobId where applicable so callers can correlate failures.

export class BffAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BffAuthError";
  }
}

export class BffJobNotFoundError extends Error {
  constructor(public readonly jobId: string) {
    super(`BFF job not found: ${jobId}`);
    this.name = "BffJobNotFoundError";
  }
}

export class BffServerError extends Error {
  constructor(
    public readonly jobId: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "BffServerError";
  }
}

function mapAxiosError(jobId: string | undefined, err: unknown): never {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as Record<string, unknown> | undefined;
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : err.message;
    if (status === 401 || status === 403) throw new BffAuthError(message);
    if (status === 404) throw new BffJobNotFoundError(jobId ?? "<unknown>");
    if (typeof status === "number" && status >= 500)
      throw new BffServerError(jobId, message);
    throw new BffServerError(
      jobId,
      `BFF request failed (${status ?? "no status"}): ${message}`
    );
  }
  throw err instanceof Error ? err : new Error(String(err));
}

// ── Types ──────────────────────────────────────────────────────────────────

export type BffPlanType = "ISA" | "GIA" | "Pension" | "Bond";
export type BffConfidence = "HIGH" | "MEDIUM" | "LOW" | "MISSING";
export type BffJobState = "queued" | "processing" | "completed" | "failed";
export type BffStage = "stage1" | "stage2" | "stage3" | "stage4" | "done";

export interface SubmitExtractionInput {
  storagePath: string; // Relative blob path; BFF resolves via managed identity.
  caseId: string;
  documentId: string;
  planType: BffPlanType;
  providerName?: string;
  policyRef?: string;
  checklistFields: Array<{ fieldKey: string; required: boolean }>;
}

export interface SubmitExtractionResult {
  jobId: string;
  status: "queued";
  submittedAt: string;
}

export interface BffJobStatus {
  jobId: string;
  status: BffJobState;
  stage?: BffStage;
  progressPct?: number;
  caseId: string;
  documentId: string;
}

export interface BffExtractedField {
  fieldKey: string;
  value: string | number | null;
  rawValue: string | null;
  confidence: BffConfidence;
  sourcePage: number | null;
  sourceQuote: string | null;
  reasoning: string | null;
}

export interface BffJobResult {
  jobId: string;
  caseId: string;
  documentId: string;
  status: "COMPLETE" | "EXTRACTED_WITH_WARNINGS";
  response: {
    detectedProvider: { name: string; canonical: string; confidence: string };
    detectedPlanType: string;
    fields: BffExtractedField[];
    fundLines: Array<{
      fundName: string;
      units: number;
      price: number;
      value: number;
    }>;
    withProfits: unknown;
    summary: {
      fieldsExtracted: number;
      fieldsMissing: number;
      highConfidenceCount: number;
    };
  };
  llmCallMeta: { totalTokens: number; totalCostUsd: number };
  completedAt: string;
}

// Phase-1 plan types map cleanly to BFF vocabulary. Phase-2 ones (FINAL_SALARY,
// PROTECTION) are not supported by the BFF and must throw loudly here rather
// than send a value the BFF will reject with 400.
export function mapPlanTypeToBff(planType: PlanType): BffPlanType {
  switch (planType) {
    case "ISA":
      return "ISA";
    case "GIA":
      return "GIA";
    case "PENSION":
      return "Pension";
    case "BOND":
      return "Bond";
    case "FINAL_SALARY":
    case "PROTECTION":
      throw new Error(
        `Plan type ${planType} is not yet supported by the AI BFF (Phase 2)`
      );
  }
}

// ── API calls ──────────────────────────────────────────────────────────────

export async function submitExtractionJob(
  input: SubmitExtractionInput
): Promise<SubmitExtractionResult> {
  try {
    const { data } = await getClient().post<{
      job_id: string;
      status: "queued";
      submitted_at: string;
    }>("/api/v1/extract", {
      storage_path: input.storagePath,
      case_id: input.caseId,
      document_id: input.documentId,
      plan_type: input.planType,
      provider_name: input.providerName,
      policy_ref: input.policyRef,
      checklist_fields: input.checklistFields.map((f) => ({
        field_key: f.fieldKey,
        required: f.required,
      })),
    });
    return {
      jobId: data.job_id,
      status: data.status,
      submittedAt: data.submitted_at,
    };
  } catch (err) {
    mapAxiosError(undefined, err);
  }
}

export async function getJobStatus(jobId: string): Promise<BffJobStatus> {
  try {
    const { data } = await getClient().get<{
      job_id: string;
      status: BffJobState;
      stage?: BffStage;
      progress_pct?: number;
      case_id: string;
      document_id: string;
    }>(`/api/v1/extract/${encodeURIComponent(jobId)}/status`);
    return {
      jobId: data.job_id,
      status: data.status,
      stage: data.stage,
      progressPct: data.progress_pct,
      caseId: data.case_id,
      documentId: data.document_id,
    };
  } catch (err) {
    mapAxiosError(jobId, err);
  }
}

interface RawBffResult {
  job_id: string;
  case_id: string;
  document_id: string;
  status: "COMPLETE" | "EXTRACTED_WITH_WARNINGS";
  response?: {
    detected_provider?: { name?: string; canonical?: string; confidence?: string };
    detected_plan_type?: string;
    fields?: Array<{
      field_key: string;
      value: string | number | null;
      raw_value: string | null;
      confidence: BffConfidence;
      source_page: number | null;
      source_quote: string | null;
      reasoning: string | null;
    }>;
    fund_lines?: Array<{
      fund_name: string;
      units: number;
      price: number;
      value: number;
    }>;
    with_profits?: unknown;
    summary?: {
      fields_extracted?: number;
      fields_missing?: number;
      high_confidence_count?: number;
    };
  };
  llm_call_meta?: { total_tokens?: number; total_cost_usd?: number };
  completed_at: string;
}

export async function getJobResult(jobId: string): Promise<BffJobResult> {
  try {
    const { data } = await getClient().get<RawBffResult>(
      `/api/v1/extract/${encodeURIComponent(jobId)}/result`
    );
    return {
      jobId: data.job_id,
      caseId: data.case_id,
      documentId: data.document_id,
      status: data.status,
      response: {
        detectedProvider: {
          name: data.response?.detected_provider?.name ?? "",
          canonical: data.response?.detected_provider?.canonical ?? "",
          confidence: data.response?.detected_provider?.confidence ?? "",
        },
        detectedPlanType: data.response?.detected_plan_type ?? "",
        fields: (data.response?.fields ?? []).map((f) => ({
          fieldKey: f.field_key,
          value: f.value,
          rawValue: f.raw_value,
          confidence: f.confidence,
          sourcePage: f.source_page,
          sourceQuote: f.source_quote,
          reasoning: f.reasoning,
        })),
        fundLines: (data.response?.fund_lines ?? []).map((f) => ({
          fundName: f.fund_name,
          units: f.units,
          price: f.price,
          value: f.value,
        })),
        withProfits: data.response?.with_profits ?? null,
        summary: {
          fieldsExtracted: data.response?.summary?.fields_extracted ?? 0,
          fieldsMissing: data.response?.summary?.fields_missing ?? 0,
          highConfidenceCount:
            data.response?.summary?.high_confidence_count ?? 0,
        },
      },
      llmCallMeta: {
        totalTokens: data.llm_call_meta?.total_tokens ?? 0,
        totalCostUsd: data.llm_call_meta?.total_cost_usd ?? 0,
      },
      completedAt: data.completed_at,
    };
  } catch (err) {
    mapAxiosError(jobId, err);
  }
}
