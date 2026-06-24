# Stage 3/4 Upload → Extract → Re-extract — Redesign

**Status:** Agreed plan. Read-only investigation complete; no code shipped yet.
**Date agreed:** 2026-06-16
**Driver:** Nishant
**Prior diagnostics:** trace performed across `backend/src/services/aiBffApply.ts`, `routes/documents.ts`, `routes/checklist.ts`, `frontend/src/components/case/{ChecklistPanel,ChecklistField,ExtractionWorkspace,DocumentList,DocumentUploader}.tsx`, `frontend/src/hooks/{useDocuments,useExtractionStatus,useChecklistFields}.ts`, the live `prisma/schema.prisma`, and Container App Log Analytics workspace `0fd31f52-119f-4fd0-a3b1-15a57db7fc82`.

This document records the agreed redesign and the evidence/anchors behind every decision. Future sessions should not need to re-derive these.

---

## 1. Problem — what UAT users actually hit

### Four reported symptoms

**(A) Extraction status shows "Extracting / queued / finalizing" for a long time, then flips only when the user switches tabs.**
Root cause: `useDocuments` has no polling — only refetches on mount or explicit `refresh()` call (`frontend/src/hooks/useDocuments.ts:51`). The per-row `useExtractionStatus` poller's `onComplete` callback is only wired in `ExtractionWorkspace` and only for the *selected* doc (`ExtractionWorkspace.tsx:104`). Stage 3 passes `selectedId={null}` (`stages.tsx:169`), so no completion callback fires there at all. The doc-list status badge therefore only updates on remount / tab switch.

**(B) Uploading multiple docs one-by-one "crashes" the page.**
Backend is now resilient — Reva's P2003 guard at `aiBffApply.ts:163-176` handles the doc-deleted-mid-extraction race that previously crash-looped the API on rev 0000022. The user-visible "crash" is frontend state-thrash: each upload's auto-fire of `submitOrTrigger` (`routes/documents.ts:95`) plus the `selectedId` auto-select effect (`ExtractionWorkspace.tsx:48-50`) churn the live-status poller while N background BFF submissions race. Toasts pile up, rows look frozen, users perceive a crash.

**(C) Doc stuck "Pending" → users re-upload → duplicates and delay.**
Direct consequence of (A): the badge says `UPLOADED` because `useDocuments` hasn't refreshed; the doc is in fact already `PROCESSING` server-side. Users react by re-uploading. The upload route has no filename de-dupe, so a fresh `Document` row is created. If the user then deletes the original, an in-flight write-back hits the now-deleted doc — handled by the guard above, but the field row loses its source-doc linkage (`SET NULL`).

**(D) Auto-extract on upload + manual ✨ sparkle = double-trigger.**
Two trigger sites today, both routing through the same `submitOrTrigger`:
- `routes/documents.ts:95` — upload auto-fire (unconditional, fire-and-forget)
- `routes/documents.ts:219` — manual ✨ sparkle click

`DocumentList.tsx:230-242` renders the sparkle on every row, AND `DocumentList` is mounted in BOTH `stages.tsx:165` (Stage 3) and `ExtractionWorkspace.tsx:164` (Stage 4). The disable-on-PROCESSING guard fails in the window before `useDocuments` next refetches — which it doesn't (per A) — so the sparkle stays clickable. A second click submits a fresh BFF job and overwrites `Document.aiJobId`; the first job's eventual write-back will then fail the `findFirst({id, aiJobId})` lookup and 404 silently.

### Source-link bug (separate)

The "PolicyInformation PP44333075.PDF · BFF" filename label on each extracted field is not clickable. Three failure modes:

- **Mode 1 (universal):** Users click the filename text shown in the confidence-chip tooltip or inline label — but it's plain text with no `onClick`. The actual clickable element is a separate small `<Button>` with a `<FileSearch>` icon labelled "Source" (`ChecklistField.tsx:273-301`), easy to overlook.
- **Mode 2 (BFF-dependent):** When BFF returns `source_page: null`, the gate at `ChecklistPanel.tsx:354-358` sets `onJumpToSource={undefined}` and the button isn't rendered at all. Users see the filename but have nothing to click.
- **Mode 3 (deleted-source edge case):** When the source doc was deleted, Postgres `ON DELETE SET NULL` on `ChecklistField.sourceDocumentId` (`schema.prisma:368-369`) nulls the FK while keeping the field's value and page number. The button still renders, but `evidenceSource` is null at click time — `handleJumpToSource` (`ExtractionWorkspace.tsx:108-120`) skips the doc-switch and scrolls the *currently-selected* PDF to page N, which is the wrong document.

---

## 2. Decisions — all locked

Each decision below has been agreed; the anchors and evidence are recorded so future sessions can implement without re-deriving the rationale.

### Decision 1 — Stage 3 is upload-only

Remove the ✨ sparkle (extract) and 👁 view buttons from Stage 3. Keep upload and delete only.

**Implementation options (pick one in S1):**
- Add `showExtractButton` / `showViewButton` props to `DocumentList` and pass `false` on Stage 3.
- Or remove the `<DocumentList>` mount from `StageDocumentUpload` (`stages.tsx:165`) entirely and replace with a thin upload-only doc list.

**Anchor:** `DocumentList.tsx:230-242` (the sparkle render). The doc-view button (`👁`) is in the same row block — handle both with the same prop.

### Decision 2 — Stage 4 trigger is ONE "Extract All" button

Single per-case button on Stage 4. Behaviour:

- **Enabled** only when there are docs added or changed since the last extraction (`aiJobCompletedAt IS NULL` OR content-hash changed since that timestamp).
- **Disabled immediately after click** to prevent click-spam (no second submission until the current batch completes or a new upload arrives).
- **Disabled + "all extracted ✓"** state when nothing is pending.
- **No** auto-fire-on-upload (remove `routes/documents.ts:95`).
- **No** per-doc sparkle buttons on Stage 4 either — single entry point.
- **No** auto-fire on entering Stage 4 — the user must explicitly click. (This is intentional: hitting Next should not start a slow expensive operation without consent.)

Progress UI replaces the button as the "it's working" signal once clicked (see Decision 4).

### Decision 3 — Re-extraction scope = β (only new/changed docs)

Equivalent to "re-extract all" in user-facing outcomes, with lower cost and latency. Proven from the merge contract:

- The merge logic in `aiBffApply.ts:32-220` is **purely structural** — no timestamp tiebreaker anywhere. `aiExtractedAt` is written (lines 111, 192) but never read by any decision.
- **Gate 1 (preservation)** at `aiBffApply.ts:54-56` protects every field with `isApproved` or `isManuallyOverridden` set. Human edits are safe across any number of re-extractions.
- **Gate 3 (conflict)** at `aiBffApply.ts:88-137` preserves the existing value as the incumbent and parks the new candidate in `conflictValues` JSON for user resolution — first-value-wins for the user-visible field.
- **Each doc is extracted in ISOLATION.** The BFF contract is one-doc-per-job (`aiBffClient.ts:191-224`); the LLM never sees sibling documents on the same case. Cross-document reconciliation happens entirely in the merge, which runs identically regardless of which docs were submitted in which order. Re-running an unchanged doc therefore produces the same result it did the first time.

Net: β loses zero quality vs α, and avoids paying for redundant LLM calls.

