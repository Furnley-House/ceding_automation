# Known issues

Live list of issues we know about but haven't fixed yet. Items stay here until
they're closed or bundled into a sprint task. Newer at the top.

---

## KI-10 — Zoho Plans export fails on `Valuation` with more than 2 decimal places

**Filed:** 2026-09-29
**Owner:** unassigned
**Severity:** Medium — blocks Stage 9 export write-back to Zoho Plans for any
case whose extracted or entered `Valuation` carries more than 2 decimal places.
Distinct from the plan-resolution failure fixed in `5799f48`; both symptoms can
co-occur on the same case.

### The shape

Zoho CRM's Plans module enforces `maximum_decimal_place: 2` on the `Valuation`
field. When our Stage 9 export PUT includes higher-precision decimals, Zoho
rejects the entire payload:

```
Zoho Plans/<id> PUT failed (400): {"code":"INVALID_DATA",
  "details":{"api_name":"Valuation","maximum_decimal_place":2,
             "json_path":"$.data[0].Valuation"},
  "message":"invalid data","status":"error"}
```

Real prod evidence — `FH-2026-000234` (Guy Stanton) on 2026-09-24: exports at
`10:00:47Z` and `10:18:09Z` both failed with this exact error. The 2026-09-28
plan-resolution fix (`5799f48`) does not address this — a case with the plan
correctly resolved will still fail here on the PUT if `Valuation` has too many
decimals. Surfaced during the read-only forensic pass for `5799f48` on both
Guy Stanton cases (2026-09-29).

### Fix direction

Normalise `Valuation` to 2 dp at the **write** site (not at extraction —
upstream loses no precision, only the outbound PUT needs the constraint). Grep
for `Valuation` in `backend/src/services/aiBffApply.ts`,
`backend/src/services/zohoCrm.ts`, and `backend/src/routes/export.ts` — the fix
belongs at whichever of those builds the Zoho-CRM update payload.

```ts
Valuation: Math.round(parseFloat(v) * 100) / 100
```

Choose between:
- **Round** — matches accountant-expected behaviour, drops sub-penny precision
  silently. Recommended default.
- **Truncate** — under-reports; probably wrong for financial data.
- **Reject with an actionable error at the app level** — only if the sub-penny
  precision carries meaning downstream, which it doesn't in Zoho.

Extracted values from PDFs are typically 2 or 3 significant digits after the
decimal, so rounding to 2 doesn't create a user-visible discrepancy on any
case we've seen.

### Notes for whoever picks this up

- **Systematic sweep.** Other Zoho fields likely have similar constraints
  (`Plan_Type` enum values, date formats, `Policy_Ref` length). Grep the
  export payload builder for hard-coded strings that go verbatim into Zoho
  and confirm each has a defensive coercion at the write site.
- **Test with FH-2026-000234's own Valuation** — reproduce the failure locally
  (Zoho sandbox) with the pre-fix code, confirm the fix resolves it, before
  shipping. That case's history is the reference implementation.
- **Cross-refs.** Shipped alongside `5799f48` in the 2026-09-28 prod deploy
  (see `.prod-pitr-log` entry for `f69e97d`) — if Guy Stanton exports still
  fail after that deploy, it's this bug, not the plan-resolution one.

---

## KI-09 — `PATCH /:id/status` accepts CA_TEAM for terminal transitions with no approval invariant

**Filed:** 2026-09-29
**Owner:** unassigned
**Severity:** Medium — the current audit trail shows 84 prod cases in a
terminal state with unapproved fields; ≥4 of them show the extreme "zero
approvals ever" pattern. Not a data-loss bug (fields keep their values), but
a governance one — "APPROVED" and "STAGE_10_COMPLETE" statuses currently do
not guarantee the approvals they claim to represent.

### The shape

Two role gates on the checklist path disagree:

| Endpoint | Roles allowed |
|---|---|
| `PATCH /api/cases/:id/status` (advance status, including → APPROVED / STAGE_10_COMPLETE) | `["CA_TEAM", "ADMIN", "PARAPLANNER", "ADVISER"]` |
| `POST /api/cases/:caseId/checklist/:fieldId/approve` (per-field approve) | `["ADVISER", "PARAPLANNER", "ADMIN"]` |

