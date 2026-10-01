# Revathy — staging test plan, 2026-10-01

Follow-up to your 2026-09-30 E2E test findings (23 issues, 7 high-severity).
Everything below is deployed to staging and ready to click through. Work in any
order; the items are independent unless noted.

---

## Setup

- **Staging URL:** <https://stcedingaistaging.z33.web.core.windows.net/>
- **Sign in:** your usual Microsoft SSO works. If you're testing Item 6 (role
  update on password login) use a password-only account — ask Nishant for one
  if you don't have local credentials set.
- **Test case guidance:** every scenario below either tells you to pick any
  PENSION case already in staging or asks you to create a fresh one. Where it
  matters, I say which.
- **If something looks broken:** copy the case ID (`FH-2026-xxxxxx`), the
  stage, and what you clicked. Screenshots help but aren't required.
- **Before you report a regression:** check the "Not regressions" section at
  the end — two visible number changes are intentional.

---

# PART 1 — Your seven items

## Item 7 — Approve-all no longer approves blank / review-requested / conflicted fields

**Status:** fixed, on staging (commit `c529fa8`).

**Before:** "Approve all filled" counted every row with any value as filled,
including rows explicitly marked REVIEW_REQUESTED by a CA or flagged CONFLICT
by the extraction. One click could sign off work that still needed attention.

**What changed:** the button now skips any row that is (a) blank, (b) in
REVIEW_REQUESTED state, or (c) marked as a CONFLICT. Those rows stay in their
current state; only HIGH / MEDIUM / LOW / MISSING-with-value rows get
approved.

**Steps**

1. Open any PENSION case at Stage 4 (Checklist review). Pick one with mixed
   AI output — ideally one that has at least one blank row, one row you can
   mark as needing review, and (if the extraction produced any) one CONFLICT
   row.
2. In the Stage 4 checklist panel, pick one row with a value and click the
   small flag icon → "Request review". The row's chip should change colour /
   label to indicate review requested.
3. In the same panel, confirm there's at least one blank row (no value typed,
   not N/A).
4. Click **Approve all filled** at the bottom of the panel.

**Expected**

- Rows with values that were NOT marked for review and NOT CONFLICT flip to
  Approved.
- The row you marked REVIEW_REQUESTED stays as review-requested (not
  approved).
- Blank rows stay blank (not approved).
- CONFLICT rows (if any) stay as CONFLICT (not approved).
- A toast / summary tells you how many were approved and how many were
  skipped.

**Regression indicator**

- A REVIEW_REQUESTED row flips to Approved after clicking Approve all.
- A blank row suddenly shows an "approved" tick.
- A CONFLICT row loses its CONFLICT chip and goes green.

---

## Item 3 — Rate limit per user + 5-minute sync debounce

**Status:** fixed, on staging (commit `2dd8d00`).

**Before:** the global 500 req / 15 min limit was shared across all users
sharing a public IP (office NAT), so one busy CA could 429 everyone else.
The sync-from-Zoho fallback that fires on a 403 had no per-user cap and no
debounce — a tight re-fetch loop in the UI could hammer Zoho repeatedly for
the same case.

**What changed:**
- Rate-limit key is now the authenticated user id (JWT sub), not the request
  IP. Users on the same office IP no longer share a budget.
- Per-user sliding-window cap of 10 sync-on-403 attempts per rolling minute.
  The 11th attempt is skipped with `skipped-rate-limit` audit.
- 5-minute debounce on sync-from-Zoho for the same case + user — repeat
  attempts inside 5 minutes short-circuit without hitting Zoho.

**Steps**

1. Sign in as yourself. Open any case you have access to and work normally for
   a few minutes (navigate, open stages, type into the checklist). You should
   notice no change — this is the "legitimate user" baseline.
2. (Optional stress test, only if you want to confirm the cap) Open the
   browser dev tools → Network tab. Pick a case you don't have adviser access
   to (one assigned to another CA). Try to open it repeatedly (browser
   back/forward or hard refresh) ten+ times in under a minute.
3. Watch for a 429 response in the Network tab after the 11th attempt. The UI
   should surface it as a "please slow down" / rate-limit message, not as a
   generic error.

**Expected**

- Normal browsing never trips the limit.
- Rapid re-attempts on cases you don't own eventually 429 instead of looping
  Zoho requests.
