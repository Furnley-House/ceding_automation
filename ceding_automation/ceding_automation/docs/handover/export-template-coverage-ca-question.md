# Export vs template coverage — question for the CA team

**For:** CA team (via Aruna / Nishant)
**From:** 2026-10-01 audit session
**Status:** Question, not a bug

## Background

The Stage 9 export (`frontend/src/lib/exportTemplate.ts`, specifically the
`PENSION_ROWS` array) is a deliberate fixed-layout replica of the CA team's
manual checklist XLSX template — same row numbers, same row order, intended
to be a drop-in replacement for the manual document.

A 2026-10-01 full join of `PENSION_ROWS` keys against active prod PENSION
template keys found **62 of 62** export keys match an active template.
Zero stale references, zero silent empty cells. The export is working as
designed.

However, the **reverse** direction surfaces 8 active prod PENSION template
keys that do **not** appear in `PENSION_ROWS`. 2 of those 8 are handled
elsewhere (see below). The remaining **6** are the question.

## Handled, not missing

These two template keys are composed inline into their value-counterpart's
cell as "As at DD/MM/YYYY" via a dedicated loop at
`exportTemplate.ts:414-427`, covered by a test at
`exportTemplate.test.ts:95-96`. Working as intended, no action needed.

- `current_value_as_of` — appears inside the Current Value cell
- `transfer_value_as_of` — appears inside the Transfer Value cell

## The six for CA to confirm

Each of these is a template field the app captures but the current export
XLSX does not write to any cell. For each one, we need the CA team to say:

> Is this field something you'd want to see in the exported XLSX, or is it
> deliberately out of scope for that document?

| fieldKey | fieldType | What it captures | Companion to |
|---|---|---|---|
| `regular_contribution_personal_frequency` | dropdown | How often the personal reg. contribution is paid (monthly / annual / etc.) | `regular_contribution_personal` (row 14 in export) |
| `regular_contribution_employee_frequency` | dropdown | Same, for employee contributions | `regular_contribution_employee` (row 15) |
| `regular_contribution_employer_frequency` | dropdown | Same, for employer contributions | `regular_contribution_employer` (row 16) |
| `withdrawal_details_frequency` | dropdown | Frequency of ongoing withdrawals | `withdrawal_details` (row 17) |
| `dfm_charge` | percentage | Discretionary Fund Manager charge | standalone — would need its own row |
| `contributions_breakdown_employer_personal` | text | Prose breakdown of employer-vs-personal contribution split | sits alongside `contributions_4yr_history` (row 21) — may be captured there already |

### Possible outcomes

For each row, three possible answers:
1. **Deliberately out** — the manual XLSX doesn't have a cell for it; CA
   team captures the data for app-internal use but doesn't export it. No
   action.
2. **Deliberately out of this export, exports elsewhere** — e.g. covered
   in a separate client-facing document. No action here, but worth
   confirming it does land somewhere.
3. **Should be in the export but isn't** — the manual XLSX has a cell for
   it we haven't wired up. Fix: extend `PENSION_ROWS` with the right row
   number, confirm against the manual template.

### Suggested approach

Ask the CA team to walk through their current manual XLSX for a Pension
case and confirm whether any of the six fieldKeys above correspond to a
cell they currently fill in by hand. If yes → outcome 3, needs a one-row
addition to `PENSION_ROWS`. If no → outcome 1 or 2, no code change needed.

## Not blocking anything

The current export is correct for every cell it writes. These 6 fields are
captured and visible in the app's Stage 4-8 workspaces — they're not lost
data, just not surfaced in the specific XLSX document. CAs can still see
them when reviewing the case; they just don't appear in the client-facing
export unless the CA copies them in by hand (which they may already do).

## Cross-refs

- `KI-17` (2026-10-01) — the broader "stages disagree on what complete
  means" KI. Export was initially framed as a disagreeing count there;
  that framing was corrected in the same session's follow-up commit.
- `exportTemplate.ts:34-114` — the `PENSION_ROWS` definition that would
  grow by one row per confirmed outcome-3.
