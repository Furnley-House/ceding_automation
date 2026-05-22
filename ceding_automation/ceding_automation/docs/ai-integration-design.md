# AI Integration Design — BFF Write-back + Polling

> Branch: `feature/ai-bff-integration` (off `develop`)
> Status: **DRAFT — design pass only, no code yet**
> Author: Claude (Sonnet 4.6) for Nishant R
> Date: 2026-05-22
> Sprint mapping: Sprint 2 / Branch B2 in `project-context/sprint-plan-draft.md`

---

## 1. Summary

- **Replace direct Azure OpenAI calls with HTTP integration to the deployed BFF** at `https://ca-cedingai-api-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io`. `services/aiExtraction.ts` becomes `services/aiBffClient.ts`; the OpenAI SDK is removed from this repo. This matches Sprint-plan branch B2 ("Backend swap aiExtraction.ts → Azure OpenAI proxy").
- **Shift from in-process fire-and-forget to job-based async with write-back + polling fallback.** BFF latency is 50–90s (longer than any single Express request budget). Backend submits, persists the BFF `job_id` on `Document`, and accepts results via two write-back endpoints. A background poller catches missed write-backs.
- **Frontend gets live progress without manual refresh.** A new `useExtractionStatus` hook polls `GET /cases/:caseId/documents/:docId/ai-status` every 3s while extraction is in flight, mirroring the existing ring-out polling pattern in `CallWorkspace.tsx`.

---

## 2. Architecture diagram

```
┌─────────────────┐
│  Frontend (FE)  │
│  React/Vite     │
└────────┬────────┘
         │ (1) POST /cases/:id/documents   (multipart upload)
         ▼
┌────────────────────────────────────────────────────────────────────┐
│  Backend (Express + Prisma)                                        │
│                                                                    │
│  routes/documents.ts                                               │
│  ├─ (2a) writes Document row, status=UPLOADED                      │
│  ├─ (2b) services/aiBffClient.submitExtractionJob(...)             │
│  │       (passes relative blob path; BFF resolves via              │
│  │        its own managed identity on stcedingaistaging)           │
│  │                                                                 │
│  │       POST /api/v1/extract                                      │
│  │       X-API-Key: BFF_SHARED_SECRET                              │
│  │       ───────────────────────────────────────┐                  │
│  │                                              │                  │
│  │       202 ← { job_id, status: "queued" }     │                  │
│  │       ◄───────────────────────────────────┐  │                  │
│  │                                           │  │                  │
│  ├─ (2c) persist job_id on Document          │  │                  │
│  │       Document.status=PROCESSING          │  │                  │
│  │       aiJobStatus="queued"                │  │                  │
│  │       aiJobSubmittedAt=now()              │  │                  │
│  │                                           │  │                  │
│  └─ (2d) respond 201 to FE                   │  │                  │
│                                              │  │                  │
│  ── Two paths for receiving results ──       │  │                  │
│                                              │  │                  │
│  PATH A — write-back (primary)               │  │                  │
│  ─────────────────────────────────────       │  │                  │
│  middleware/internalKey requires X-Internal-Key                    │
│                                              │  │                  │
│  PATCH /api/documents/:docId  ◄──────────────┘  │                  │
│  PATCH /api/cases/:cid/checklist/:fid/ai-extract◄ (one per field)  │
│    ↓                                                               │
│    Updates ChecklistField + Document, writes AuditLog              │
│                                                                    │
│  PATH B — polling fallback                                         │
│  ─────────────────────────────────                                 │
│  services/aiBffPoller.ts (setInterval every 10s)                   │
│    ↓ scans Document WHERE aiJobStatus IN (queued,processing)       │
│    ↓ AND aiJobLastPolledAt < now-30s                               │
│    ↓                                                               │
│    GET /api/v1/extract/{job_id}/status                             │
│    GET /api/v1/extract/{job_id}/result  (when status=completed)    │
│    ↓                                                               │
│    Applies same write-back logic if completion not yet recorded    │
│    (idempotent guard via aiJobCompletedAt)                         │
│                                                                    │
└────────────┬───────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│  PostgreSQL                                                     │
│  - Document: aiJobId, aiJobStatus, aiJobStage, aiJobProgress,   │
│              aiJobCompletedAt, aiJobLastPolledAt, ...           │
│  - ChecklistField: value, confidence, source*, aiJobId,         │
│                    aiExtractedAt                                │
│  - AuditLog: FIELD_EXTRACTED + AI_EXTRACTION_RUN entries        │
└─────────────────────────────────────────────────────────────────┘
             ▲
             │ reads
             │
┌────────────┴────────────┐
│  Frontend (FE)          │
│                         │
│  useExtractionStatus    │  poll GET /cases/:id/documents/:id/ai-status
│  every 3s while status  │  every 3s; stops on completed|failed
│  in {queued,processing} │
│      ↓                  │
│  On completion:         │
│  useChecklistFields     │  one GET /cases/:id/checklist refresh
│  .refresh()             │  → fields appear in ChecklistPanel
└─────────────────────────┘
```

**Time budget per upload:** 0s submit → 1s BFF ack → 50–90s processing → write-back lands within seconds. Frontend sees `completed` within one 3s poll cycle of write-back.

---

## 3. Schema changes (Prisma diff)

Additive only — every column nullable, no defaults that would force backfill. Safe to deploy ahead of code changes.

### `Document` (table `documents`)

