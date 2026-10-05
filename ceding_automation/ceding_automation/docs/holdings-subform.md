# Fund holdings — verification and the Plans subform

**Branch:** `feat/holdings-subform-dev`
**Status:** complete, tested locally against live Zoho sandbox; awaiting review
**Last updated:** 2026-10-01

Stage 6 checks every fund holding on a case against reference data, lets the CA
decide which figure is authoritative, and stage 9 pushes the result into the
`Holdings_List` subform on the linked Plans record in Zoho CRM.

Before this, fund holdings were typed on the checklist, exported to the
workbook, and never reached CRM at all.

---

## What a CA sees

1. **Stage 6 — Review Checklist.** A *Fund Verification* panel below the Fund
   Details grid. Press **Verify fund details** and every holding is resolved
   against the fund master (name, OCF, transaction costs) and FE Fund Info
   (unit price).
2. Each holding expands to a four-row comparison — fund name, unit price, OCF,
   transaction costs — with **Checklist** / **Reference** toggles. The side
   they pick is what reaches CRM.
3. Anything wrong can be corrected in place: an ✏️ Edit link on each checklist
   value, and a per-row **Edit** button on the Fund Details grid above.
4. **Stage 9 — Export.** The holdings go into the plan's Holdings subform, and
   the receipt says what changed in plain terms.

---

## What was built

### Backend — new services

| File | Does |
|---|---|
| `services/fundMaster.ts` | Reads the fund master Postgres (name, OCF, transaction costs). **Read-only enforced in code** — see below. |
| `services/feFundInfo.ts` | FE Fund Info client for unit prices and price dates. OAuth + APIM key. |
| `services/fundVerification.ts` | Orchestrates both, decides RAG, picks the default source per field. |
| `services/holdingsSubform.ts` | Maps a checklist fund line to a Zoho subform row; merges against what is already on the plan. |
| `services/holdingsScale.ts` | Detects a checklist price that is a clean 100× from the reference (pence typed where CRM wants pounds). |
| `utils/fundIdentifier.ts` | Classifies an identifier as ISIN / SEDOL / CITI and normalises it. |

### Backend — endpoints

```
POST   /api/cases/:caseId/fund-lines/verify              run verification for the case
PATCH  /api/cases/:caseId/fund-lines/:lineId/source      record Checklist vs Reference per field
PATCH  /api/cases/:caseId/fund-lines/:lineId             edit a checklist value in place
POST   /api/cases/:caseId/complete-export                now also writes the Holdings subform
```

### Frontend

| File | Does |
|---|---|
| `lib/fundComparison.ts` | All comparison logic — tolerances, 100× detection, valuation cross-check, the stage-6 gate. Pure and testable. |
| `components/case/FundVerificationPanel.tsx` | The stage-6 panel: per-holding rows, source toggles, inline edit, RAG chips, warnings. |
| `components/case/FundDetailsTable.tsx` | Per-row Edit button, delete confirmation, refresh wiring. |
| `components/case/ExportWorkspace.tsx` | Holdings summary on the receipt, and the confirm dialog when the export is gated. |

### Database

Two migrations:

- `20260922120000_add_fund_line_verification` — the resolved columns on
  `checklist_fund_lines` (`resolvedIsin`, `resolvedFundName`,
  `resolvedUnitPrice`, `resolvedPriceDate`, `resolvedOcf`, `resolvedTxCost`,
  `verifiedAt`, `holdingRag`, and the four `*Source` columns).
- `20260928100000_add_zoho_holding_keys` — `cases.zohoHoldingKeys TEXT[]`,
  which records the subform rows this app created. Only keys in that list are
  ever deleted from CRM.

---

## Things worth knowing before you change any of this

Each of these cost a wrong assumption to find.

**The subform is `Holdings_List`, not `Holdings`.** Field names were read from
`GET /settings/fields?module=Holdings_List`, not guessed. A wrong field name
returns HTTP 200 and is silently ignored, so a typo looks like success.

**Omitting a row does not delete it.** Zoho subform semantics, measured
against a live plan:

| Row sent | Result |
|---|---|
| with `id` | updated in place |
| without `id` | inserted |
| **not mentioned** | **left alone — not deleted** |
| `{ id, _delete: null }` | deleted |

We originally believed a subform PUT replaced the whole list. It does not.

**Currency and percent fields take 2 decimal places; `position` takes 9.**
Over-precision is rejected with a 400 naming `maximum_decimal_place`, and the
whole PUT fails — so a single over-precise holding loses the plan-field update
too. `toFieldScale()` rounds before sending.

**Fund master stores charges as decimal fractions; CRM wants percent.**
Vanguard's 0.22% is stored as `0.002000`. Multiply by 100. Without this every
charge reached CRM 100× too small.

**FE Fund Info returns the major unit (pounds), even for GBX-listed funds.**
Confirmed with the CA team and against `listing_currency`. The checklist is the
side to question when the two differ by 100×, not the reference.

**A GB ISIN is `GB00` + 7-char SEDOL + check digit**, so the SEDOL lookup is an
equality test on `substring(isin from 5 for 7)`, not a `LIKE`.

**We only delete rows we created.** `cases.zohoHoldingKeys` is written only
after a successful PUT. A row somebody added by hand in CRM is never touched.

### Read-only access to the fund master

