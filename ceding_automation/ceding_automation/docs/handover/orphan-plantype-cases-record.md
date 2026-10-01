# Orphan-row cases from pre-/post-extract planType flips — PROD record

**Filed:** 2026-10-01
**Purpose:** Evidence record, NOT a repair list. These 9 cases carry
`checklist_fields` rows for a planType that no longer matches
`cases.planType` because Zoho CRM re-classified the case after the initial
seed. Deliberately preserved — they are the audit trail for "the AI
failed on this case" claims where the actual cause was a planType change
after extraction/seeding.

If someone points at one of these cases as an AI failure, this doc is the
answer.

## The record (9 cases)

### FH-2026-000097 · Philip Leonard · currently PENSION · STAGE_6_DOCUMENT_UPLOAD

- Created 2026-07-24 as ISA; 37 ISA templates seeded
- 2026-08-19 09:05 UTC — Zoho sync (`CASE_UPDATED/SYSTEM`) flipped planType **ISA → PENSION**, actor `kishore.kumar@furnleyhouse.co.uk`
- 71 PENSION templates subsequently seeded (mechanism unclear from audit — not via `extractionSubmittedAt` which was still null at the time)
- Extraction submitted 2026-09-29; 3 docs all `EXTRACTED` successfully
- 3 × `CHECKLIST_TEMPLATE_MISMATCH_DETECTED` audits emitted 2026-09-29 (one per doc submit) — the warning the system now logs on every mismatched submit
- Current state: 108 rows total = 71 PENSION active + 37 ISA active. Extractions worked.

### FH-2026-000098 · John Shears · currently ISA · **STAGE_10_COMPLETE** (completed 2026-08-10)

- Created 2026-07-24 as PENSION; 70 PENSION templates seeded
- 2026-07-31 07:08 UTC — Zoho sync flipped **PENSION → ISA**, actor `rachel.fiyorina@furnleyhouse.co.uk`
- 37 ISA templates seeded
- Extraction submitted same day (2026-07-31) → 26 `FIELD_EXTRACTED` audits recorded against the ISA set. 1 doc, extracted successfully.
- Case completed 2026-08-10, 107 rows carried forward (70 PENSION orphan + 37 ISA active)
- Export reads scalar fields by key against current planType's template set, so the export was functionally correct; orphan rows are dead storage

### FH-2026-000130 · Colin Hobbs · currently ISA · STAGE_3_CRM_SETUP (the flip-flop case)

- Created 2026-08-11; 71 PENSION templates seeded
- Zoho sync has flipped planType **5 times** since:
  - 2026-08-11 11:22 UTC: PENSION → ISA (`pravin.kumar@furnleyhouse.co.uk`)
  - 2026-08-20 12:11 UTC: ISA → ISA (no-change sync)
  - 2026-08-20 13:34 UTC: ISA → ISA (no-change sync)
  - 2026-08-20 14:41 UTC: ISA → PENSION
  - **2026-09-30 13:15 UTC: PENSION → ISA** (yesterday)
- Never extracted
- Currently 71 PENSION rows persist, 0 ISA rows seeded

### FH-2026-000183 · Stephen Cook · currently FINAL_SALARY · STAGE_1_LOA_PREP

- Created 2026-08-25; 71 PENSION templates seeded
- 2026-08-25 15:19 UTC — flipped **PENSION → FINAL_SALARY**, actor `joe.massarella@furnleyhouse.co.uk`
- Two no-change self-syncs on 2026-09-30
- Never extracted. FINAL_SALARY has no active templates (Phase 2 planType).

### FH-2026-000010 · David Wallace · currently PROTECTION · STAGE_5_CHASING

- Created 2026-06-29; 70 PENSION templates seeded
- 2026-07-31 06:34 UTC — flipped **PENSION → PROTECTION**, actor `pravin.kumar@furnleyhouse.co.uk`
- Never extracted. PROTECTION has no active templates (Phase 2).

### FH-2026-000036 · Sally Silk · currently PROTECTION · STAGE_5_CHASING

- Created 2026-07-06; 70 PENSION templates seeded
- 2026-09-30 12:14 UTC (yesterday) — flipped **PENSION → PROTECTION**, actor `carmel@furnleyhouse.co.uk`
- Never extracted. PROTECTION, no templates.

### FH-2026-000110 · Claire Klein · currently ISA · STAGE_1_LOA_PREP

- Created 2026-07-29; 70 PENSION templates seeded
- 2026-07-29 06:39 UTC (same day) — flipped **PENSION → ISA**, actor `carmel@furnleyhouse.co.uk`
- Never extracted