```diff
 model Document {
   id     String @id @default(cuid())
   caseId String
   case   Case   @relation(fields: [caseId], references: [id], onDelete: Cascade)

   filename      String
   originalName  String
   mimeType      String
   fileSizeBytes Int
   storagePath   String
   storageUrl    String?

   status       DocumentStatus @default(UPLOADED)
   uploadedAt   DateTime       @default(now())
   processedAt  DateTime?
   errorMessage String?

   pageCount       Int?
   extractionModel String?
   extractionMs    Int?

+  // ── BFF integration ──────────────────────────────────────
+  aiJobId           String?    // BFF identifier, format "bff-<8-char-hex>"
+  aiJobStatus       String?    // "queued" | "processing" | "completed" | "failed" (mirrors BFF /status)
+  aiJobStage        String?    // "stage1" | "stage2" | "stage3" | "stage4" | "done"
+  aiJobProgress     Int?       // 0-100, last seen from BFF
+  aiJobSubmittedAt  DateTime?  // when backend POSTed to BFF /extract
+  aiJobCompletedAt  DateTime?  // when terminal state observed (write-back or polling)
+  aiJobLastPolledAt DateTime?  // last successful GET to BFF /status — drives polling cadence
+  aiJobError        String?    // BFF error message when status=failed
+  aiJobCostUsd      Decimal?   @db.Decimal(10, 6)  // llm_call_meta.total_cost_usd
+  aiJobTokens       Int?       // llm_call_meta.total_tokens

   checklistFields ChecklistField[]    @relation("FieldSourceDocument")
   fundLines       ChecklistFundLine[] @relation("FundLineSourceDocument")

   @@index([caseId])
+  @@index([aiJobStatus, aiJobLastPolledAt])  // for polling worker scan
+  @@index([aiJobId])                         // for write-back lookups
   @@map("documents")
 }
```

| Column | Rationale |
|---|---|
| `aiJobId` | Primary key on the BFF side; we store it so write-back endpoints can locate the document, and so the polling worker can call `GET /extract/{job_id}/status`. |
| `aiJobStatus` | Mirrors the four BFF states verbatim. Kept as String (not enum) to absorb any BFF-side additions without a migration. |
| `aiJobStage` / `aiJobProgress` | Surface BFF pipeline progress (stage1..stage4 + 0–100%) to the frontend so the user sees forward motion during the ~60s wait. |
| `aiJobSubmittedAt` | Used by polling worker to skip very-fresh jobs (avoid hammering the BFF in the first 30s when write-back is most likely). |
| `aiJobCompletedAt` | **Idempotency guard.** Both write-back and polling can settle a job; whichever lands first sets this. The other path's update is filtered by `WHERE aiJobCompletedAt IS NULL`. |
| `aiJobLastPolledAt` | Cadence control for the background poller (only poll if last poll > 30s ago). |
| `aiJobError` | Persist BFF's failure message so it can be shown to CA Team and queried later. |
| `aiJobCostUsd` / `aiJobTokens` | Optional, but cheap to store. Feeds BR-06 KPI dashboard (cost per case / token usage trends). Drop if Nishant prefers a slimmer schema. |
| Index `(aiJobStatus, aiJobLastPolledAt)` | The polling worker's hot query: `WHERE aiJobStatus IN ('queued','processing') AND aiJobLastPolledAt < ...`. Without the index this would full-scan the documents table. |
| Index `(aiJobId)` | Write-back lookups (`Document.findFirst({ where: { aiJobId } })`) need to be O(log n). |

### `ChecklistField` (table `checklist_fields`)

```diff
 model ChecklistField {
   ...
   sourceDocumentId String?
   sourceDocument   Document? @relation("FieldSourceDocument", fields: [sourceDocumentId], references: [id])
   sourcePageNumber Int?
   sourceSection    String?
   sourceQuote      String?

+  // ── BFF integration ──────────────────────────────────────
+  aiJobId        String?    // BFF job that produced this value; useful when sourceDocument
+                            // links to a doc that's since been re-extracted by a later job
+  aiExtractedAt  DateTime?  // when AI last set this field (distinct from updatedAt, which
+                            // ticks on manual edits, approvals, review-requests, etc.)
   ...
 }
```

| Column | Rationale |
|---|---|
| `aiJobId` | We *could* derive "which job set this field" by joining `sourceDocument.aiJobId`, but a re-extraction of the same document overwrites `Document.aiJobId`, losing history. Storing the producing job on the field itself preserves the chain. |
| `aiExtractedAt` | `updatedAt` ticks on every write (manual edit, approval, comment). To answer "when was this last AI-touched?" we need a dedicated column. Used by the UI to render "extracted 30s ago" badges. |

### Seed data

Add a system user for write-back audit rows (referenced in §7):

```diff
 // backend/prisma/seed.ts (sketch)
+const aiSystemUser = await prisma.user.upsert({
+  where: { email: "ai-system@furnleyhouse.internal" },
+  create: {
+    id: "system-ai-bff",               // fixed ID so code can reference it
+    email: "ai-system@furnleyhouse.internal",
+    name: "AI Extraction (system)",
+    role: "ADMIN",                     // narrowest role that passes all requireRole checks
+    status: "ACTIVE",
+  },
+  update: {},
+});
```

`AuditLog.userId` is non-nullable; this row makes write-back audit entries valid without weakening the schema.

---