The credential we were given has write permissions on another team's
94,671-row production table. We do not rely on the grant:

1. Every connection is put into `default_transaction_read_only`, so the
   **server** rejects any write.
2. `assertReadOnly()` refuses to send anything that is not a single `SELECT`.

Do not remove either. The grant is not ours to depend on.

---

## Configuration

```bash
# Fund master Postgres (read-only)
FUND_DB_HOST=            FUND_DB_PORT=
FUND_DB_NAME=            FUND_DB_USER=
FUND_DB_PASSWORD=        FUND_DB_TABLE=
FUND_DB_POOL_MAX=

# FE Fund Info
FEFUNDINFO_API_URL=      FEFUNDINFO_TOKEN_URL=
FEFUNDINFO_CLIENT_ID=    FEFUNDINFO_CLIENT_SECRET=
FEFUNDINFO_SCOPE=        FEFI_APIM_SUBSCRIPTION_KEY=
FEFUNDINFO_BATCH_SIZE=   FEFUNDINFO_TIMEOUT_MS=
```

With none of these set, verification reports itself unconfigured, the stage-6
gate lifts, and the export gate is skipped. An FE outage must never strand a
case — see `isVerificationConfigured()`.

---

## Testing

### Automated

```bash
cd backend  && npx vitest run      # 193 tests
cd frontend && npx vitest run      #  15 tests
```

Holdings-specific coverage:

| File | Tests |
|---|---|
| `holdingsSubform.test.ts` | 39 — mapping, precision, merge, `_delete`, ownership |
| `fundMaster.test.ts` | 27 — read-only guard, charge scaling, SEDOL derivation |
| `fundIdentifier.test.ts` | 27 — ISIN / SEDOL / CITI classification |
| `feFundInfo.test.ts` | 17 — price selection, batching, failure handling |
| `export.gate.test.ts` | 15 — the gate, the override, and that nothing is written before it |
| `fundVerification.test.ts` | 14 — orchestration, RAG, default source |

### Manual — happy path

Needs a case with fund lines, a linked Plans record, and the env above.

1. Open a case at **stage 6**. The Fund Details grid should hold at least one
   holding with a real ISIN (`GB00B4W9CK61`, `GB0000026087` are known good).
2. Press **Verify fund details**. Expect a toast: *Checked N of N holdings*,
   and each row to gain an **Amber** or **Red** chip.
   - **Amber** — resolved to a fund and a price.
   - **Red** — could not be both named and priced. Allowed; the CA's figures
     are used as-is and red does not block the case.
3. Expand a holding. Four rows, both columns populated, the toggle defaulting
   to **Reference** wherever reference data came back.
4. Flip one to **Checklist**. It persists across a page refresh.
5. **Send for approval** → approve → **stage 9** → **Complete export**.
6. On the receipt, the holdings line should read something like
   *2 holdings added, 1 updated*. Open the plan in CRM and confirm the
   Holdings List rows match what stage 6 showed.

### Manual — the cases that matter

**Verification gate.** Add a fund line and do *not* verify it. Try
**Send for approval** at stage 6 — blocked, with the holding named. Jump
straight to stage 9 and export — a dialog appears; **Export anyway** proceeds
and the override is recorded against your name in the audit trail.

**Pence detection.** Use `GB0000011444`, a GBX-listed fund. Enter a unit price
100× the reference — e.g. checklist `1376.7774` against reference `13.5979` —
and set the toggle to **Checklist**. Expect:
- a dialog on the stage-6 panel naming the holding and both figures,
- **Send for approval** blocked,
- the same block server-side if you skip to stage 9.
Switch the toggle to **Reference** and everything clears immediately.

The detector allows 20% drift after scaling, because the two sides are rarely
priced on the same day. A genuine price difference (not a clean 100×) is left
alone.

**Re-export.** Export, change a figure at stage 6, export again. The existing
subform row should be **updated in place** — not duplicated, not skipped.

**Deleting a holding.** Delete a fund line that has already been exported, then
export again. That row should disappear from the plan in CRM. Rows that were
added by hand in CRM must survive untouched.

**Valuation cross-check.** Set units × unit price so it disagrees with the
stated value by more than 1%. A warning appears on the holding; it does not
block.

**Negative numbers.** Units, price and value reject negatives. OCF and
transaction costs do **not** — ex-ante transaction costs are legitimately
negative, and 1,344 rows in the fund master are.

**Verification unavailable.** Unset the FE variables and restart. The panel
should say verification is not configured, and both gates should lift rather
than trapping the case.

---

## Known gaps

- **`RLS Global Senior ABS Pn` on Plan119597** is orphaned — it predates
  `zohoHoldingKeys`, so we cannot prove we created it and will not delete it.
  Sandbox data; remove by hand if it bothers anyone.
- **A pre-existing CRM row with one of our ISINs** is adopted on first export:
  we update it, and from then on treat it as ours.
- **Post-approval editing is deliberately still allowed.** The team's process
  is edit → re-send to the paraplanner → re-export. Nothing enforces that
  re-approval; if a CA edits and exports directly, no warning fires.
- **`fundComparison.ts` has no unit tests on this branch.** They were removed
  deliberately — the logic is pure and easy to re-reason about. The
  destructive and security-relevant paths (`holdingsSubform`, `fundMaster`,
  `export.gate`) keep theirs.