**Trigger to use:** compare `Document.aiJobCompletedAt` against an upload-time content hash (or `Document.updatedAt` if a hash column isn't added). Treat "completed but `aiJobCompletedAt < lastEdited`" as "changed since last extraction".

### Decision 4 — Stage 4 layout

The button-press signal is replaced by a visible progress UI so the user sees extraction is happening:

- **Per-doc progress UI** — `% complete`, `queued / extracting / finalizing / done / failed`, optional stage label. Drives off `useExtractionStatus` (existing 3 s poll) once polling is hardened (Decision 5).
- **Minimizable multi-doc viewer** — left pane shows a list of docs with status + pick-which-doc-to-view; right pane shows the selected PDF; the PDF pane is collapsible so a user with many docs isn't forced to keep one expanded. View / delete affordances live here (not on Stage 3).

### Decision 5 — Symptom A fix (independent of trigger redesign)

Two changes in the polling layer:

- **`useDocuments` gains a `refreshInterval` option** (`useDocuments.ts:51`). Default off; Stage 4 enables it (e.g. every 5-10 s) so the doc-list badges refresh while extractions are in flight. Stops the "tab-switch fixes it" pattern.
- **`useExtractionStatus` gains backoff + stop-on-429** (`useExtractionStatus.ts:26-105`). Today the catch block at lines 97-101 swallows errors and retries at the same 3 s rate; a 429 will be retried indefinitely. New behaviour: on 429 (or 5xx), exponential backoff with a max delay, and stop polling after N consecutive failures — let the parent's refresh signal resume it on the next user action.

This is a SEPARATE workstream from the trigger redesign (Decision 2). It can ship independently.

### Decision 6 — Delete-cleanup

When a document is deleted (`routes/documents.ts:173-203`):

1. **Revert AI-only fields whose source just vanished.** After `prisma.document.delete`, run:

   ```ts
   await prisma.checklistField.updateMany({
     where: {
       sourceDocumentId: deletedDocId,
       isManuallyOverridden: false,
       isApproved: false,
     },
     data: {
       value: null,
       confidence: "MISSING",
       status: "AI_EXTRACTED",
     },
   });
   ```

   This restores the "no source → no value" invariant for fields that the AI populated but a human never touched. Human-edited or adviser-approved fields are intentionally left alone — they survive even if their citation source goes away.

2. **Snapshot source filename** so the audit trail survives the FK `SET NULL`. Add `sourceDocumentName String?` to `ChecklistField` (Prisma migration), and write it at the same time `sourceDocumentId` is written in `aiBffApply.ts:179-194`. Even after the FK nulls, the human-readable filename remains.

3. **Audit row stays as today** — `DOCUMENT_DELETED` action with metadata, plus the new `updateMany` could optionally emit a single `FIELDS_REVERTED_ON_DOC_DELETE` audit if useful.

(Blob cleanup is intentionally out of scope for this redesign — separate concern.)

### Decision 7 — Source-link fixes

- **Mode 1 (universal):** Make the filename label clickable. Wrap the displayed `evidenceSource` in the same handler currently behind the small Source button, gated on `source_page_number` being present. The Source button can stay as an explicit secondary affordance or be folded into the label — UX call at implementation time.
- **Mode 2 (no page):** Allow click to switch to the source doc even when `source_page` is null (no scroll, just doc-select). Better than no affordance at all.
- **Mode 3 (deleted source):** When `evidenceSource` is null at click time — either because the source doc was deleted (post-Decision 6 the value would already be `null`/`MISSING` and the field would be reverted), or because BFF never set it — either disable the click outright or show a toast: "Source document was deleted." Combined with the `sourceDocumentName` snapshot from Decision 6, the toast can name the deleted file.

### Decision 8 — Logging receipts (SHIP FIRST)

Before changing the trigger flow, add observability to the merge path so the new behaviour can be validated against real cases. One `console.log` per outcome in `applyFieldExtraction`:

- `outcome: "preserved"` (gate 1 fired — human-edit protected) — `aiBffApply.ts:55`
- `outcome: "no-overwrite-missing"` (gate 2 fired — MISSING didn't stomp real value) — `aiBffApply.ts:69`
- `outcome: "conflict"` (gate 3 fired — CONFLICT raised, candidate parked) — `aiBffApply.ts:135`
- `outcome: "applied"` (gate 4 fired — normal write) — `aiBffApply.ts:218`

Each line should include `caseId`, `fieldKey`, `aiJobId`, `documentId`. Log Analytics workspace `0fd31f52-119f-4fd0-a3b1-15a57db7fc82`'s `ContainerAppConsoleLogs_CL` will then be queryable for actual merge-decision distributions. Today the merge path is silent on every outcome except the dangling-source warning at `aiBffApply.ts:169` — we're flying blind on what re-extraction does to real cases.

This ships first (S0) because it's trivial, has zero functional risk, and is the diagnostic baseline for everything that follows.

### Decision 9 — Legacy footgun (hardening, not blocking)

The legacy in-process extractor at `routes/documents.ts:406-491` (the `AI_VIA_BFF !== "true"` path) has **no preservation gate**. It would unconditionally clobber `isManuallyOverridden` and `isApproved` fields if the env var were flipped for debugging. Two options, either acceptable:

- **Delete it.** Production has been BFF-only for some time; legacy is dormant.
- **Port the preservation gates** (gates 1 + 2 from `aiBffApply.ts`) into the legacy path so the behaviour stays consistent if anyone re-enables it.

Not blocking the trigger redesign. Schedule as separate hardening (S7).

---

## 3. Key code anchors (consolidated)

For implementation reference.

### Backend

| Anchor | Purpose |
|---|---|
| `services/aiBffApply.ts:32-220` | `applyFieldExtraction` — the merge contract |
| `services/aiBffApply.ts:54-56` | **Preservation gate** (load-bearing for Decision 3) |
| `services/aiBffApply.ts:64-70` | Skip-on-MISSING gate |
| `services/aiBffApply.ts:88-137` | Conflict gate |
| `services/aiBffApply.ts:163-176` | Dangling-source warning (only existing log line) |
| `services/aiBffApply.ts:179-194` | Where field rows are written — site for `sourceDocumentName` snapshot (Decision 6) |
| `services/aiBffApply.ts:226-305` | `applyExtractionResult` — poller pull-path |
| `services/aiBffPoller.ts:23-181` | Background poller (10 s tick, 30 s grace) |
| `routes/documents.ts:53-99` | Upload handler + audit + auto-fire (remove at line 95 per Decision 2) |
| `routes/documents.ts:173-203` | Delete handler — site for cleanup logic (Decision 6) |
| `routes/documents.ts:206-223` | Manual `/extract` route — still useful for an "escape hatch" if a CA wants to force a single-doc re-extract |
| `routes/documents.ts:406-491` | Legacy in-process extractor (Decision 9) |
| `routes/checklist.ts:136-200` | Manual edit — sets `isManuallyOverridden: true` |
| `routes/checklist.ts:202-243` | Conflict resolver — sets `isManuallyOverridden: true` |
| `routes/checklist.ts:259-265` | Field approval — sets `isApproved: true` |
| `prisma/schema.prisma:353-408` | `ChecklistField` model — `isManuallyOverridden`, `isApproved`, source columns |
| `prisma/schema.prisma:368-369` | `sourceDocumentId` FK — defaults to `ON DELETE SET NULL` |

### Frontend

| Anchor | Purpose |
|---|---|
| `components/case/ChecklistPanel.tsx:354-358` | `onJumpToSource` gate (depends on `source_page`) |
| `components/case/ChecklistPanel.tsx:140-184` | Conflict resolver UI builder |
| `components/case/ChecklistField.tsx:220-239` | Confidence chip + filename tooltip (Mode 1 source-link site) |
| `components/case/ChecklistField.tsx:273-301` | "Source" button (current clickable element) |
| `components/case/ExtractionWorkspace.tsx:48-50` | `selectedId` auto-select churn (relates to Symptom B) |
| `components/case/ExtractionWorkspace.tsx:108-120` | `handleJumpToSource` (Mode 3 site) |
| `components/case/ExtractionWorkspace.tsx:164` | Stage 4 `DocumentList` mount |
| `components/case/DocumentList.tsx:230-242` | Sparkle (✨) render — remove from Stage 3 per Decision 1 |
| `components/case/stages.tsx:165` | Stage 3 `DocumentList` mount — strip or gate per Decision 1 |
| `hooks/useDocuments.ts:51` | No polling today — add `refreshInterval` per Decision 5 |
| `hooks/useExtractionStatus.ts:26` | 3 s poll interval — add backoff + stop-on-429 per Decision 5 |
| `hooks/useChecklistFields.ts:45-79` | Adapter that produces `source_page` / `evidence_source` / `evidence_ref` |

---

## 4. Build slices — suggested order

Each slice is a separately deployable change with its own gated roll. Order is bottom-up: observability → safe trim → polling fix → trigger redesign → UX polish → cleanup → hardening.

### S0 — Logging receipts (ship first, safe)

Per-outcome `console.log` in `applyFieldExtraction` (Decision 8). Single file change in `aiBffApply.ts`. No behaviour change. Lets us validate every subsequent slice against real LA data.

### S1 — Stage 3 strip (most isolated UI change)

Remove the ✨ sparkle and 👁 view from Stage 3 (Decision 1). Either via a `showExtractButton` / `showViewButton` prop on `DocumentList` or by replacing the Stage 3 mount with a slimmer upload-only doc list. Confirm Stage 4's `DocumentList` keeps both affordances (it will until S3 replaces them with the multi-doc viewer).

### S2 — Symptom A polling fix (independent of trigger)

`useDocuments` gains `refreshInterval` and Stage 4 enables it. `useExtractionStatus` gains backoff + stop-on-429 (Decision 5). Pure frontend change. Status badges start updating live without tab-switching.

### S3 — Extract-All button + enabled-when-changed + progress UI

The trigger redesign (Decisions 2 + 4). Backend: remove the auto-fire at `routes/documents.ts:95`; add a `POST /cases/:caseId/extract-pending` batch route that submits all `aiJobCompletedAt IS NULL` (or content-hash-changed) docs. Frontend: replace per-doc sparkle on Stage 4 with the single Extract-All button + per-doc progress chips. The disable-after-click + "all extracted ✓" states are part of this slice.

### S4 — Multi-doc viewer

Minimizable PDF pane + per-doc pick + view/delete inline (Decision 4 layout). Mostly frontend; folds the existing `PdfViewer` into a collapsible container with the doc-list as the primary navigation.

### S5 — Delete-cleanup + `sourceDocumentName` migration

Backend: Prisma migration adding `sourceDocumentName String?` to `ChecklistField`; write it in `aiBffApply.ts:179-194`; add the `updateMany` revert in the delete handler (Decision 6). Migration is purely additive (one nullable column) — same low-risk shape as the recent `add_user_ringcentral_columns` migration. Schedule: author the migration, follow the same gated firewall ceremony documented in prior deploys.

### S6 — Source-link Mode 1 / 2 / 3 fixes

Frontend (Decision 7). Mode 1 is the universal win — the filename label becomes the click target. Mode 2 and 3 are robustness improvements. Benefits from S5 having shipped first because `sourceDocumentName` lets Mode 3's toast name the deleted file.

### S7 — Legacy extractor (optional hardening)

Either delete `routes/documents.ts:406-491` or port the preservation gates (Decision 9). No urgency — currently dormant.

---

## 5. What this redesign explicitly does NOT solve

- **Filename de-duplication on upload.** If a user uploads the same file twice (or re-uploads after deleting), they get two `Document` rows with different IDs. Out of scope here; if it becomes a real workflow issue, address as its own ticket.
- **Azure Blob cleanup on delete.** Delete handler doesn't remove the blob from storage. Out of scope.
- **CONFLICT history beyond two candidates.** `conflictValues` JSON only holds `{existing, new}` — a third disagreeing doc overwrites the second candidate. Out of scope; CONFLICT-resolver UI already handles the user picking between two values.
- **Cross-document reconciliation in the LLM.** The BFF contract remains one-doc-per-job. If we ever want the model to see all docs together, that's a separate architectural change.

---

## 6. References

- Prior diagnostic transcript (Stage 3→4 flow trace) — established two trigger sites and the polling gaps that drive symptoms A-D.
- Prior diagnostic transcript (re-extraction safety) — established preservation gate at `aiBffApply.ts:54-56` and silent merge path.
- Prior diagnostic transcript (timestamp tiebreaker) — confirmed merge is purely structural; β is provably equivalent to α end-to-end.
- Prior diagnostic transcript (source-link failure) — established Modes 1/2/3.
- Container App LA workspace `0fd31f52-119f-4fd0-a3b1-15a57db7fc82` — operational signal source for S0 instrumentation validation.