## 4. New backend endpoints

### (a) `PATCH /api/cases/:caseId/checklist/:fieldId/ai-extract` — BFF write-back, per field

| Aspect | Value |
|---|---|
| Mount | `app.use("/api/cases", checklistRoutes)` (existing); add route inside `routes/checklist.ts` |
| Auth | `requireInternalKey` (no human user — see §7) |
| Caller | BFF, once per field after extraction completes (`fields[]` in BFF /result) |

**Request body (Zod sketch):**

```ts
const aiFieldWriteBackSchema = z.object({
  job_id:        z.string().regex(/^bff-[0-9a-f]{8}$/),
  value:         z.union([z.string(), z.number(), z.null()]),
  raw_value:     z.string().nullable().optional(),
  confidence:    z.enum(["HIGH", "MEDIUM", "LOW", "MISSING"]),
  source_page:   z.number().int().positive().nullable().optional(),
  source_quote:  z.string().max(2000).nullable().optional(),
  reasoning:     z.string().max(2000).nullable().optional(),
  document_id:   z.string(),   // BFF echoes this back; we use it to set sourceDocumentId
});
```

**Response:**

```ts
{ ok: true, fieldId: string, confidence: ConfidenceLevel, hasConflict: boolean }
// 404 if field not found · 409 if field is approved/manually-overridden (we skip, return 409)
// 400 on Zod fail · 401 on bad X-Internal-Key
```

**DB effects (single transaction):**

1. Look up `ChecklistField` by `id = :fieldId` and `caseId = :caseId`. 404 if missing.
2. **Preservation guard:** if `field.isApproved === true` OR `field.isManuallyOverridden === true`, respond 409 and do nothing else. **Critical for not stomping CA Team edits.**
3. If `field.value !== null && field.value !== body.value`:
   - Set `hasConflict = true`, `confidence = "CONFLICT"`, populate `conflictValues = { existing, new, newJobId, newPage }`. Do **not** overwrite `value`.
4. Else: write `value`, `aiRawValue = body.raw_value ?? body.value`, `confidence = body.confidence`, `status = "AI_EXTRACTED"`, `sourceDocumentId = body.document_id`, `sourcePageNumber`, `sourceSection = "BFF"`, `sourceQuote`, `aiJobId = body.job_id`, `aiExtractedAt = now()`.
5. Append one `AuditLog` row: `action = "FIELD_EXTRACTED"`, `source = "AI"`, `userId = "system-ai-bff"`, `fieldKey`, `oldValue`, `newValue`, `metadata = { jobId, documentId, confidence, page, quote, reasoning }`.

### (b) `PATCH /api/documents/:documentId` — BFF write-back, document-level

| Aspect | Value |
|---|---|
| Mount | Add a thin route module `routes/documentsInternal.ts` mounted at `/api/documents` (not `/api/cases/:caseId/documents`) so the BFF doesn't need to know the case ID |
| Auth | `requireInternalKey` |
| Caller | BFF on terminal states (`completed` / `failed`) and on stage progression |

**Request body (Zod sketch):**

```ts
const aiDocWriteBackSchema = z.object({
  job_id:           z.string().regex(/^bff-[0-9a-f]{8}$/),
  status:           z.enum(["queued", "processing", "completed", "failed"]),
  stage:            z.enum(["stage1", "stage2", "stage3", "stage4", "done"]).optional(),
  progress_pct:     z.number().int().min(0).max(100).optional(),
  completed_at:     z.string().datetime().optional(),
  error:            z.string().max(2000).optional(),
  page_count:       z.number().int().positive().optional(),
  detected_provider: z.object({
    name:      z.string(),
    canonical: z.string(),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  }).optional(),
  detected_plan_type: z.string().optional(),
  llm_call_meta: z.object({
    total_tokens:    z.number().int().nonnegative(),
    total_cost_usd:  z.number().nonnegative(),
  }).optional(),
});
```

**Response:**

```ts
{ ok: true, documentId: string, status: DocumentStatus }
// 404 if no document matches the job_id · 401 on bad X-Internal-Key · 400 on Zod fail
```

**DB effects:**

1. `Document.findFirst({ where: { id: :documentId, aiJobId: body.job_id } })`. 404 if missing (defends against stale write-backs).
2. **Idempotency guard:** if `aiJobCompletedAt !== null` AND incoming `status === "completed"`, respond 200 with `{ ok: true, alreadyComplete: true }` — do nothing further. Stops double-application when polling and write-back race.
3. Map BFF status → `DocumentStatus`:
   - `queued` / `processing` → `PROCESSING`
   - `completed` → `EXTRACTED`
   - `failed` → `ERROR`
4. Update `Document` with new state, stage, progress, costs, page count, `aiJobCompletedAt = now()` on terminal states, `processedAt = now()`, `extractionModel = "bff:<job_id>"`, `extractionMs = aiJobCompletedAt - aiJobSubmittedAt`.
5. On `completed`: write one `AuditLog` row, `action = "AI_EXTRACTION_RUN"`, `source = "AI"`, `userId = "system-ai-bff"`, `metadata = { jobId, documentId, costUsd, tokens, detectedProvider, detectedPlanType }`.
6. On `failed`: write `AuditLog` with same action, `oldValue = null`, `newValue = body.error`.