- You, hitting your own cap, do not affect other CAs on the same office IP.

**Regression indicator**

- You see a 429 during normal single-user browsing (not stress-testing).
- Another CA reports "I got rate-limited and I'd barely clicked anything" —
  check whether the rate-limit response includes the current user id in its
  payload; if the id doesn't match, keying has regressed to per-IP.

---

## Item 6 — Role updates on password login

**Status:** fixed, on staging (commit `f7f6f93`).

**Before:** after an admin changed your role in User Management, the new role
only took effect on a Microsoft SSO sign-in. If you'd been using the Phase-1
password login, the stale role (`fh_role` localStorage key) stuck until you
cleared browser storage.

**What changed:** `/auth/login` (password path) now calls `setRole` on the
successful login response, exactly like the SSO path has done since launch.

**Steps**

1. Ask an admin (or do it yourself if you're an admin) to flip a password-only
   test user's role in User Management — for example from `ca` to `admin`,
   or back.
2. On a browser where that test user is signed in with password login, sign
   out, then sign in again with username + password.
3. Check that admin-only menu entries appear/disappear immediately after
   login. "User Management" is the easiest tell — visible as `admin`,
   hidden as `ca`.

**Expected**

- The new role takes effect on the first login after the admin changed it.
  No browser-storage clearing, no hard refresh needed.

**Regression indicator**

- You log in with the new role but still see the old UI (menus from the
  previous role). Opening dev tools → Application → Local Storage →
  `fh_role` and seeing the old value confirms the regression.

---

## Item 2 — WorkDrive errors surface properly, not as "contact not found"

**Status:** fixed, on staging (commit `d0d5d62`).

**Before:** `resolveCaseFolderId` wrapped every error in a generic "contact
not found" message, including Zoho auth failures, network timeouts, and
API-rate limit errors. CAs saw misleading errors and support thought the
case had bad contact data when the real problem was a Zoho API outage.

**What changed:** auth, network, and HTTP errors from the Zoho WorkDrive API
now surface with their actual cause. The "contact not found" message is only
returned when the Zoho Contact genuinely has no WorkDrive folder linked.

**Steps**

1. Open any case at Stage 2 or beyond where document upload is enabled.
2. Try to upload a document (any PDF). On a healthy staging environment this
   should succeed normally.
3. If you want to see the new error messages, Nishant can briefly rotate the
   staging Zoho auth token to force an auth failure — ask him before trying.
   On a forced failure you should see a message that mentions WorkDrive /
   Zoho auth rather than "contact not found".

**Expected**

- Normal uploads work.
- If something goes wrong on the Zoho side, the error names the real cause.
- A genuinely contact-less case (contact exists in Zoho but has no WorkDrive
  folder linked) still shows "contact not found" because that is the real
  cause for that one case.

**Regression indicator**

- A clearly-not-contact issue (your network is down, Zoho API is 503) shows
  "contact not found".
- Or the opposite — a real missing-folder case now shows a cryptic Zoho API
  error instead of the plain-English "contact not found".

---

## Item 1 — Approval guard — BUILT, DEPLOYED, SWITCHED OFF

**Status:** code is on staging; feature flag `COMPLETION_GUARD_ENABLED` is
`false`. Nothing you click will change behaviour today (commit `caf5060`).

**Why it's off:** we ran the guard over the last month of production
completions. It would have blocked **70 out of 86** cases that in fact
completed successfully. Three of those cases carried grid fields (Fund /
Contributions) that the current UI gives CAs no way to approve — so even
with best intent the guard would wedge those three permanently.

**What needs to happen before it goes on:**

- Aruna to confirm what "approved" means in the new world — in particular,
  whether the Contributions grid and Fund grid need per-row approval chips,
  and whether the two legacy contribution scalars count towards or against
  completion.
- KI-09 (the completion-gap invariant) and KI-17 (grid fields unapprovable
  through the UI) must both land first.

**What you can do today**

- Nothing to click for the guard itself.
- If you want to see the gap it was built to catch: approve a Stage 4
  checklist with one row left blank, push the case to Stage 10. The case
  completes. This is exactly the behaviour the guard would block, once Aruna
  signs off.

---

## Item 4 — Fund duplication — NOT BUILT

**Status:** rule designed, not implemented. Waiting on an adviser confirming
whether a client can legitimately hold the same fund twice at the same value
(same ISIN, same units, same valuation).

**Prod impact:** one case affected. That case has never been exported, so no
downstream contamination.

**What you can do today**

- Nothing to click. If you spot a second fund-duplication case while
  testing, note the case ID and the two offending fund rows and send to
  Nishant — we need two or three real examples before the rule is
  worth writing.

---

## Item 5 — Manual MP3 upload — NOT A BUG, FEATURE REQUEST

**Status:** no fix. Filed as a feature request —
`docs/handover/manual-mp3-upload.md` (commit `434a390`).

**Why it's not a bug:** the backend route `POST /cases/:id/calls/upload`
has existed since `d81a9e8` and never had a frontend caller — it's
unfinished work from the Palindrome branch, not a regression that broke
something that previously worked. There is no UI button today, so there is
nothing failing.

**What you can do today**

- Nothing to click. The existing audio ingestion flow (CA drops the file
  into the case's WorkDrive "Recordings" folder, the watcher picks it up)
  continues to work. The manual-upload button would be an alternative path,
  not a replacement.

---

# PART 2 — Other fixes shipped this session

## A — Count unification across Stage 4, 6, 8 and 10

**Status:** fixed, on staging (commit `32e683b`).

**What it closes:** Carmel's "2 missing" tile that showed up on 27 of her
PENSION cases. Pre-fix, four stages each had their own count implementation
and they disagreed with each other — Stage 4 might say 72, Stage 8 say 69,
Stage 10 say 70, Stage 6 "all approved" even though scalars were missing.
The specific 2-missing complaint was that two legacy Contributions scalar
fields (confidence = literal string "MISSING") were being counted by Stage 10
but hidden from the ApprovalWorkspace at Stage 8, so Carmel had no way to
action them from the UI.

**What changed:** all four stages now call one shared helper
(`useCaseCompletionStats`). The two Contributions-scalar legacy fields are
no longer counted individually — they fold into the Contributions grid
"synthetic slot". A new "Grids reviewed" tile shows up on the Stage 10 KPI
panel so grids are explicit in the completion picture, not invisible.

**Steps**

1. Pick one of Carmel's cases if you can find one, or any PENSION case
   where the Contributions section has data (contrib_annual_employer and
   contrib_annual_personal from the AI).
2. Walk the case through Stage 4 → Stage 6 → Stage 8 → Stage 10.
3. On each stage, note the number shown ("X/Y approved" or "X/Y filled" —
   the wording varies but the denominator should be the same).
4. On Stage 10, confirm a new "Grids reviewed" card is visible when the
   case has either a Fund grid or a Contributions grid with data.

**Expected**

- The denominator (`/Y`) is identical across Stage 4, Stage 6, Stage 8 and
  Stage 10 for the same case.
- Carmel's "2 missing" tile no longer appears on PENSION cases that have
  normal Contributions data.
- Stage 10 shows the new "Grids reviewed" card.

**Regression indicator**

- Different `/Y` denominators across the four stages for the same case.
- A PENSION case completing Stage 4 at "all approved" but still showing
  "2 missing" on Stage 10.

---

## B — Mirror boundary — AI can no longer write to case details

**Status:** fixed, on staging (commit `993141f`).

**What it closes:** a real leak. Three columns on the Case row —
`providerId`, `policyRef` and `planStartDate` — could be written by the AI
extraction via the checklist→case mirror. Over time:
- 18 prod cases had placeholder providers written by the AI ("Unknown
  Provider", "Other/Unknown", "TEST").
- **125 prod cases had `Case.planStartDate` written by the AI.** 94 of those
  had reached Stage 10 and were exported to Zoho's `Plan_Start_Date` field.
  Zoho's upstream sync never writes that field, so Zoho now holds AI-sourced
  start dates on 94 live cases. (We're leaving those untouched for now as
  evidence; separate decision on cleanup.)

**What changed:** `mirrorChecklistToCase` now takes a `source: "ai" | "ca"`
parameter. Any call from the AI write-back path passes `"ai"` and the mirror
returns immediately without touching the case row. CA-initiated edits
(manual edit, seed with value, bulk mark-missing-N/A) pass `"ca"` and
continue to work exactly as before.

**Steps — CA path still works**

1. Open any case at Stage 4 whose header shows no provider / no plan number
   / no start date (or shows one you can change).
2. In the Stage 4 checklist, edit the "Provider name", "Plan number" or
   "Start date" row to a new value and save.
3. Check the case header at the top of the page — the new value should
   appear within a second.

**Steps — AI path blocked**

1. Create a fresh PENSION case or use one you haven't yet run the AI on.
2. Upload a plan statement PDF and run the AI extraction (Stage 3).
3. Look at the case header — provider, plan number and start date should
   show whatever Zoho sent (or stay blank if Zoho didn't send them). The AI
   values appear in the Stage 4 checklist rows but do NOT overwrite the
   case header.
4. Any mismatch between what the checklist shows and what the header shows
   is the CA's call to resolve — editing the checklist row (as above) will
   propagate, running the AI will not.

**Expected**

- CA edits to provider / plan number / start date on the checklist row
  flow to the case header.
- AI extractions never change the case header's provider / plan number /
  start date.

**Regression indicator**

- You run the AI on a fresh case and the case header provider / plan number
  / start date suddenly populates to whatever the AI said — without a CA
  typing it. That is the leak re-opened.
- Or the opposite — a CA types a new provider name into the checklist and
  the header does NOT update. That is the CA path broken.

---

## C — Provider name mismatch flag (case-vs-AI conflict)

**Status:** fixed, on staging (commit `268a139`).

**What it closes:** before this, an AI extraction that read a different
provider name from the operator-picked Case provider wrote silently to the
checklist. The CA had no way to notice. Now the row is flagged CONFLICT
with a two-side "pick a value" resolver — one side showing the Case header
value, the other showing the extraction. **Neither side writes to
Case.providerId.** The Case stays operator-owned.

**Fire conditions** (all four required, or the flag doesn't fire):

- The checklist "Provider name" field is not null and not "N/A".
- The Case header provider is set AND is not one of the placeholder stubs
  (`TEST`, `Unknown Provider`, `Other/Unknown`, `Unknown`, `N/A` — these
  all came from pre-mirror-gate AI writes on 18 historical cases; we
  don't flag against them).
- `compareFieldValues` with `Case.provider.name` as the canonical returns
  "different". This commit also fixed the possessive normaliser, so
  "St James's Place" vs "St James Place" no longer false-flags.

**Steps**

1. Open any PENSION case where the Case header shows a real provider
   (not blank, not one of the placeholders). The best test case is one
   where you can run or re-run the AI extraction on a document whose
   provider reads differently from the header.
2. Trigger the AI extraction (Stage 3). Wait for Stage 4 to populate.
3. Scroll to the "Provider name" row in the Stage 4 checklist.

**Expected (mismatch case)**

- Row shows a red CONFLICT chip, same style as a doc-vs-doc conflict.
- Below the row, a two-candidate resolver appears with heading
  **"Case header disagrees with the extraction — pick a value"**.
- First card labelled **"Case header"** shows the Case provider name
  with the line "from case header" (no "from X.pdf").
- Second card labelled **"Extracted"** shows the AI's reading with
  "from <doc name>, p.<n>".
- Clicking "Use this value" on either card:
  - picking Case header → checklist row flips to the Case provider name
  - picking Extracted → checklist row keeps the AI reading
  - either way, the Case header provider on the top of the page does
    NOT change.

**Expected (no mismatch)**

- If the AI reads the same provider as the Case header (possibly after
  the possessive / alias normalisation), no conflict chip appears. The
  row shows HIGH / MEDIUM / LOW confidence as usual.

**Possessive-check sub-test**

- Set the Case header to a provider called "St James Place" (or any
  provider whose true name has a possessive apostrophe). Run the AI
  against a doc that calls it "St James's Place" or vice versa. The
  mismatch flag should NOT fire — these are now treated as equivalent.

**Regression indicator**

- Case header provider changes after you resolve the conflict. The
  mirror boundary from 993141f means this must never happen.
- Mismatch flag fires on St James's Place vs St James Place (possessive
  normaliser broken).
- Mismatch flag fires when the Case header is one of the placeholder
  stubs (`TEST`, `Unknown Provider`, `Other/Unknown`, `Unknown`, `N/A`)
  — we shouldn't flag against a placeholder.
- Mismatch flag does NOT fire on a case with a real Case provider +
  AI reading a genuinely different provider (e.g. Case says "Aviva",
  AI reads "Prudential").
- Legacy doc-vs-doc conflicts (two PDFs disagree on the same field)
  still show the old heading "Two sources disagree — pick a value"
  and labels "Existing" / "New" with doc provenance. If those also
  changed, something's wrong with the source discriminator.

---

## D — Checklist template mismatch banner

**Status:** fixed, on staging (commit `94f1fba`).

**What it closes:** nine prod cases have checklist rows keyed to an older
plan type than the case currently is (someone changed the plan type after
the AI had already seeded a different template set). The system has been
logging `CHECKLIST_TEMPLATE_MISMATCH_DETECTED` audits on these cases for
weeks, but the CA had no UI signal — the audits only showed up in the
database. Now a red banner surfaces on the case detail page the moment the
case has any orphan rows.

**What changed:**

- `GET /cases/:id` now returns `templateMismatchRowCount` — the count of
  checklist rows whose template plan type doesn't match the case's current
  plan type. Server-side one-liner, no new endpoint.
- `CaseDetail` renders a red banner (same shape as the out-of-scope plan
  type banner) when that count is > 0. The banner names the current plan
  type and points at `POST /admin/cases/:id/reset-plan-type` as the repair
  path.

**Steps**

1. Pick one of the known orphan-plan-type cases listed in
   `docs/handover/orphan-plantype-cases-record.md` (there are 9). If you
   don't have a convenient way to query which, ask Nishant for the IDs.
2. Open the case in staging.
3. Look at the top of the case detail page, below the header.

**Expected (orphan case)**

- A red-bordered banner is visible with heading **"Checklist template
  mismatch — admin reset required"**.
- The banner lines up vertically alongside (or in place of) the existing
  "Plan type out of scope" banner on affected cases.
- Message says "This case has <N> checklist rows keyed to a different
  plan type than the case (<planType>)" with N matching the actual
  orphan count and planType being the current Case.planType.
- The repair command `POST /admin/cases/:id/reset-plan-type` is called
  out in a code span.

**Expected (healthy case)**

- No banner. Clean case detail header as usual.

**Admin-reset follow-up (optional)**

- If an admin runs `POST /admin/cases/:id/reset-plan-type` on an orphan
  case, orphan rows are deleted and the banner disappears on next page
  load. This is unchanged behaviour — the banner just surfaces the state
  that was already queryable in `audit_logs`.

**Regression indicator**

- Banner shows on a case with no orphan rows (false positive — count
  must be > 0).
- Banner does NOT show on a case that has orphan rows (the GET endpoint
  isn't computing templateMismatchRowCount, or the frontend isn't
  reading it).
- Banner shows a wrong count (e.g. 0 but you can see from audit log that
  mismatch audits exist). The audit log is historical; the banner tracks
  current state — if orphan rows have been cleaned up, no banner even if
  past audits exist. That's correct, not a bug.

---

# Not regressions — two things that look like they changed

Please don't flag these as bugs; they are intentional consequences of fix A.

## Stage 8 progress bar sometimes drops by ~4 points

Before fix A, Stage 8 counted the two Contributions-scalar legacy fields
towards the approved total even though the UI had no way to approve them —
so "approved / total" came out higher than it should have. After fix A those
two scalars fold into the Contributions grid synthetic slot, so the
denominator shrinks and the numerator shrinks slightly more, netting a
~4-point drop on cases that had Contributions scalars. The new number is
honest; the old number was flattering.

## Stage 6 total changes on cases with sections switched off

Stage 6 now uses the same shared helper as the other stages, which respects
the optional-section switches. If a CA has turned off (for example) the
"Benefits" section on a case, Stage 6's total drops by the number of fields
in that section. Previously Stage 6 counted switched-off sections too, so
its total was always the "all sections on" total. The new number reflects
what the CA actually asked to be filled.

---

## Where this fits with the KI log

For your reference while testing:

- **KI-09** — completion-gap invariant (gated behind Item 1's flag)
- **KI-13** — Zoho token cache 401 handling (fixed earlier)
- **KI-14** — palindrome-submit memory buffering (documented, not yet fixed)
- **KI-17** — grid fields unapprovable through the UI (open — part of why
  Item 1 is off)
- **KI-18** — template drift placeholder (filed this session)