### FH-2026-000017 · Elliott Silk · currently FINAL_SALARY · STAGE_4_PROVIDER_REQUEST

**This is the clearest "don't blame the AI" case.**

- Created 2026-06-30; 70 PENSION templates seeded
- Same-day extraction attempt: **2026-06-30 07:45 UTC — `AI_EXTRACTION_RUN "Extraction failed: Timed out waiting for BFF after 10 minutes"`** (1 doc, ended in `ERROR` status)
- **3 months later**, 2026-09-30 07:48 UTC, flipped **PENSION → FINAL_SALARY**, actor `carmel@furnleyhouse.co.uk`
- If someone looks at this case today, sees FINAL_SALARY planType and a failed extraction, the chronology matters: **the extraction failure (June) predates the planType change (September) by 3 months**. The failure was a BFF timeout, not a template mismatch.

### FH-2026-000086 · Matthew Burton · currently PROTECTION · STAGE_3_CRM_SETUP

- Created 2026-07-22; 70 PENSION templates seeded
- 2026-09-17 10:16 UTC — flipped **PENSION → PROTECTION**, actor `carmel@furnleyhouse.co.uk`
- Never extracted. PROTECTION, no templates.

## Patterns across the 9

- **All 9 planType changes came via Zoho sync** (`CASE_UPDATED/SYSTEM` with sync metadata), never via a direct user PATCH.
- **5 of 9 are Phase-2 planTypes** (3 PROTECTION, 2 FINAL_SALARY) with no active templates in the current system.
- **Actors** are app users whose email is captured because the Zoho sync endpoint was invoked by a signed-in user — the user triggered the sync; the sync proposed the change based on Zoho's then-current state. The field change itself originated in Zoho CRM, not in the app's UI.
- **Only Philip (FH-097) and John (FH-098) had successful extractions** against the current state. The other 7 either never attempted extraction, or (Elliott) their extraction attempt failed for an unrelated reason (BFF timeout) months before the planType change.

## Why these are preserved (not repaired)

Deleting these orphan rows would erase the audit trail that answers "why does this case look odd." The admin `/reset-plan-type` endpoint exists and can clean them up safely if ever needed. The deliberate choice is to leave them: when ops / CAs look at one of these cases and ask "what happened here?", the row distribution + the audit metadata named in this doc is the answer.

## Verification of the current state (what can still happen to a new case)

- Zoho-sync post-extraction planType writes **are now blocked** by
  `guardLockedFields` (added commit 9bc9d39, 2026-08-07) — the lock
  Nishant's H23 design arms once `extractionSubmittedAt` is set (or any
  checklist_field has `aiExtractedAt` set). The sync endpoint now calls
  the same guard as the normal PATCH path, writing a
  `LOCKED_FIELD_CHANGE_BLOCKED` audit row if the write is rejected.
- Pre-extraction planType flips are **not** blocked (nothing to lock yet).
  Several of the 9 recorded cases are this shape — the case was created,
  partially populated, then re-classified in Zoho before any extraction
  submit. Rows already seeded via a non-extract-submit code path
  (section toggles, early manual edits via `routes/checklist.ts`) can
  remain as orphans. Narrow window today; wasn't closed because closing
  it would need a different mechanism (seed + lock co-set at case
  creation, not at first extraction).
- On a planType flip, nothing deletes or reseeds — the admin
  `POST /admin/cases/:id/reset-plan-type` endpoint is the only cleanup
  path.
- The UI does **not** surface `CHECKLIST_TEMPLATE_MISMATCH_DETECTED` audit
  rows anywhere — operators are blind to the mismatch unless they query
  `audit_logs` directly. For an orphan-rows case where the current
  planType IS still a supported one (PENSION / ISA / GIA), the Checklist
  Panel renders only the current-planType subset; orphan rows from the
  other planType are present in the DB but silently excluded from the
  rendered view.
- For Phase-2 planTypes (FINAL_SALARY, PROTECTION, BOND), the CA sees a
  prominent red-bordered "Plan type out of scope — case flagged" banner
  at the top of every stage view (`frontend/src/pages/CaseDetail.tsx:512-526`),
  explicitly naming the plan type, listing which are supported, and
  stating that progression beyond Stage 1 is blocked. The StageComponent
  does not render at all (line 534: `{planSupported && <StageComponent />}`),
  and the stepper refuses navigation past Stage 1 (line 217-222). The CA
  cannot miss this — it is the only thing visible in the stage area.
