# Zoho export stale cases — 2026-10-05

For Revathy. 62 prod cases where the Stage 9 export left the Excel in WorkDrive but
the Zoho Plans record wasn't written. Not on your retest list — surfaced while
tracing item 8 (Jane's case that wouldn't complete). Your plan-resolution fix
(`5799f48`) is what makes most of them recoverable now; a few need a decision
before we touch them.

Nothing has been re-exported. The next action depends on human judgement, not on
code — reasons below.

---

## What was found

- **62 production cases** where the latest `CHECKLIST_EXPORTED` audit shows
  `zoho=fail` while `workdrive=ok`. The XLSX was uploaded to the client's
  WorkDrive folder but the Zoho CRM Plans record was never updated with the
  checklist values.
- Running from **2026-07-29 to 2026-10-01**. Steady drip, not a single-day
  incident.
- Most are at `STAGE_10_COMPLETE` (so the dashboard shows them as "done") but
  Zoho doesn't know — any report / Plans-module consumer on the Zoho side is
  reading stale data.
- Not reported by anyone. Found by querying `audit_logs` for all
  `CHECKLIST_EXPORTED` rows with `zoho=fail` in the newValue / metadata, while
  tracing item 8 (Jane's case). FH-2026-000124 was one of the 62 — just
  the one that happened to be in front of us.

## Why it happened

The export resolves which Zoho Plans record to update using `Case.zohoCaseId`
as its first choice. For a lot of Furnley cases that id was `Task.What_Id`,
which in prod points at a Deal rather than a Plans record. The resulting
`PUT /crm/v6/Plans/<Deal id>` returns 400 `the id given seems to be invalid`.
The pre-5799f48 heal path searched Plans by the Task's raw `Plan_reference`
string, which sometimes carries two refs typed together (`"8714659 / 714126"`)
and matches nothing.

Error message was always captured in `audit_logs.metadata.zohoError` — this
was never masqueraded as "contact not found" (that was a different code path,
fixed in `d0d5d62`). It was just invisible to anyone not reading the audit.

## What your fix did

Your `5799f48` added two pieces that fix the heal:

1. Refresh-from-Zoho no longer blindly copies `Task.What_Id` into
   `Case.zohoCaseId`.
2. `services/planResolution.ts` tries the case's locked `policyRef`, then
   each part of the Task ref split on `/`, `,`, `;`, `&`, `|`, `and`, then
   the cached `zohoPlanName`.

I dry-ran your resolver against all 60 "healable" cases (last failure before
2026-10-01, so Zoho-side state hasn't moved since). Results:

| | count | % |
|---|---|---|
| `will_match_via_policy_ref` | **46** | 77% |
| `will_match_via_name` | **7** | 12% |
| `still_no_match` | **7** | 12% |

**53 of 60 are recoverable on a re-export because of your fix.** 36 of those
53 already have the right `zohoCaseId` cached — first PUT succeeds, no heal
needed. The other 17 go through the heal path and succeed.

The 2 cases that failed on 2026-10-01 (after your fix went to prod) — Terry
Clews and Roger Newton — are the same shape as the 7 below.

## The 7 that still fail

### Group 1 — policy_ref overwrites from the old mirror (2)

The AI's `plan_number` extraction overwrote `Case.policyRef` via the old
`caseFieldMirror` branch (removed in `33b309e`). The 15-case review pack
documented this class. Two of my 7 overlap.

#### FH-2026-000188 — Andrew Hundley

| | |
|---|---|
| Original Zoho policyRef at CASE_CREATED | `21329896` |
| Current `Case.policyRef` | `71849019` |
| AI's reading | `71849019` (extracted 2026-09-01) |
| `LOCKED_FIELD_CHANGE_BLOCKED` audits | **22** between 2026-09-01 and 2026-09-28 |
| Each blocked audit | `Blocked change to policyRef: "71849019" → "21329896"` — Zoho sync trying to restore its value; the guard defending the AI-set value |

This is the textbook shape. Zoho's Plans module probably has a record for
`Policy_Ref=21329896`, which is why our search for `71849019` finds nothing.

**Decision needed:** which reference is correct for Andrew Hundley's Aegon
Personal Pension? If Zoho's `21329896` is right, admin PATCH `Case.policyRef`
back and re-export. If the AI's `71849019` is actually the right ref (maybe
the policy was renumbered and Zoho is stale), fix the Zoho side.

#### FH-2026-000132 — Mirae Parkhouse

| | |
|---|---|
| Original Zoho policyRef at CASE_CREATED | `82093652` |
| Current `Case.policyRef` | `SW4554002 (formerly 82093652)` |
| AI's reading | `SW4554002` (extracted 2026-08-17) |
| `LOCKED_FIELD_CHANGE_BLOCKED` audits | **10+** between 2026-08-17 and 2026-08-19 |
| CA edit | Pravin extended to `SW4554002 (formerly 82093652)` on 2026-08-18 |

Same mirror-overwrite shape as Hundley, with a CA then expanding the string
to preserve both references. Compound.

**Decision needed:** same question. Zoho's `82093652` or AI's `SW4554002`?
This one also hits Group 3 below — the parenthetical phrasing crashes the
Zoho search.

### Group 2 — looks like Zoho-side gaps (5), but we are not certain

For these five the current `Case.policyRef` matches what Zoho sent at
CASE_CREATED (or what Zoho sync populated shortly after). No AI overwrite
happened. The Zoho Plans search returns no unique match — but we don't know
why. Honest list of possibilities:

- The Plans record for that policy ref genuinely doesn't exist in Zoho CRM
  yet (someone needs to create it).
- The Plans record exists but has a different `Policy_Ref` value (typo, extra
  character, different formatting in Zoho vs the Task).
- The Plans record exists with the exact ref but Zoho's search index is
  returning non-unique (two Plans records share the ref — resolver treats
  `matches.length !== 1` as null).
- Something else about Zoho's data model we haven't surfaced yet.

I haven't checked any of these in Zoho. Not asserting user error — just
reporting the five cases where our side's data is intact and the search
doesn't match uniquely.

| caseRef | client | current `Case.policyRef` | status |
|---|---|---|---|
| FH-2026-000215 | Vivienne Price | `NE719613D` | STAGE_10_COMPLETE |
| FH-2026-000179 | Marcus Ogden | `D4083221000` | STAGE_10_COMPLETE |
| FH-2026-000154 | Sarah Underwood | `MEM018842652` | STAGE_10_COMPLETE |
| FH-2026-000026 | Alexandra Gamble | `923161652` | STAGE_10_COMPLETE |
| FH-2026-000121 | Gian Del Gesso | `P00038780C` | STAGE_10_COMPLETE |

Also worth noting on FH-215: the `plan_number` checklist row is manually set
to `"Not Available"` by Pravin — a human saying "no plan number" on a case
whose `Case.policyRef` is `NE719613D`. That inconsistency doesn't affect the
Zoho export (export reads policyRef, not plan_number) but worth a CA eye.

### Group 3 — our bug (1)

#### FH-2026-000132 — Mirae Parkhouse

Also in Group 1 above. Separate from the overwrite history, the current
`Case.policyRef` = `SW4554002 (formerly 82093652)` breaks the resolver.
`policyRefCandidates` splits on `/`, `,`, `;`, `&`, `|`, `and` but not on
parentheses. The parenthetical phrasing goes to Zoho verbatim as a
`Policy_Ref:equals` query and Zoho rejects it as `INVALID_QUERY`.

Fixable in `services/planResolution.ts` by extending the splitter regex to
also treat `(` / `)` as separators. Separate commit, 1 line of code change.

## What happens next, and who decides

**No automated re-run.** Each re-export writes to production Zoho on a real
client record and leaves a duplicate copy of the Excel in the client's
WorkDrive folder (every POST to `/complete-export` uploads a new file;
WorkDrive doesn't dedupe by name — you'd see
`FH-2026-000243_Ian_Stevens_ceding.xlsx` and
`FH-2026-000243_Ian_Stevens_ceding (1).xlsx` side by side after the retry).

### Decisions on the table

- **The 53 recoverable** — do we batch re-export, or do CAs re-click Complete
  Export one by one? Either way, the Zoho writes and the WorkDrive duplicates
  are real client-record side effects. Your call on scope and timing.
  Suggested small canary of 2-3 (e.g. Guy Stanton FH-234, Marcus Ogden
  FH-140, Clare Burton FH-85) first — those cover both the `will_match_via_policy_ref`
  and `will_match_via_name` paths — to confirm Zoho acceptance before any
  wider batch.
- **The 2 overwrites (Hundley, Parkhouse)** — need you or someone with Zoho
  context to decide which policy reference is correct per case. Not a code
  decision.
- **The 5 Zoho-side gaps** — need someone looking in Zoho directly to find
  out whether the Plans record is missing / mis-reffed / duplicate. Each is
  individually one Zoho search away.
- **The 1 code bug (parenthesis splitter)** — small follow-up PR to extend
  `policyRefCandidates`. Doesn't fix Parkhouse alone, but closes the shape
  for any future "`SW... (formerly ...)`" ref.

### What has NOT been done

- No re-export triggered on any case.
- No PATCH to `Case.policyRef` or `Case.zohoCaseId` on Hundley / Parkhouse.
- No changes to the Zoho CRM Plans module.
- Observability landed as part of a parallel fix (`029d020` adds a
  structured 5xx log on `PATCH /cases/:id`) so the next silent failure
  leaves a server-side trace. Doesn't help with Zoho write failures though —
  those have always been in `audit_logs.metadata.zohoError` and will stay
  there.

### Uncertainty I want to be clear about

- The 5 Group-2 cases — I called them "Zoho-side gaps" but haven't confirmed
  any of them. The resolver returned null; the reasons could be any of the
  four possibilities listed. If some of them turn out to be our-side issues
  I haven't spotted, the number of "recoverable without Zoho work" goes down.
- The 2 Group-1 cases — I can tell you the AI overwrote `Case.policyRef`,
  but I can't tell you which value is actually right. Business judgement.
- Cadence of new failures — 2 cases failed on 2026-10-01 after your fix
  landed. That doesn't mean your fix is incomplete; it means the underlying
  Zoho data gaps are still being created at the usual rate. Both are in the
  same "no unique Plans match" shape.