**Note:** per-field writes (4a) and per-document writes (4b) arrive on separate HTTP calls. They are not transactionally linked; either ordering is acceptable. Worst case: a field write-back lands while the document is still `PROCESSING` (harmless — the field row updates, the document flips later).

### (c) `GET /api/cases/:caseId/documents/:documentId/ai-status` — frontend status poll

| Aspect | Value |
|---|---|
| Mount | Add to `routes/documents.ts` |
| Auth | `requireAuth` (any logged-in user) — no role gate; advisers/paraplanners need to see status too |
| Caller | Frontend `useExtractionStatus` hook, every 3s |

**Response:**

```ts
{
  jobId:        string | null,
  status:       "queued" | "processing" | "completed" | "failed" | null,
  stage:        string | null,
  progressPct:  number | null,           // 0–100
  submittedAt:  ISO string | null,
  completedAt:  ISO string | null,
  error:        string | null,
  elapsedMs:    number | null,           // computed: now - submittedAt
}
// 404 if document not found · 401 if not authed
```

**DB effects:** none — pure read of `Document.aiJob*` columns. Sets `Cache-Control: no-store` so the browser cache doesn't interfere with poll freshness.

---

## 5. Modified backend code

### (a) `services/aiExtraction.ts` → `services/aiBffClient.ts`

The Azure OpenAI SDK is no longer imported. New file owns one axios instance + three thin wrappers.

**Function signatures:**

```ts
// services/aiBffClient.ts (sketch — NOT real code)

export interface SubmitExtractionInput {
  storagePath: string;        // Relative blob path, e.g. "cases/{caseId}/{ts}-{name}.pdf".
                              // BFF resolves to stcedingaistaging via its own managed identity
                              // (id-cedingai-staging holds Storage Blob Data Contributor).
  caseId: string;
  documentId: string;
  planType: "ISA" | "GIA" | "Pension" | "Bond";
  providerName?: string;
  policyRef?: string;
  checklistFields: Array<{ fieldKey: string; required: boolean }>;
}

export interface SubmitExtractionResult {
  jobId: string;              // "bff-<8-hex>"
  status: "queued";
  submittedAt: string;
}

export async function submitExtractionJob(
  input: SubmitExtractionInput,
): Promise<SubmitExtractionResult>;

export interface BffJobStatus {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  stage?: "stage1" | "stage2" | "stage3" | "stage4" | "done";
  progressPct?: number;
  caseId: string;
  documentId: string;
}

export async function getJobStatus(jobId: string): Promise<BffJobStatus>;

export interface BffJobResult {
  jobId: string;
  caseId: string;
  documentId: string;
  status: "COMPLETE" | "EXTRACTED_WITH_WARNINGS";
  response: {
    detectedProvider: { name: string; canonical: string; confidence: string };
    detectedPlanType: string;
    fields: Array<{
      fieldKey: string;
      value: string | number | null;
      rawValue: string;
      confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
      sourcePage: number | null;
      sourceQuote: string | null;
      reasoning: string;
    }>;
    fundLines: Array<{ fundName: string; units: number; price: number; value: number }>;
    withProfits: unknown;
    summary: { fieldsExtracted: number; fieldsMissing: number; highConfidenceCount: number };
  };
  llmCallMeta: { totalTokens: number; totalCostUsd: number };
  completedAt: string;
}

export async function getJobResult(jobId: string): Promise<BffJobResult>;

export function isBffConfigured(): boolean;  // true if BFF_BASE_URL + BFF_SHARED_SECRET set
```

**Implementation notes (not code):**
- Single `axios.create({ baseURL: process.env.BFF_BASE_URL, headers: { "X-API-Key": process.env.BFF_SHARED_SECRET }, timeout: 10_000 })`.
- snake_case ↔ camelCase: BFF speaks snake_case; we convert at the boundary so the rest of the backend stays in camelCase.
- Error mapping: 401/403 from BFF → throw `BffAuthError`; 404 (job_id not found) → throw `BffJobNotFoundError`; 500 → throw `BffServerError(jobId, message)`.

### (b) `routes/documents.ts` — upload handler

Pseudocode diff. The upload route's response shape doesn't change; only the internal post-upload action does.

```diff
 router.post(
   "/:caseId/documents",
   requireAuth, requireRole(["CA_TEAM", "ADMIN"]),
   upload.single("file"),
   async (req, res) => {
     ...
     const storagePath = `cases/${caseId}/${Date.now()}-${file.originalname}`;
     await uploadToAzureBlob(storagePath, file.buffer, file.mimetype);

     const doc = await prisma.document.create({
       data: { caseId, filename: storagePath, originalName, mimeType,
               fileSizeBytes, storagePath, status: "UPLOADED" }
     });

     await prisma.auditLog.create({ ... action: "DOCUMENT_UPLOADED" ... });

-    // OLD: in-process Azure OpenAI call, fire-and-forget
-    triggerExtraction(doc.id, caseId, req.user!.id).catch(console.error);
+    if (process.env.AI_VIA_BFF === "true") {
+      // NEW: submit to BFF; result arrives via PATCH write-back OR background poll
+      try {
+        const caseRecord = await prisma.case.findUnique({
+          where: { id: caseId },
+          include: { provider: true, checklistFields: { include: { template: true } } },
+        });
+        // Pass relative blob path. BFF reads via its own managed identity
+        // (id-cedingai-staging → Storage Blob Data Contributor on stcedingaistaging).
+        const submission = await aiBff.submitExtractionJob({
+          storagePath,
+          caseId,
+          documentId: doc.id,
+          planType: mapPlanType(caseRecord!.planType),          // PENSION→Pension etc.
+          providerName: caseRecord?.provider?.name,
+          policyRef: caseRecord?.policyRef ?? undefined,
+          checklistFields: caseRecord!.checklistFields.map(f => ({
+            fieldKey: f.template.fieldKey,
+            required: f.template.isRequired,
+          })),
+        });
+        await prisma.document.update({
+          where: { id: doc.id },
+          data: {
+            status: "PROCESSING",
+            aiJobId: submission.jobId,
+            aiJobStatus: submission.status,            // "queued"
+            aiJobSubmittedAt: new Date(submission.submittedAt),
+            extractionModel: `bff:${submission.jobId}`,
+          },
+        });
+      } catch (err) {
+        await prisma.document.update({
+          where: { id: doc.id },
+          data: { status: "ERROR", errorMessage: (err as Error).message,
+                  aiJobError: (err as Error).message },
+        });
+      }
+    } else {
+      // LEGACY path — kept until AI_VIA_BFF=true everywhere, then deleted
+      triggerExtraction(doc.id, caseId, req.user!.id).catch(console.error);
+    }

     res.status(201).json(doc);
   }
 );
```

