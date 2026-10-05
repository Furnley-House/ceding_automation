# NPW ("No Plan Workable") — scoping

**Date:** 2026-10-05
**Owner:** Nishant (scoping) → implementation TBD
**Source:** Revathy, confirmed verbally with Nishant

## What NPW means

A **No Plan Workable** case is one that cannot proceed through the ceding
workflow — provider refuses to supply info, client withdraws, plan turns out
to be already closed, etc. Today CAs have two bad options:

1. Push it through to **STAGE_10_COMPLETE** anyway by marking every
   checklist field N/A, which pollutes "Completed cases" metrics with
   non-outcomes.
2. Set **CANCELLED**, which currently renders as a green "Complete" badge
   because of a stale status mapping (see point 1 below). CAs don't trust
   that path because downstream it looks indistinguishable from Complete.

NPW gives Cancelled a reason, fixes the display, blocks accidental
advancement, and provides a back-fill action for the historical pollution.

## Revathy's five requirements

1. Cancelled must render as "Cancelled", never as "Complete".
2. Cancelled cases must not count as active.
3. NPW action available at Stage 3 only.
4. An NPW case cannot be moved to the next stage.
5. Existing cases that should have been NPW must be convertible to it.

## Current state

### 1. Cancelled badge bug — CONFIRMED

`frontend/src/services/api.ts:55` maps `CANCELLED → "complete"` in
STATUS_MAP. Every surface that reads `case.status` (lower-cased UI token)
therefore gets `"complete"` for a cancelled case:
- Badge label resolves to `STATUS_LABELS["complete"] = "Complete"`
  (`frontend/src/lib/caseHelpers.ts:56`)
- Badge class resolves to `STATUS_STYLES["complete"] = "bg-success/15 text-success"`
  (green, line 72)

Single root cause, cosmetic blast radius across CaseDetail / Cases list /
MyInbox / AuditTrail / CompleteWorkspace / ZohoCrmTaskPanel.

### 2. Cancelled counted as active — SPLIT

- **Backend** correctly excludes Cancelled from both active and completed:
  `backend/src/utils/caseStats.ts:14-29` — `active = total − completed −
  cancelled`. `/cases/stats` returns the right numbers today.
- **Frontend Cases list** at `frontend/src/pages/Cases.tsx:220-225` filters
  "active" by `c.status !== "complete"`. Because the api.ts mapping sends
  CANCELLED → "complete", the filter accidentally excludes cancelled from
  "active" (right outcome, wrong mechanism). The filter also already special-
  cases CANCELLED to keep it OUT of the "complete" filter —
  `c.backend_status === "CANCELLED"` is explicitly rejected on line 225.
- **Dashboard** reads `stats.active` from the backend, so it is correct.

Net: no number is wrong today, but the mechanism is fragile. Once point 1
is fixed, Cases.tsx line 222–223's filter needs to be updated to
`c.status === "cancelled"` → excluded from "active" explicitly.

### 3. NPW action at Stage 3 — NOT BUILT

Grep for `NPW`, `No Plan Workable`, `no.plan.workable`: zero matches.
No existing UI, no API endpoint.

### 4. NPW blocked from advancing — PARTIAL

`backend/src/routes/cases.ts:938-942` locks `currentStage` changes when the
case is in IN_REVIEW / STAGE_9 / APPROVED / STAGE_10. **CANCELLED is not in
that lock list.** A PATCH with `currentStage: 4` on a CANCELLED case will
move it back into Stage 4. Need to add CANCELLED (and whatever NPW ends up
being) to that `locked` predicate.

Frontend "Complete & Next" button on CaseDetail does not know about
CANCELLED either — it reads `caseItem.status`, and once CANCELLED → "cancelled"
is wired, the button needs to be hidden/disabled for that status.

### 5. Back-fill — PROD DATA

Query: cases in prod with `status = STAGE_10_COMPLETE`, measured against
three "little or no data" proxies.

| Tier | Definition | Count | % of 123 completed |
|------|-----------|------:|--------:|
| 1 | ≤5 checklist fields with values AND 0 fund lines AND 0 contributions | **4** | 3.3% |
| 2 | <20% fill rate AND 0 fund lines (includes tier 1) | **15** | 12.2% |
| 3 | <40% fill rate (any) | 16 | 13.0% |

**Signal in the data:** every tier-2 case has 0 fields with values, with
either all 70-71 fields marked N/A, or the first 17 marked N/A. 11 of the 15
are PENSION cases with exactly 4 `contributions` rows (likely all N/A
placeholders).

**Tier 1 breakdown:** 3 ISA + 1 GIA, all 4 cases have every field marked N/A
(including the 2x James Ropner ISA duplicates). Age at completion: 7–66
days, so these aren't rushed closures — the CA worked them for weeks then
flipped everything to N/A to force progression.

**Tier 1 + Tier 2 = 15 cases = clear NPW candidates.** The uniform
"everything N/A" pattern is diagnostic of someone who had no real info to
record. Tier 3 adds just one extra case so the ≤20% fill threshold is a
natural cliff.

**Verdict:** 15 cases is a meaningful but tractable back-fill. Big enough to
justify the feature; small enough to review manually before bulk conversion.

## Design decision

Two schema shapes considered:

### Option A — reuse CANCELLED + add `cancelledReason String?` (recommended)

Models exactly like `onHoldReason` (schema line 389). An NPW case is a
Cancelled case with `cancelledReason = "NPW"`. Other cancellation reasons
(client withdrew, duplicate case, test case) can share the column.

