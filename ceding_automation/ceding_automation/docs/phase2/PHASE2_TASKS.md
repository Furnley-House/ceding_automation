# Phase 2 tasks — status log

## H16 — Connect prodai AI layer to prod colleague-backend  →  **BLOCKED** (was: "hygiene, do anytime")

**Blocked on:** H17 (extraction write-back ordering bug in `ceding_automation`).

### Why it's blocked (not hygiene)

The colleague-backend PUSH write-back is currently a partial-write that would corrupt
field delivery if made the primary path.

- Push endpoint: `PATCH /api/documents/:documentId`
  (`backend/src/routes/documents.ts:777-909`, internal-key-gated).
- Its wire schema `aiDocWriteBackSchema` (`documents.ts:718-763`) carries **`fund_lines`
  only** — there is no scalar `fields` array in the body.
- On `status: "completed"` the handler sets `document.status = EXTRACTED`,
  `aiJobStatus = "completed"`, and `aiJobCompletedAt = now` (`documents.ts:807-838`).
- The poller's PULL path (`services/aiBffApply.ts:282` → `applyExtractionResult`) is the
  only writer of scalar checklist fields. Its idempotency guard at
  `aiBffApply.ts:293` short-circuits with `outcome: "already-complete"` as soon as
  `aiJobCompletedAt` is non-null.

Consequence: if `COLLEAGUE_BACKEND_URL` is set on prodai so PUSH wins the race,
`aiJobCompletedAt` gets stamped by the PATCH before scalars are applied. The poller
then no-ops. **Scalar checklist fields stop being delivered.**

Field delivery works in prodai **today** *because* `COLLEAGUE_BACKEND_URL` is unset —
the poller PULL is the sole path, no race, no early-guard trip. Enabling PUSH without
fixing H17 first would regress this.

### Cross-reference

- **H17** — write-back ordering / partial-write bug.
  - Fix option A (largest, most correct): extend `aiDocWriteBackSchema` to accept a
    scalar `fields` array and apply it inside the same `$transaction` that flips
    `aiJobCompletedAt`. PUSH then becomes a complete write.
  - Fix option B (smaller): stop setting `status = EXTRACTED` / `aiJobCompletedAt` in
    the PATCH handler; leave terminal-state writes to `applyExtractionResult`. PATCH
    keeps carrying `fund_lines` + progress; poller PULL owns terminal state and
    scalars. Preserves single-writer invariant; costs ~10-30s badge latency.

Neither option is deployed. Until one lands, H16 must not be actioned.

### H16 acceptance criteria (revised)

1. H17 fix merged to `main` and deployed to prod (backend image rolled).
2. Regression test proving PUSH-wins path delivers all scalar fields (integration test
   invoking PATCH with `status=completed` payload → assert `ChecklistField` rows exist
   for the doc's fields).
3. Only then: set `COLLEAGUE_BACKEND_URL` on prodai; smoke-test one document; verify
   scalars land within the badge-flip window.

### References

- `backend/src/routes/documents.ts:718-763` — `aiDocWriteBackSchema`
- `backend/src/routes/documents.ts:777-909` — PATCH handler
- `backend/src/services/aiBffApply.ts:282-362` — `applyExtractionResult` (PULL writer)
- `backend/src/services/aiBffApply.ts:293` — idempotency guard
- `backend/src/services/aiBffPoller.ts:14-19,178-232` — poll cadence + poll-one path
- `frontend/src/components/case/DocumentList.tsx:222` — badge keys off `doc.status`
- `frontend/src/hooks/useChecklistFields.ts:199-234` — no auto-refetch