Same diff applies to `POST /:caseId/documents/:docId/extract` (manual re-trigger).

The legacy `triggerExtraction` helper stays in the file until the flag is permanently on. Then it (and `services/aiExtraction.ts`) are deleted in a follow-up cleanup PR.

---

## 6. Backend polling worker

### Recommendation: **background poller**, not inline polling

**Reasoning grounded in this codebase:**

- BFF latency is 50–90s. Inline polling in the upload request would tie up an Express worker for at least a minute and risk the user's browser timing out. The existing inline pattern in `services/ringcentral.ts:399–438` time-boxes at 30s — fine for STT, not fine for BFF.
- The codebase has no BullMQ, no agenda, no jobs table. We don't need them: the `Document` row IS the job record (it has `aiJobStatus`, `aiJobSubmittedAt`, `aiJobLastPolledAt`).
- Write-back is the primary path. Polling exists only as a safety net for missed write-backs (network blip, BFF→backend unreachable, backend was redeploying).
- `setInterval` at server start matches the simplest precedent in the repo (frontend `CallWorkspace.tsx` already uses `setInterval`/`clearInterval` for ring-out polling).

### Shape

```ts
// services/aiBffPoller.ts (sketch)

const POLL_INTERVAL_MS = 10_000;        // worker wakes every 10s
const POLL_FRESHNESS_MS = 30_000;       // skip jobs polled in the last 30s
const SUBMISSION_GRACE_MS = 30_000;     // give write-back 30s before polling first time
const JOB_TIMEOUT_MS = 10 * 60_000;     // hard timeout: 10 min (BFF max)

export function startPoller() {
  if (process.env.AI_VIA_BFF !== "true") return;
  if (process.env.NODE_ENV === "test") return;
  setInterval(tick, POLL_INTERVAL_MS).unref();
}

async function tick() {
  const cutoffPolled    = new Date(Date.now() - POLL_FRESHNESS_MS);
  const cutoffSubmitted = new Date(Date.now() - SUBMISSION_GRACE_MS);
  const cutoffTimeout   = new Date(Date.now() - JOB_TIMEOUT_MS);

  // 1. Time out stale jobs (no movement for 10 min)
  await prisma.document.updateMany({
    where: {
      aiJobStatus: { in: ["queued", "processing"] },
      aiJobSubmittedAt: { lt: cutoffTimeout },
    },
    data: {
      status: "ERROR",
      aiJobStatus: "failed",
      aiJobError: "Timed out waiting for BFF after 10 minutes",
      aiJobCompletedAt: new Date(),
    },
  });

  // 2. Find candidates: in-flight + submitted at least 30s ago + not polled in 30s
  const candidates = await prisma.document.findMany({
    where: {
      aiJobStatus: { in: ["queued", "processing"] },
      aiJobSubmittedAt: { lt: cutoffSubmitted },
      OR: [
        { aiJobLastPolledAt: null },
        { aiJobLastPolledAt: { lt: cutoffPolled } },
      ],
    },
    take: 50,   // cap per tick
  });

  for (const doc of candidates) {
    try {
      const status = await aiBff.getJobStatus(doc.aiJobId!);
      await prisma.document.update({
        where: { id: doc.id },
        data: {
          aiJobStatus: status.status,
          aiJobStage: status.stage,
          aiJobProgress: status.progressPct,
          aiJobLastPolledAt: new Date(),
        },
      });
      if (status.status === "completed" && !doc.aiJobCompletedAt) {
        // Fetch full result and apply via the SAME helpers used by write-back routes
        const result = await aiBff.getJobResult(doc.aiJobId!);
        await applyExtractionResult(doc, result);   // shared with PATCH /documents/:id
      }
    } catch (err) {
      // Bump aiJobLastPolledAt so we back off; don't fail the whole tick
      await prisma.document.update({
        where: { id: doc.id },
        data: { aiJobLastPolledAt: new Date() },
      });
      console.error("[ai-poller]", doc.id, doc.aiJobId, err);
    }
  }
}
```

**Idempotency contract:**