A CA_TEAM user can end-run per-field approval by promoting case status
directly. On staging that manifested as Callum (CA_TEAM) advancing
`FH-2026-000092` to `STAGE_10_COMPLETE` with 71 fields, 0 approved. On prod:
**84 cases** in the same class as of 2026-09-28 read-only forensic query, of
which ≥4 have 0 field approvals ever.

Two distinct shapes in that 84:
- **"Extreme"** (≥4 cases: FH-2026-000237, 000270, 000205, 000131, 000164 —
  Callum's shape): 0 approved, dozens of fields with values. Almost certainly
  the loophole being exercised.
- **"Trailing three"** (~11 of top 15 including Guy Stanton FH-2026-000234):
  68/71 fields approved, the same 3 unapproved every time. Reads like a
  template quirk (three specific fields the paraplanner isn't asked to sign
  off on) rather than the loophole. Worth understanding before shipping the
  guard — those three field keys should be identified and the guard's
  invariant should account for them intentionally, not incidentally.

### Fix direction

Enforce a write-path invariant, agnostic to role:

> A case cannot be at `STAGE_10_COMPLETE` or `APPROVED` while any of its
> checklist fields has a value and isn't approved.

Design decisions locked with the user 2026-09-29:

**(a) Do NOT exempt `value = "N/A"`.** Rachel's bulk "Mark 71 missing as N/A"
on FH-2026-000092 was exactly the shape this guard should catch. Exempting
N/A gives the guard a trivial workaround ("just mark everything N/A"). The
paraplanner still confirms N/A decisions.

**(b) Gate BOTH `STAGE_10_COMPLETE` AND `APPROVED`.** APPROVED means "the
paraplanner has signed off"; you shouldn't enter that state without
approvals either. Gating both closes the "set APPROVED first, then
STAGE_10_COMPLETE" loophole.

**(c) Ignore `showIf` template filtering in the backend.** A DB row with a
value is a field the CA populated; it should be reviewed regardless of the
frontend's conditional-display rules. Backend stays a cheap COUNT; no
template-aware complexity.

### Fix shape (~50 lines impl + ~30 lines tests)

1. **New `backend/src/utils/completionInvariant.ts`** — pure predicate:
   ```ts
   export async function checkCompletionInvariant(caseId: string) {
     const unapprovedCount = await prisma.checklistField.count({
       where: {
         caseId,
         isApproved: false,
         value: { not: null },
         NOT: { value: "" },
       },
     });
     return { blocked: unapprovedCount > 0, unapprovedCount };
   }
   ```

2. **Modify `backend/src/routes/cases.ts` `PATCH /:id/status`** — before the
   `prisma.case.update` (~line 940), when target status ∈ {`STAGE_10_COMPLETE`,
   `APPROVED`}: run the invariant check, if `blocked` return `409` with
   `code: "COMPLETION_UNAPPROVED_FIELDS"`, and emit an audit row
   `action: "COMPLETION_BLOCKED"` with metadata
   `{ unapprovedCount, attemptedStatus }`. Do NOT modify the role gate —
   the invariant subsumes it.

3. **Frontend `components/case/stages.tsx` + case-level Mark Complete** —
   new hook `useCompletionReadiness(caseId)` fetches the same count; disable
   the Mark Complete button and show a tooltip ("N fields still need
   paraplanner approval before this case can be completed"). Backend
   enforces regardless; frontend is UX.

4. **Tests** — 5-8 covering:
   - Blocks when 1 field has value + `!isApproved`
   - Blocks when field has `value = "N/A"` + `!isApproved` (decision (a))
   - Passes when all valued fields are `isApproved`
   - Passes when only empty/null-valued fields are unapproved
   - Passes when target status isn't `APPROVED`/`STAGE_10_COMPLETE`
   - Blocks on either `APPROVED` or `STAGE_10_COMPLETE` (decision (b))
   - Emits `COMPLETION_BLOCKED` audit row on rejection
   - Does not filter by `showIf` (decision (c))
   - Also add a new `AuditAction` enum value `COMPLETION_BLOCKED` in the
     Prisma migration (schema.prisma + one-line migration)

### Backfill note — 84 existing prod cases

The guard operates on **transitions**, so those 84 cases stay put after the
fix ships. Retroactive cleanup is a separate decision — most likely not
worth it (no wrong data, just an unusual audit shape). Whoever picks up the
guard should first investigate the "trailing 3 unapproved" pattern (~11 of
top 15): identify which 3 field keys, and decide whether they should be
exempted (probably not) or the template should be corrected to include
them as approvable (probably yes). That analysis belongs in the PR, not
this KI.

### Notes for whoever picks this up

- Cross-refs `bd9b693 feat(access): let CA Team and Paraplanners work on
  every case`. That commit intentionally opened case *visibility* for
  CA_TEAM but its message overstated the delivery — it did not (and should
  not) open per-field *approval*. This guard makes the approval intent
  enforceable via the invariant rather than trying to fix it via role
  gating.
- Related but distinct from KI-04 (batch vs per-row audit granularity on
  AI writes) — different concern, but touches the same audit-legibility
  surface.

---

## KI-08 — `recordingWatcher` retries every case every tick with no backoff

**Filed:** 2026-09-28
**Owner:** Srinath (author of `services/recordingWatcher.ts`)
**Status:** Fixed on `fix/recording-watcher-backoff`, 2026-09-28 — awaiting
review and a staging soak before `WATCH_RECORDING_FOLDER` goes back on.
**Severity:** Medium — silent today because the feature is disabled on staging
(`WATCH_RECORDING_FOLDER=false` as of 2026-09-28), but must be fixed before it
is re-enabled anywhere, and cannot ship to prod in its current shape.

### What was done

New `services/watcherBackoff.ts` carries the failure memory the watcher had
none of: per-target exponential backoff (5m doubling to 1h, with jitter),
error classification, and a tick-level circuit breaker. `recordingWatcher.ts`
consults it per case and per folder. 24 tests in `watcherBackoff.test.ts`.

Two amendments to the report above:

- **Fix direction 1 says permanent failures should be marked unwatchable in
  the DB.** They are parked for 6 hours in memory instead. A 404 today is a
  folder nobody has mapped yet, and a CA mapping it should not have to wait
  for someone to clear a database flag. Six hours is long enough to stop the
  hammering and short enough to pick the case up the same working day.
- **The note about `palindromePoller` having the same shape is not correct.**
  Its catch block at `palindromePoller.ts:264-272` already stamps
  `lastPolledAt` on failure, so a failing row is not re-polled for
  `POLL_FRESHNESS_MS`, and rows settle as `Timed Out` after `JOB_TIMEOUT_MS`
  and stop being candidates. The throttle is flat rather than exponential and
  the caller set is bounded, so it cannot run away the way the watcher did.
  Left alone.

### The shape

`services/recordingWatcher.ts:75-118` — every `POLL_INTERVAL_MS` (default 120s)
the tick calls `scanOnce()`, which:

1. Loads up to `PER_TICK_CASE_CAP=20` non-terminal cases from Postgres.
2. For each case, calls `ensureCaseCallFolders(clientZohoId, caseRef)` — one
   WorkDrive round-trip per case.
3. On failure, catches at line 112, logs `[recording-watcher] {caseRef}:
   cannot resolve folder — …`, moves on to the next case.

No state is kept between ticks. There is no per-case failure counter, no
exponential backoff on cases that have been failing, no circuit breaker on
"most cases in this tick failed" (a signal that the downstream service, not
the case, is the problem). The next tick re-tries every case from scratch
against the same failing service.

### Evidence

Staging revision `ca-cedingai-backend-staging--0000070`, 2026-09-28 12:09Z → 12:20Z:
every tick emitted ~20 `Request failed with status code 429` warns from
WorkDrive. Same 20 case refs, every 2 minutes, indefinitely. Approximately 600
rate-limit hits per hour against a single Zoho tenant, with zero convergence and
zero useful signal in the logs — after the first tick you cannot tell whether
the situation is getting better or worse.

The root cause of the specific 429 may be auth-adjacent (staging's
`zoho-refresh-token` is CRM-scoped; WorkDrive may soft-deny) or genuine
rate-limiting — but the defect exists independently of which one it is. The
watcher would hammer any downstream service having a bad day in exactly the
same shape.

### Why it slipped through

The code already knows WorkDrive rate-limits hard — line 44 has:

> `PER_TICK_CASE_CAP keeps the WorkDrive load bounded (it rate-limits hard: F7008).`

That defends against a burst per tick. It does not defend against a
persistent-failure loop across ticks. The comment is accurate for the burst-
sized concern the author had in mind; the failure mode that showed up on
staging is the temporal one it doesn't cover.

### Fix direction

1. **Per-case exponential backoff.** Track consecutive failures per `(caseId,
   caller)` — either in a `recording_watcher_state` table or an in-memory map
   keyed by `caseId` (acceptable because the process is single-instance today).
   A case that failed N ticks in a row is skipped for `min(2^N × base_delay,
   max_delay)`. Reset on success. Log the state transition
   ("backing off case X for Y minutes") once, not per-tick.
2. **Tick-level circuit breaker.** If >50% of cases in a tick fail with the same
   error class (429, 5xx, network), halve the tick cadence for the next K
   ticks. Emit one "watcher throttled: {reason}" log line instead of the current
   per-case wall of text. Recover when a subsequent tick shows a healthy ratio.
3. **Classify the error before logging.** `err.message.slice(0, 120)` masks the
   HTTP status. Distinguish auth (401/403), rate-limit (429), transient (5xx,
   ECONNRESET), and permanent (404) — the first three should back off; the last
   should mark the case unwatchable in DB and stop retrying entirely until a CA
   fixes the folder mapping.
4. **Jitter.** All ~20 requests inside a tick fire in a tight loop. Even a
   small `Promise.all` chunk with a stagger would smooth the WorkDrive burst
   rather than concentrating it in a ~1s window.

### Notes for whoever picks this up

- Same class as H31 (DLQ observability) — "silent no-op == invisible" is the
  hygiene principle; add "silent-loop-on-failure == invisible until it isn't"
  as the sibling rule.
- Palindrome-poller (`services/palindromePoller.ts:57-65`) has the same shape
  risk — its per-tick DB queries can't fail in the same way, but the Creator API
  calls inside can. Worth a matching backoff pass in the same PR.
- **Do not re-enable `WATCH_RECORDING_FOLDER=true` on any environment until
  this is fixed.** The staging disable on 2026-09-28 was to unblock Srinath's
  Palindrome UI-flow testing; the feature itself is unshippable in this shape.

---

## KI-07 — Two-store drift between `useAuthStore` and `useRole`

**Filed:** 2026-09-18
**Owner:** unassigned
**Severity:** LOW at rest, HIGH under change — every auth bug shipped during
the H36 phase 1 password-login work traced back to this pattern. Not a live
defect today (all four instances have been patched), but the shape keeps
re-manifesting whenever an auth-adjacent code path is added.

### The shape

The frontend keeps auth state in two independent stores:

| Store | What it holds | Persistence | Cleared by |
|---|---|---|---|
| `useAuthStore` | `user`, `token` | Zustand `persist` middleware, localStorage key `ceding-auth` | `logout()` action on the store |
| `useRole` | `role` (frontend enum) | React Context + manual `localStorage.setItem`, key `fh_role` | `clearRole()` on the Context |

`RoleGuard` reads from `useRole`. Every case-detail / dashboard / admin route
sits behind it. So `useRole.role` is the *load-bearing* signal for
"user is signed in"; `useAuthStore.user` alone is not enough to render
protected UI.

The two stores' populate + clear semantics are separate, and every entry /
exit path has to touch both or one side leaks. The H36 phase 1 ship broke on
this four times:

- **SSO → /change-password trap.** ChangePassword.tsx had no guard against
  an SSO-only user (no `passwordHash`) arriving via a stale `returnTo`
  chain — because there was no single mount-time check tied to "am I a
  legitimate destination for this user's auth state." Fixed by adding a
  `hasPassword` gate.
- **Password login 200 but no session.** `Login.tsx` set `useAuthStore`
  via `setAuth(...)` but not `useRole` via `setRole(...)`. `AuthCallback.tsx`
  (the SSO path) sets both — the password path was missing the `setRole`
  call. RoleGuard bounced the arriving user back to `/`, symptom looked
  like "logged out immediately."
- **/dashboard bounce after /change-password.** Downstream cascade of the
  above — user completes password change, arrives at /dashboard, RoleGuard
  still sees no role, bounces to /, looks like a logout.
- **Sign-out leaves role behind.** `useAuth.signOut()` cleared
  `useAuthStore` but not the `fh_role` localStorage key. Any code path
  calling `signOut()` without also calling `clearRole()` left a stale
  role in localStorage; Zustand's `persist` re-hydrating on the next
  tab load produced the "admin token appeared during a test-user login
  attempt" symptom.

### Why it recurs

`useRole` predates `useAuthStore`. It was originally a role-picker artefact
from the pre-2026-09-17 demo login (see the RolePicker deletion in commit
`b27f044`). When SSO landed it kept the role separate for backwards
compatibility. Neither store is aware of the other, and there's no CI signal
that pairs "populate one" with "populate both." A future developer wiring
a new auth path will forget one side of the pair.

### The fix

Fold `role` into `useAuthStore`. `role` is derivable from `user.role`
(with the existing `ROLE_MAP` transform) — it's not independent state, it's
a projection of the auth store's `user` object. One store, one populate,
one clear. `RoleGuard` reads from `useAuthStore` via a derived selector.
`clearRole` and the `fh_role` localStorage key disappear. `useRole` becomes
a thin `useAuthStore` selector for backwards-compat.

Rough shape:

```ts
// store.ts
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null, token: null,
      role: null,   // ← derived, populated by setAuth
      setAuth: (user, token) => set({
        user, token,
        role: user ? ROLE_MAP[user.role] : null,
      }),
      logout: () => set({ user: null, token: null, role: null }),
    }),
    { name: "ceding-auth" }
  )
);
```

### Not now, but written down

Estimate: 3–4 hours including the migration for existing sessions
(everyone on `fh_role`-only would need to be re-authenticated on next
load; acceptable given `fh_role` never survives a JWT invalidation
anyway). Doesn't ship with the H36 phase 1 because the layered fixes
covered every observed path and this is architectural clean-up, not a
live bug. But every future auth-adjacent change is a fresh chance for
this drift to bite, and the fix removes the class rather than another
patch.

---

## KI-06 — Multi-document extraction has no cross-document deduplication

**Filed:** 2026-09-17
**Owner:** unassigned
**Severity:** MEDIUM — silent doubling of totals when two docs describe the same
payments. Not a data-loss bug (every row is preserved and drillable), but the
year totals a CA sees can read double with no signal that either row was a
duplicate.

### The shape

A case commonly has multiple documents that overlap in time — e.g. a benefit
statement (12 months of contributions) and a transaction schedule (raw
per-payment list). Each document extracts independently into Cosmos, and each
call to `applyContributionTransactions` supersedes only its OWN prior AI rows
(scoped to `documentId`). Rows from other documents on the same case are
preserved by design (that is what protects the two-independent-docs case).

There is no deduplication step. If both documents list the same
`(taxYearLabel, type, date, amount)` payment, both rows land in Postgres, both
are non-superseded, and the parent's year total (which the UI computes as
`sum(non-superseded children)`) reads DOUBLE what the source documents said.
The CA sees a plausible-looking sum with no conflict badge.

### The corresponding fund-lines gap

`applyFundLines` uses the same per-`sourceDocumentId` delete-and-reinsert
discipline. Two statements listing the same fund holding produce two rows in
the drill-down. Cosmetically visible; less of a silent-numeric hazard than the
contributions case.

### What we considered and deferred

Two approaches were sized on 2026-09-17. Notes in
`docs/design/multi-doc-deduplication-2026-09-17.md` when written:

- **A — deterministic backend match** on `(contribution.id, type, date,
  amount)`. Cheap, testable, 0 latency; misfires only on identical triples;
  supersede-not-delete preserves the losing row. Wrong on two genuinely-
  separate same-day same-amount payments (e.g. a correction run + regular
  contribution) — merges them.

- **Hybrid — case-level LLM reconciliation triggered by the Extract click.**
  Reads all `case-extractions` for the case, LLM decides
  same-real-world-payment via language and page context, code handles
  arithmetic / tax-year bucketing / rollups. Fallback for ambiguous or LLM
  error keeps both rows and flags. Preservation via
  `supersededByReconciliationRunId` (new column). Ships as one whole-case
  answer instead of per-doc append. ~£0.15/case, 20–40s per click, ~1 month
  build.

Nishant's direction as of 2026-09-17 is the hybrid. **Deferred until a
signal-carrying volume of doubling shows up in prod audits** — until then the
per-doc apply chain (with the 2026-09-16 label-truth rewrite) is what runs.

### The current defensive posture

- Every row is preserved and drillable via `contribution_transactions.source =
  'AI'` filtered by `contribution.caseId`.
- `sourceDocumentId` on each transaction and fund-line row lets a CA trace
  where a given entry came from.
- A CA who spots a doubled total can manually supersede the duplicate row via
  the contribution-cell popover (H33-followup PR2 flow). Data is recoverable
  either way.

---

## KI-05 — Clearing per-cell N/A does not restore superseded AI transactions

**Filed:** 2026-09-08
**Owner:** unassigned
**Severity:** Low — a deliberate trade-off, not a bug. Recorded so it doesn't
surprise a CA who mis-clicks and expects "clear N/A" to undo the whole flip.

### The trade-off

When a CA marks a contributions cell as "not applicable" (H33-followup PR5),
the atomic write does two things:

1. Sets `checklist_contributions.employerNotApplicableAt` /
   `personalNotApplicableAt` (whichever type applies) to `now()`.
2. Supersedes every non-superseded transaction in that
   `(contributionId, type)` cell by stamping `supersededAt = now()` — same
   pattern as `createManualContributionTransaction`.

Clearing the flag (via the Undo affordance in the ContributionCell popover)
only reverses step 1. Step 2 is NOT reversed: the transactions stay
superseded. So a cell that had £5,000 in AI-extracted transactions, got
marked N/A by mistake, and then cleared reads as **empty** — not as
"£5,000 again".

### Why this shape

Un-superseding is a separate decision: it needs its own audit action
(`CONTRIBUTION_UNSUPERSEDED` or similar), a policy for which superseded
rows to bring back (only the most recent batch? all of them? just AI, or
MANUAL too?), and a way to reason about what happens when N/A is set
twice with different transactions in between. Baking any of that in with
PR5 would have coupled two orthogonal decisions.

The current shape is the minimum: "clear N/A" restores the flag state,
not the transaction state. Symmetric to how retyping a number in a
MANUAL cell doesn't restore any prior AI reads either.

### Recovery path today

Re-run extraction on the source document (Stage 4 → the affected document
→ Extract). The AI will re-emit its transactions and land them fresh, at
which point the sum will match the AI's read again. This is slow (a
whole extraction cycle) and involves a BFF call, but no data was lost —
the superseded rows are still visible in the drill-down, they're just
not counted.

