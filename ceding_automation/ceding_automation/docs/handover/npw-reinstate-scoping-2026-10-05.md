# NPW reinstate — admin-only unwind

**Date:** 2026-10-05
**Context:** feat/dashboard-caseflow-workload is merged and deployed to
staging. NPW now permanently cancels a case — every revive path is blocked
by `npwStatusChangeError` in `backend/src/utils/caseGuards.ts`. If a CA
marks a case NPW by mistake today, the only recovery is a DB write.
This document scopes an admin-only reinstate so that recovery isn't a DBA
task.

## Requirement

A single admin action that:
1. Returns a CANCELLED case to the status it held immediately before the
   NPW action.
2. Clears `cancelledReason` and `cancelledAt`.
3. Leaves a durable audit trail that the case was reinstated, by whom,
   when, and why.
4. Is admin-only; no CA / paraplanner / adviser surface.

## Current state

- `caseGuards.npwStatusChangeError` blocks every status-changing route
  (PATCH /:id, PATCH /:id/status, POST /:id/assign-paraplanner) with
  "This case is marked NPW (cancelled) and its status can't be changed".
- No `/reinstate` endpoint. No UI affordance.
- The pre-NPW status IS recoverable from the audit trail: when NPW fires,
  POST /:id/npw writes a CASE_UPDATED row with `field: "status"`,
  `oldValue: <prior status>`, `newValue: "CANCELLED"`. The derivation
  for the "cancelled from" badge already uses this exact query at
  `backend/src/routes/cases.ts:845-852`.

## Design

### Schema — no changes needed

The pre-NPW status comes from AuditLog. Both `cancelledReason` and
`cancelledAt` are nullable, so reinstate just NULLs them. Add a new
`AuditAction` enum value `CASE_REINSTATED` for the audit row (additive
migration, same pattern as the recent `CASE_ACCESS_RETRY_DENIED` /
`COMPLETION_BLOCKED` enum extensions).

### Endpoint

```
POST /api/cases/:id/reinstate
Role: ADMIN only (requireRole(["ADMIN"]))
Body: { reason: string }   // free text, min 10 chars, max 500
```

Flow:
1. Load the case. If `status !== CANCELLED`, return 400
   "Case is not cancelled".
2. Derive the prior status: query AuditLog for the most recent
   `CASE_UPDATED` row where `caseId = :id`, `field = "status"`,
   `newValue = "CANCELLED"`. Take `oldValue`.
   - If no such row exists (edge case: the case was CANCELLED by a
     manual DB write before NPW existed, or audit was pruned), fall back
     to `STAGE_3_CRM_SETUP` and note it in the audit comment. We never
     restore to a status past STAGE_8 — if the audit says
     STAGE_9/APPROVED/STAGE_10, clamp to STAGE_8_VERIFY_CHECKLIST so a
     reinstated case re-enters the paraplanner queue cleanly.
3. In a transaction:
   - Update the case: `status = <prior>`, `cancelledReason = null`,
     `cancelledAt = null`.
   - Write an AuditLog row: `action: CASE_REINSTATED`,
     `field: "status"`, `oldValue: "CANCELLED"`, `newValue: <prior>`,
     `userId: req.user.id`, `comment: <body.reason>`.
4. Return the updated case.

### Guard interaction

`npwStatusChangeError` must NOT fire on the reinstate route. The simplest
pattern: don't call it from inside the reinstate handler (the handler
owns the transition explicitly). Leave the three existing routes
unchanged so they keep blocking normal status writes on CANCELLED cases.

### Frontend

- `CaseDetail.tsx`: when `caseItem.status === "cancelled"` AND
  `role === "admin"`, render a "Reinstate case" button on the NPW
  banner (adjacent to the existing read-only reason display).
- Click opens a confirmation dialog that takes a mandatory reason
  (textarea, 10-char min). Submit calls the endpoint, invalidates
  `["case", caseId]`, `["cases"]`, `["cases", "stats"]`.
- Toast: "Case reinstated to <stage label>." using the status returned
  by the API.

### Audit trail readability

`AuditTrail.tsx` already renders generic CASE_UPDATED rows well; add a
display case for `CASE_REINSTATED` that reads "Reinstated from NPW to
<newValue label>" with the reason comment on the second line.

### Zoho sync

Out of scope for this change — matches the existing "NPW not sent to
Zoho" open item. If NPW is later wired into Zoho (via a Plan_Status
field or a cancellation subtask), reinstate must mirror. Noted in both
docs so they ship together.

## What this doesn't do

- No bulk reinstate (one case at a time).
- No "reinstate to a specific stage" picker. The audit trail decides,
  because any other choice is a different kind of decision (process
  re-entry) that should go through the normal stage controls.
- No notification to the original CA that their NPW was undone — an
  admin action, so the admin is responsible for messaging.

## Prior-stage edge cases

| Prior status (from audit) | Reinstated to |
|---|---|
| STAGE_1_LOA_PREP … STAGE_8_VERIFY_CHECKLIST | same stage |
| STAGE_9_PARAPLANNER_REVIEW | STAGE_8_VERIFY_CHECKLIST (re-enter review from checklist) |
| APPROVED | STAGE_8_VERIFY_CHECKLIST |
| STAGE_10_COMPLETE | not reachable — `canMarkNpw` blocks NPW from completed cases |
| IN_REVIEW | STAGE_8_VERIFY_CHECKLIST |
| ON_HOLD | STAGE_3_CRM_SETUP (ON_HOLD is a workflow pause, not a stage) |
| missing audit row | STAGE_3_CRM_SETUP + comment flagging the fallback |

## Test coverage

Unit tests on a new `caseGuards.ts` helper `reinstateTargetStatus(audit, fallback)`:
- happy path: oldValue=STAGE_5_CHASING → STAGE_5_CHASING
- clamp: oldValue=APPROVED → STAGE_8_VERIFY_CHECKLIST
- fallback: audit missing → STAGE_3_CRM_SETUP
- unexpected value: oldValue="SOMETHING_NEW" → STAGE_3_CRM_SETUP

Integration test for the endpoint:
- non-admin → 403
- status not CANCELLED → 400
- missing reason → 400
- happy path → 200, status flipped, audit row written, `cancelledReason`/`cancelledAt` cleared

Staging smoke: pick one of the 11 tier-2 cases (empty PENSION rows from
2026-10-05 prod scoping), reinstate it, verify stage, and NPW it again
to confirm the loop.

## Effort

Small. Backend endpoint + guard tweak + 1 migration (enum add) + helper +
tests. Frontend: 1 banner button + 1 dialog. ~0.5 day.