- `applyExtractionResult` is the shared logic between (b) PATCH write-back and the poller. It reads `aiJobCompletedAt` first; if non-null, no-op. This makes the two paths safely co-exist.
- Field-level: the same per-field preservation guard (skip if `isApproved` or `isManuallyOverridden`) applies in both paths.

**Why 10s tick + 30s freshness:**

- 10s is fast enough to catch a completion within a single poll cycle past the write-back grace window.
- 30s grace gives write-back a fair shot to land first (cheaper than a BFF GET).
- BFF cost: with 78 cases/week target (~15/day, peak ~2 concurrent), polling load is trivial.

### Startup wiring

```diff
 // backend/src/index.ts
 import { authRoutes } from "./routes/auth";
 ...
+import { startPoller } from "./services/aiBffPoller";
 ...
 app.listen(PORT, () => {
   console.log(`🚀 Ceding Automation API running on port ${PORT}`);
+  startPoller();
 });
```

---

## 7. Auth

### (a) Backend → BFF: `X-API-Key`

- Header name: `X-API-Key`
- Source: `process.env.BFF_SHARED_SECRET`
- Staging default: `DEV_SECRET_CHANGE_IN_PROD` (acceptable since BFF is in our Azure tenant)
- Production: rotate to a high-entropy value, stored in **`kv-cedingai-staging`** (`rg-ceding-ai-staging`), mounted via managed-identity reference on the backend Container App once Sprint 3 / B9 lands.
- Set on the axios instance in `services/aiBffClient.ts` once at module load. Don't log the value.
- New env var alongside existing `AZURE_OPENAI_*` (which can be removed once the BFF cutover is permanent).

### (b) BFF → Backend: `X-Internal-Key`

New middleware:

```ts
// backend/src/middleware/internalKey.ts (sketch)
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export function requireInternalKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.INTERNAL_BFF_KEY ?? "";
  const provided = req.headers["x-internal-key"];
  if (!expected || typeof provided !== "string") {
    return res.status(401).json({ error: "Missing internal key" });
  }
  // Timing-safe compare to avoid leaking the key via response-time side channels
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid internal key" });
  }
  // Synthetic user for downstream audit-log writes
  req.user = {
    id: "system-ai-bff",
    email: "ai-system@furnleyhouse.internal",
    name: "AI Extraction (system)",
    role: "ADMIN",
  };
  next();
}
```

Applied to:
- `PATCH /api/cases/:caseId/checklist/:fieldId/ai-extract` — bypasses `requireAuth`/`requireRole`
- `PATCH /api/documents/:documentId` — same
- Nowhere else. Frontend never sees these endpoints.

New env vars:

```env
# Outbound (this repo → BFF)
BFF_BASE_URL=https://ca-cedingai-api-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io
BFF_SHARED_SECRET=DEV_SECRET_CHANGE_IN_PROD

# Inbound (BFF → this repo)  — must match the value the BFF holds
INTERNAL_BFF_KEY=<32-byte hex, generated per env>

# Feature flag
AI_VIA_BFF=false        # flip to true in staging once BFF integration is wired
```

Both secrets live in the existing **`kv-cedingai-staging`** vault inside `rg-ceding-ai-staging` — the same resource group that already hosts the BFF Container App and its managed identity (`id-cedingai-staging`). Sprint 3 / B9 will deploy the backend Container App, the frontend Static Web App, and Postgres Flexible Server into this same resource group; all four resources will read their secrets from this one vault via managed-identity references. No new vault is created for this branch.

---

## 8. Frontend changes

**Polling pattern to mirror:** `frontend/src/components/case/CallWorkspace.tsx:447–476` — `setInterval` with a `pollRef`, terminal-state detection, `clearInterval` on unmount.

### New: `frontend/src/hooks/useExtractionStatus.ts`

```ts
export interface ExtractionStatus {
  jobId: string | null;
  status: "queued" | "processing" | "completed" | "failed" | null;
  stage: string | null;
  progressPct: number | null;
  error: string | null;
  elapsedMs: number | null;
}

export function useExtractionStatus(
  caseId: string,
  documentId: string | null,
  onComplete?: () => void,
): ExtractionStatus { /* polls every 3s while status in {queued, processing}; stops on terminal */ }
```

- Single endpoint: `GET /cases/:caseId/documents/:documentId/ai-status`
- 3-second interval (same as ring-out poll)
- On terminal state, fires `onComplete()` — caller passes `() => checklistHook.refresh()` so fields populate without manual refresh
- Cleans up via `pollRef.current = clearInterval(...)` on unmount and on documentId change

### Modified: `frontend/src/hooks/useDocuments.ts`

Add no polling here. `useDocuments` continues to just fetch the document list. The new hook does the per-doc polling. Reason: the document list is per-case, individual extractions are per-doc; mixing them turns the simple list hook into something more complex than necessary.

### Modified: `frontend/src/components/case/ExtractionWorkspace.tsx`

For each document in the left-hand `DocumentList`, if its `status` is `PROCESSING`, show a progress bar derived from `useExtractionStatus(caseId, doc.id, refreshChecklist)`. Stage and progressPct from the hook populate the bar.

UI text examples (subject to design polish):
- queued: "Submitted to AI — waiting for pickup…"
- processing, stage1, 25%: "Reading PDF (stage 1/4)"
- processing, stage4, 90%: "Validating fields (stage 4/4)"
- completed: hook stops polling, ChecklistPanel refreshes, banner clears.
- failed: red banner with `error` text + "Retry" button (calls existing `POST /cases/:id/documents/:docId/extract`).