### What would fix it properly

An "undo last N/A flip" affordance that runs in a bounded window (say,
5 minutes) and un-supersedes only the rows superseded by that specific
flip (findable by the audit metadata's `supersededDetails[].id` list).
Outside the window, defer to re-extraction. Not urgent — CAs who care
already know to re-extract; the message on the "Clear N/A" tooltip
warns about this behaviour up front.

---

## KI-04 — AI write paths batch-audit; manual entries per-row-audit

**Filed:** 2026-09-07
**Owner:** unassigned
**Severity:** Low today, Medium when contributions land in prod and CAs
start asking "where did this £ figure come from?" — the conflict-marker
rule (H33-followup PR3) makes the traceability gap user-visible.

### The gap

Two AI helpers write ONE audit row per batch, regardless of how many
child rows were inserted:

| Helper | Action | Audit rows per call |
|---|---|---|
| `applyFundLines` (`services/aiBffApply.ts`) | `FUND_LINE_ADDED` | 1 |
| `applyContributionTransactions` (`services/aiBffApply.ts`) | `CONTRIBUTION_TRANSACTION_ADDED` | 1 |

The manual counterpart writes ONE audit row per inserted transaction:

| Helper | Action | Audit rows per call |
|---|---|---|
| `createManualContributionTransaction` (`services/contributionsService.ts`) | `CONTRIBUTION_TRANSACTION_ADDED` | 1 per row |

So a CA who types £500 into an EMPLOYER 2025/26 cell can be traced to
exactly one audit row naming the transaction id, amount, user, and any
superseded siblings. An AI extraction that inserts nine transactions
across four tax years produces one audit row saying "9 contribution
rows extracted" — you can find WHICH rows via `sourceDocumentId +
createdAt` on the transaction table itself, but there is no direct
audit trail per transaction saying which job wrote it and when it
landed.

### Why fund_lines has been like this forever and nobody noticed

`applyFundLines` shipped with the same batch-audit pattern and no one
raised it because funds are read-only in the app — the CA compares the
extracted rows against a screenshot and either accepts or overrides.
The audit is used at the "did AI touch this document" grain, not the
"who wrote this specific £value" grain.

Contributions are different: PR3's conflict-marker rule will compare
`sum(non-superseded children)` against `AiTotal` and flag mismatches
to the CA. When a CA sees a marker on £5,000 EMPLOYER 2025/26 and asks
"where did this come from — which run, which prompt version, which
doc?" — the answer today is "search the transactions by
sourceDocumentId then cross-reference against the parent's `AI_EXTRACTION_RUN`
audit" rather than a direct row-level audit.

### Root cause

`applyFundLines` set the batch-audit precedent (single
`FUND_LINE_ADDED` per call) at line 511. `applyContributionTransactions`
matched for consistency across the AI write paths — but the pattern to
match for per-row traceability was the manual service, not the sibling
AI helper.

### Fix direction

1. **Preferred:** in `applyContributionTransactions`, emit one
   `CONTRIBUTION_TRANSACTION_ADDED` audit per row inserted, matching
   `createManualContributionTransaction`. Keep the current batch
   summary too (rename e.g. `CONTRIBUTION_EXTRACTION_RUN`) so the
   "how many rows did this job write" grain doesn't disappear.
2. **Same treatment for `applyFundLines`** so the two AI helpers move
   as one — one PR, one shape change, symmetric to the manual pattern
   already established.
3. **Alternative (cheaper):** stamp a `batchId` on every inserted row's
   audit metadata so a downstream query can reconstruct the group.
   Doesn't add per-row audit; just makes the batch audit joinable to
   the rows it produced. Less useful than (1) for the "where did this
   figure come from" question.

### Notes for whoever picks this up

- `AI_EXTRACTION_RUN` at `aiBffApply.ts:393` already writes one doc-level
  summary per extraction. Between that and the per-row audit proposed
  above, the batch audit inside each helper becomes redundant — could
  be removed rather than renamed. Weigh against the cost of a search
  pattern that currently works ("find `FUND_LINE_ADDED` where
  metadata.documentId = X") breaking for any tool that relies on it.
- The manual service's `supersededDetails` metadata is the pattern
  worth copying for the AI per-row audit — capture what was superseded
  and what replaced it, so the audit tells the full story of the cell
  transition rather than the delta.
- Cross-refs H31 (DLQ observability) — same class of "silent no-op ==
  invisible" hygiene. This one is not silent (rows do land), just
  low-resolution.

---

## KI-02 — `GET /api/cases/:id` fans out to ~9–10 DB round-trips per hit

**Filed:** 2026-09-08
**Owner:** unassigned
**Severity:** Low today, Medium at data-volume growth. Prod's DB tier
(`Standard_D2s_v3` GP, 2 vCPU / 8 GiB, 240 IOPS, ZoneRedundant) absorbs the
current load without noticeable per-request latency — the case-detail page
felt slow for a different reason (KI-03 loading-state bug, fixed). File this
so the query shape gets tightened before Phase 2 data volumes.

### The query

`backend/src/routes/cases.ts:486` — `GET /:id` uses one Prisma `include` that
fans out to roughly 9–10 batched queries per hit:

| Include | Prisma queries emitted |
|---|---|
| `case` + `provider` + `createdBy` + `assignedTo` + `paraplanner` + `adviser` | 1 (all joined) |
| `documents` | 1 |
| `checklistFields` (nested include `template`, `sourceDocument`) | 3 (parent + 2 batched nested) |
| `fundLines` | 1 |
| `chaseAttempts` | 1 |
| `comments` (nested include `author`) | 2 |
| `getLockedFieldAttempts` (separate audit-log derivation call after the main include resolves) | 1 |

Total ≈ 9–10 DB round-trips per case-detail load. Payload for a Pension case
with 71 checklist fields + docs + audit is several hundred KB uncompressed.

### Why this is not classic N+1

Prisma batches each `include` level into ONE query (not one-per-parent), so
strictly this isn't the O(N) fan-out of a naive N+1. But it is still a lot
of sequential DB round-trips on a hot path (every case-detail page load,
every stepper stage transition that remounts the container). Prod's
generous DB tier hides it today; Phase 2 volumes will not.

### Fix direction (not urgent)

1. **Split the endpoint** — separate `GET /:id/summary` (case + provider +
   assignees only, one query) from `GET /:id/checklist`, `/:id/documents`,
   `/:id/fund-lines`, etc. The frontend fires whichever it needs when it
   needs it; the case-header renders on the summary payload alone.
2. **Or: parallelise the include tree** — `Promise.all` the independent
   sub-fetches inside the route handler so they run concurrently rather
   than in Prisma's serialised batch chain. Cheaper change; less
   architectural.
3. **Or: pre-compute** — the locked-field-attempts derivation adds a whole
   round-trip for a rarely-read banner. Materialised view or a lightweight
   count cached on the case row would drop it out of the hot path.

### Notes for whoever picks this up

- Measure first. There is no request-log middleware writing to stdout on
  either env (only startup lines land in Log Analytics). Add morgan (or
  Prisma's `log: ['query']` gated on a debug flag) to establish real
  per-hit timings before deciding which of the three fixes above.
- Related front-end pattern: components that fetch on mount (`useDocuments`,
  `useChecklistFields`, `useContributions`) all fire against a case that
  the top-level `GET /:id` also just fetched. Consolidating either shape
  would remove duplicate fetches on the same data.

---

## KI-01 — Frontend type coverage: read paths noisy, write paths unchecked

**Filed:** 2026-09-07
**Owner:** unassigned
**Severity:** Medium — no live incident traces here yet, but this gap is what
let the H33-PR3 silent Edit no-op reach a runtime failure (third
missing-coverage bug in two days: the Edit no-op, the requireCaseAccess
:caseId precedence, and this).

### The gap

`npx tsc -b --noEmit` in `frontend/` reports **53 errors** across 7 files:

| File | Count | Path |
|---|---|---|
| `pages/Cases.tsx` | 16 | read + display |
| `pages/CaseDetail.tsx` | 16 | read + display |
| `components/layout/AppHeader.tsx` | 11 | read only |
| `pages/AuditTrail.tsx` | 6 | read only (useQuery generics) |
| `pages/ProviderDirectory.tsx` | 2 | cosmetic (Lucide `title` prop) |
| `lib/exportTemplate.ts` | 1 | write (Buffer→Uint8Array nominal cast) |
| `components/case/ExportWorkspace.tsx` | 1 | downstream of exportTemplate |

By error class: 25× TS2322, 14× TS2339, 5× TS2345, 4× TS2769, 4× TS2538,
1× TS2352.

### Root cause

`frontend/src/services/api.ts` transforms (`snakeKeys`, `flattenCase`) return
`Record<string, unknown>[]` because the runtime transform is dynamic. Every
downstream caller then hits `TS2339: property does not exist on unknown` when
accessing `.case_ref`, `.client_name`, etc., or `TS2322: unknown is not
assignable to ReactNode` when rendering.

### Why write paths look clean but aren't

Every mutation wrapper in `frontend/src/lib/api.ts` returns
`Promise<AxiosResponse<any>>` — no response type parameter. That means:

- `casesApi.updateStatus`, `checklistApi.updateField`,
  `contributionsApi.addManualTransaction`, and every other write returns
  `any` from `.data`.
- tsc **cannot** emit an error even if the response shape is wrong or the
  caller misuses the result — the type is fully erased.
- Effective type coverage on the paths that mutate client financial data
  is zero. Silent-failure bugs like the Edit no-op slip through because
  strict typing on `updateField` would have surfaced the missing
  return-value handling.

The 53 visible errors are read-path display. The unmeasurable-but-real
number on the write side is the load-bearing risk.

### Fix direction

1. Parameterise the axios wrappers by response type — e.g.
   `api.get<CaseResponse>` / `api.post<UpdateResult>` — so `.data` carries
   a real type through every consumer.
2. Type the `services/api.ts` transform outputs as `CaseRow[]` (the
   interface already exists at `lib/caseHelpers.ts`) rather than
   `Record<string, unknown>[]`. That clears most of the 53 read-path
   errors as a side effect.
3. Once the wrappers are typed, tighten `tsconfig.app.json` (`strict:
   true`, `strictNullChecks: true`) — the loose settings that hid this
   should not persist into Phase 2.

### Notes for whoever picks this up

- Vite's build uses SWC, not tsc — these errors do not block
  `npm run build` and have never failed a deploy. That's why they've
  accumulated. Any CI-gate work on this needs an explicit
  `npm run typecheck` step.
- Test the mutation-side coverage improvement by intentionally breaking a
  `checklistApi.updateField` call site and confirming tsc catches it.
  Read-path errors are easy to see; write-path silence is the point.