Pros:
- Minimal schema change (one nullable column).
- No new enum value, no change to STAGE_TO_STATUS, no reshuffle of
  dashboard / KPI code.
- Fixes points 1 + 2 just by correcting the stale STATUS_MAP; the reason is
  additive metadata.
- Audit trail works via existing CASE_UPDATED rows on the `status` field.

Cons:
- "Cancelled" and "NPW" conflate in filters unless we add a `cancelledReason`
  filter. Probably fine — the Cases list already has few filters.
- Reporting ("how many NPW last month") needs to WHERE on the reason, not
  the status.

### Option B — new `NO_PLAN_WORKABLE` CaseStatus enum value

Pros:
- Explicit everywhere; filters and dashboards see NPW as a first-class
  outcome.

Cons:
- Enum migration (fine, additive).
- STATUS_MAP, STATUS_TO_STAGE, STATUS_LABELS, STATUS_STYLES, caseStats
  summariseStatusCounts, every grep of CANCELLED all need updates.
- Encodes "NPW is a different kind of thing from Cancelled" — which it isn't
  really; NPW *is* a cancellation reason.

**Recommend Option A.** Follows the existing `onHoldReason` precedent and
keeps the surface area small.

## Implementation sketch (do not build yet)

### Schema
```prisma
model Case {
  ...
  onHoldReason      String?
  cancelledReason   String?  // NEW — "NPW" | "Client Withdrew" | "Duplicate" | free text
}
```

Migration name suggestion: `20261006000000_add_cancelled_reason`.

### Backend
1. `routes/cases.ts` PATCH `/:id`:
   - Accept `cancelledReason` from body.
   - When `data.status = CANCELLED`, require `cancelledReason` (or let it be
     set to NULL for explicit clear).
   - Add `CaseStatus.CANCELLED` to the `locked` predicate at line 938-942 so
     stage changes don't un-cancel.
2. New endpoint `POST /cases/:id/mark-npw` (or reuse PATCH):
   - Transitions status to CANCELLED, sets cancelledReason="NPW",
     stamps an AuditLog row with `action: CASE_UPDATED` and `fieldKey:
     cancelled_reason`.
3. `summariseStatusCounts`: already correct — no change.

### Frontend — point 1 fix (standalone, could ship first)
- `services/api.ts:55`: change `CANCELLED: "complete"` → `CANCELLED: "cancelled"`.
- `services/api.ts:76`: `CANCELLED: 1` in STATUS_TO_STAGE — leave or revisit.
- `lib/caseHelpers.ts:50-78`: add
  - `STATUS_LABELS.cancelled = "Cancelled"`
  - `STATUS_STYLES.cancelled = "bg-muted/15 text-muted-foreground"` (or
    `bg-overdue/15 text-overdue` if we want it to look like a hard stop)
- `pages/Cases.tsx:222-225`: rewrite filter to be explicit —
  ```ts
  if (statusFilter === "active") {
    if (c.status === "complete" || c.status === "cancelled") return false;
  } else if (statusFilter === "complete") {
    if (c.status !== "complete") return false;  // "cancelled" is now its own value
  }
  ```
- Add `cancelled` to the status filter dropdown.

### Frontend — point 3 NPW action
- New button on `components/case/Stage3Workspace.tsx` (or whichever Stage 3
  surface exists) — "Mark as No Plan Workable" with confirmation modal.
- Modal captures a free-text note (saved to `cancelledReason` or a new
  field, TBD) and PATCHes status=CANCELLED + cancelledReason="NPW".
- Gated on `caseItem.current_stage === 3` AND user role in [ca_team, admin].

### Frontend — point 4 block advance
- `pages/CaseDetail.tsx`: hide "Complete & Next" / "Advance Stage" controls
  when `caseItem.status === "cancelled"`.
- Backend lock (above) is the authoritative stop; frontend hide is UX.

### Point 5 back-fill tool
- Admin-only page or script.
- Lists the 15 candidate cases (same query as above), lets admin tick
  which to convert, sets status=CANCELLED + cancelledReason="NPW back-fill"
  for the selected rows.
- Keep tier-1 (the 4 cases) separate from tier-2 (the 11 extras) in the UI
  so admin can approve conservatively.

## Open questions for Nishant

1. **Which plan types can go NPW?** Revathy said Stage 3 only — but Stage 3
   is CRM setup, which runs for all plan types. Confirm NPW is plan-type-
   agnostic.
2. **Can NPW be reversed?** If a provider later cooperates, does the CA
   un-cancel the case (status → whatever stage it was in) or spawn a new
   case? Un-cancelling needs a specific flow because the lock added in
   point 4 would otherwise block it.
3. **Point 5 back-fill:** confirm the 15 identified cases are the right
   universe. Any of them you'd want to inspect manually before conversion?
4. **Button label:** "No Plan Workable" is accurate but long. "Mark NPW" or
   "Can't Proceed" or something else?
5. **Zoho side:** does the Zoho CRM Plan record need a matching status
   (e.g. a "NPW" picklist value), or do we leave Zoho on whatever it was
   and only mark NPW locally? Current Zoho sync down-propagates, not up.

## Scope the work in order

Point 1 (cancelled badge) is a 3-line fix on its own and worth shipping
immediately, independent of the rest. Points 2 (filter cleanup), 3, 4, 5
sit behind the schema change and should ship together as "NPW phase 1".