### Modified: `frontend/src/components/case/ChecklistPanel.tsx`

No structural changes. The panel already re-renders when `useChecklistFields` rows change; the new flow triggers `refresh()` via `onComplete` callback.

### Modified: `frontend/src/components/case/DocumentList.tsx`

Add a small per-row badge — spinner + "Extracting (stage 2/4)" — when the doc is in PROCESSING. Removed when the doc reaches EXTRACTED.

---

## 9. Migration plan

Order of operations, designed so each step is independently revertable.

### Step 1 — Prisma migration (additive, no breaking changes)

```bash
# in backend/
npx prisma migrate dev --name add_bff_job_tracking
```

- New nullable columns on `Document` and `ChecklistField`.
- New indexes.
- Seed adds `system-ai-bff` user.
- **No backfill needed.** Existing rows have NULL `aiJobId` and behave as if the integration never ran (because it didn't).
- Deployable on its own; old code keeps working.

### Step 2 — Backend deploy with feature flag OFF

- Merge code: `services/aiBffClient.ts`, `middleware/internalKey.ts`, new routes, modified upload handler, poller (wired but no-ops when flag off).
- Env: `AI_VIA_BFF=false` (default).
- Smoke test: legacy `triggerExtraction` path still works against existing Azure OpenAI config.

### Step 3 — Frontend deploy

- `useExtractionStatus` hook + `ExtractionWorkspace` UI updates.
- Frontend tolerates `ai-status` returning `{ jobId: null, status: null, ... }` for legacy documents — renders no badge, no polling.
- Independent of backend flag state.

### Step 4 — Flip the flag in staging

- Set `BFF_BASE_URL`, `BFF_SHARED_SECRET`, `INTERNAL_BFF_KEY` in staging env.
- Co-ordinate with Nishant to set the matching `INTERNAL_BFF_KEY` on the BFF side.
- Confirm BFF has the backend's staging URL configured for write-backs.
- Set `AI_VIA_BFF=true`. Restart backend.

### Step 5 — UAT smoke test (staging)

In order:
1. Upload one Aviva PDF → expect job submission, `aiJobId` populated, progress bar advancing, write-back lands within 90s, ChecklistPanel populates.
2. Upload one scanned Parmenion PDF (slower, OCR path) → expect ~90s; verify polling fallback kicks in if write-back is delayed.
3. **Manual edit then re-upload** → verify `isManuallyOverridden=true` rows are not stomped (preservation guard).
4. **Adviser approves a field, then re-upload** → verify `isApproved=true` rows are not stomped.
5. Force a write-back failure (wrong `INTERNAL_BFF_KEY` on BFF) → verify polling completes the job within ~40s.
6. Force a BFF outage (block egress) → verify timeout marks document ERROR after 10 min, retry button works after BFF restored.

### Step 6 — Rollback (if needed)

- Set `AI_VIA_BFF=false` and restart. Legacy path resumes immediately.
- Schema changes are additive — no rollback needed for the DB.
- Frontend continues to work (status endpoint returns nulls; UI just doesn't show progress badges).

### Step 7 — Production (gated on UAT sign-off + GDPR sign-off TR-09)

- Rotate `BFF_SHARED_SECRET` and `INTERNAL_BFF_KEY` to production values, store in Key Vault.
- Deploy with `AI_VIA_BFF=true`.
- Schedule for Sprint 6 cutover window (16–17 June).

---

## 10. Open risks for UAT Tuesday

Honest list. Today is 2026-05-22 (Friday); Tuesday is 2026-05-26 — four working days, including this one.

1. **Backend public URL for write-backs.** BFF needs the backend's externally-reachable URL configured on its side to PATCH us. In staging, this likely means the backend has to be deployed to Azure App Service / Container Apps, not running on a developer laptop. If we haven't stood up backend staging yet, write-back testing has to happen via a tunnel (ngrok / Azure Dev Tunnels) — workable, but adds setup friction. **Fallback:** test polling path first (no inbound needed), wire write-back once staging URL is stable.

2. **`INTERNAL_BFF_KEY` synchronization.** Backend and BFF must hold the identical key. If they diverge, every write-back 401s and only the polling fallback works (slower, less informative). Need a single source of truth (Key Vault ref or a shared `.env` line documented in the runbook). Easy to get wrong on rotation.

3. **Backend's own blob access (future, not blocking).** Locked decision: BFF reads blobs via its own managed identity (`id-cedingai-staging` already has Storage Blob Data Contributor on `stcedingaistaging`), so this branch passes relative paths only — no SAS-URL plumbing. When the backend itself later needs direct blob access (e.g. for thumbnailing or virus scanning), assign Storage Blob Data Reader to its own managed identity at that point. Not blocking — BFF already has the permission it needs for this work.

4. **Preservation of manual edits / approvals.** The preservation guard in §4(a) is load-bearing — if it's wrong, UAT users will lose work on re-extraction. The risk is highest when a CA Team member edits a field, then uploads another document for the same case (multi-doc cases are explicitly supported in FR-07). Needs an integration test before Tuesday.

5. **Whole-document re-extract overwriting adjacent fields.** BFF only supports whole-document extraction. If a user uploads a "supplement" PDF that only covers one or two fields, the BFF will still try to extract all 53 (Pension) / 33 (ISA) / 28 (GIA) fields. Fields not present in the supplement will return `MISSING` from BFF. **Our code must not overwrite an existing HIGH-confidence value with a fresh MISSING.** This is a real behavior change vs. the current `triggerExtraction` (which only overwrites on actual value differences). Add an explicit guard: skip the field if `result.value === null` or `result.confidence === "MISSING"` and the existing value is non-null.

6. **Latency UX.** Existing in-process extraction settles in ~10–15s. BFF is 50–90s, occasionally up to 5 min. CA Team will notice. The progress bar mitigates this, but the spinner-time difference may surprise users. Need wording in the handoff doc.

7. **Audit volume.** Each BFF completion writes ~30–53 `FIELD_EXTRACTED` audit rows + one `AI_EXTRACTION_RUN` row. A case with three documents = three full extractions = ~150 audit rows just from AI. The audit table is already indexed on `caseId` + `createdAt`, but the Sprint-1 task "Prisma indexes on frequently filtered columns" is still pending. Worth a quick `EXPLAIN ANALYZE` on the audit timeline query for a multi-doc case before UAT.

8. **Cost visibility.** `aiJobCostUsd` is persisted but no alerting. A buggy loop somewhere (e.g. accidentally re-submitting the same doc on every page load) could rack up real Azure OpenAI spend before anyone notices. Recommend setting an Azure budget alert on the BFF resource group before flipping the flag in staging.

9. **Failed-jobs dead-letter visibility.** BFF contract says "check failed-jobs Cosmos container" on 500. We capture `aiJobError` on the backend, but no admin UI shows it. For Tuesday, accept that admins ssh + `psql` to investigate. For Sprint 5 we should add a small admin view.

10. **Polling worker double-fire on restart.** If the backend restarts while jobs are in-flight, the poller picks them up on next tick — fine. But if write-back lands during the restart window, we lose that one inbound HTTP request and rely on polling to discover completion (extra 30–40s latency). Acceptable; no fix needed for UAT.

11. **PDF size cap.** BFF documents max ~20MB. Backend `multer` limit is 50MB. Mismatch: a 30MB PDF would upload successfully but fail at the BFF. Need to either lower multer's limit to 20MB or surface a clearer "too large for AI" error from BFF (whichever is faster to ship before Tuesday). Lowering the multer limit is the safer call for UAT.

12. **Plan-type mapping.** Prisma `PlanType` is `PENSION | ISA | GIA | BOND | FINAL_SALARY | PROTECTION`; BFF accepts `ISA | GIA | Pension | Bond`. Need a one-line mapper. `FINAL_SALARY` and `PROTECTION` are Phase-2 anyway, so we can throw on those — but it should fail loudly with a clear message, not 400 from the BFF.

---

## Decisions made (locked 2026-05-22)

These five items were settled with Nishant on 2026-05-22 and are now load-bearing assumptions for the implementation. They are not open for re-litigation in code review — raise a separate change if any need to flip.

1. **Endpoint shape — whole-document re-extract only.** No per-field user trigger exists in the UI; the existing "re-extract" button on the document already runs the whole-document path via `POST /:caseId/documents/:docId/extract`. The endpoint `PATCH /api/cases/:caseId/checklist/:fieldId/ai-extract` is therefore strictly the **BFF write-back receiver**, never called by the frontend. Name kept as-is — renaming for clarity isn't worth the disruption when only the BFF will ever call it. Implication: the preservation guard in §4(a) is the only thing protecting CA Team edits from a whole-document re-run; it must be correct.

2. **Storage path — managed identity, not SAS URL.** Confirmed via `az role assignment list` that `id-cedingai-staging` already holds **Storage Blob Data Contributor** on `stcedingaistaging`. The BFF's contract explicitly supports "Relative path: BFF resolves via managed identity to blob storage." Backend passes the relative `storagePath` (e.g. `cases/{caseId}/{ts}-{name}.pdf`) verbatim — no SAS generation, no expiry-window risk. Already reflected in §2 diagram, §5(a) signature, and §5(b) handler diff.

3. **Secrets — single shared Key Vault.** Both `BFF_SHARED_SECRET` and `INTERNAL_BFF_KEY` live in **`kv-cedingai-staging`** inside `rg-ceding-ai-staging`. No new vault is created. When Sprint 3 / B9 lands the backend Container App, the frontend Static Web App, and Postgres Flexible Server, they all deploy into the same resource group and read from this one vault via managed-identity references. Rotation playbook is one document, not two.

4. **Cost tracking — `aiJobCostUsd` and `aiJobTokens` included.** Both columns stay in the Document migration in §3. Populated from BFF write-back `llm_call_meta`. Feeds BR-06 SLT KPI dashboard work in Sprint 6; carrying the data now is essentially free and avoids a second migration later.

5. **AI system user — seeded row, no enum change.** Single row in `users`: `id="system-ai-bff"`, `email="ai-system@furnleyhouse.internal"`, `name="AI Extraction (system)"`, `role=ADMIN`, `status=ACTIVE`. Added to `prisma/seed.ts`. The `UserRole` Prisma enum is **not** modified — adding a `SYSTEM` value would touch every existing `requireRole` site and the frontend's `RoleGuard`. The seeded row passes any `requireRole` check via `ADMIN`, which is what the write-back middleware needs for audit-row authorship.

---

*End of design. Decisions locked. Awaiting your diff review before any code lands.*
