# Known issues

Live list of issues we know about but haven't fixed yet. Items stay here until
they're closed or bundled into a sprint task. Newer at the top.

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
