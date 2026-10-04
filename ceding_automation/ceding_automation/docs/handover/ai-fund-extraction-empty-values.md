# AI fund extraction — rows with names, no values

**Filed:** 2026-10-05
**For:** whoever owns the AI pipeline / BFF extraction evaluation layer
**Severity:** medium — not causing a frontend bug now, but it's a data-quality
problem the evaluation stage should catch before it reaches the application.

## What's happening

On at least one case (staging FH-2026-000135, David Armstrong, Pension),
the AI pipeline extracted 4 fund-line rows into `checklist_fund_lines`
with **fund names populated and every numeric field null**:

```
1. "Scot Eq Invesco Stmkt Mgd (ARC) Pn (S)"
   value=null  units=null  price=null  confidence=HIGH  status=AI_EXTRACTED
2. "Scot Eq UK FixInt&Gl EqTrk ARC (S)"
   value=null  units=null  price=null  confidence=HIGH  status=AI_EXTRACTED
3. "Scot Eq Pacific ARC (S)"
   value=null  units=null  price=null  confidence=HIGH  status=AI_EXTRACTED
4. "Aegon BNY Mellon Mit Ast Bal ARC Pn (S)"
   value=null  units=null  price=null  confidence=HIGH  status=AI_EXTRACTED
```

Four rows, four fund names, zero numeric data. All marked confidence=HOIGH.
The rows look complete to a database skim and show as 4 rows in the Fund
Details table on screen — but the client-facing Excel + Zoho Plans record
have nothing to say about valuations, holdings, or allocations for this
case.

## How it surfaced on the frontend

Revathy's 2026-10-05 retest flagged the Stage 10 KPI panel showing
"Grids reviewed 0/3, 0 populated" alongside a Fund Details table that
visibly contained 4 rows. We confirmed the frontend count path is
correct — `isMissing(row)` returns true for a row whose `value` is null
or empty, so the fund-grid aggregator correctly classifies all 4 rows
as missing and reports 0 populated. The frontend is honest about the
underlying data gap.

Short-term UX fix shipped on the frontend side today
(commit on the batch following the stage-count unification): the
sub-text now reads "0 of 4 fund rows have values" when rows exist but
all lack values, so a CA understands the message. That's a wording
fix, not a data fix — the underlying extraction gap stands.

## Why this is an AI-pipeline concern

Four symptoms from one extraction:

1. **The AI returned HIGH confidence on rows with no values.** HIGH
   confidence on a row where units / price / value are all null is
   self-contradictory. The confidence should reflect "we got all the
   data we were looking for"; if the pipeline is instead reporting
   per-field confidence and lifting the row-level up to HIGH when a
   name is extracted, that signalling needs reworking.

2. **Fund NAMES extracted but numeric fields missed.** Suggests the
   extraction prompt is finding the fund table layout (so it picks up
   the name column) but failing on the value columns. Could be a
   provider-specific statement format (Aegon / Scottish Equitable here
   — "Scot Eq" prefixes suggest a Scottish Widows / Aegon merge-era
   format). Worth checking whether other Scottish Equitable / Aegon
   extractions on prod show the same shape.

3. **The evaluation layer let it through.** A completeness check at
   extraction time — "if row has fundName but no value / units /
   price, flag as low-confidence or skip insertion" — would prevent
   this reaching the DB with HIGH confidence. The schema allows null
   on each numeric field for legitimate reasons (price-only when
   units unknown, etc.), so the right place to catch "all three null"
   is the pipeline's own post-extraction validation.

4. **No conflict signal.** `confidence=HIGH` with null values didn't
   trip any existing CONFLICT path either. The AI apply logic in
   `backend/src/services/aiBffApply.ts applyFundLines` writes whatever
   it's given — it does not validate that numeric fields are
   populated before inserting. If the pipeline is going to send
   confidence=HIGH, apply trusts it.

## What a fix might look like

Three places where this could be caught, in order of ownership:

1. **Pipeline extraction prompt / parser (preferred):** when the
   model returns a fund row, require either (name + value) or (name +
   units + price). If only name was found, don't emit the row — or
   emit with confidence=MISSING and a reason.

2. **Pipeline evaluation stage:** post-extraction, before dispatching
   to the application, run a per-row completeness check. Rows that
   fail → downgrade confidence to LOW or MISSING, OR drop with a log
   line so the pipeline operator sees "4 rows dropped on David
   Armstrong — name-only, no numeric data".

3. **Application-side guard (last resort):** `applyFundLines` could
   refuse to insert a row with all three numeric fields null, OR
   insert them but force `confidence="MISSING"`. This masks the
   pipeline's signal though — better to catch upstream.

## Prevalence — not quantified

I checked one case (David Armstrong on staging). A broader prod query
would say whether this is a one-off or systemic. SQL would be:

```sql
SELECT c."caseRef", c."clientName", fl.*
FROM checklist_fund_lines fl
JOIN cases c ON c.id = fl."caseId"
WHERE fl.value IS NULL
  AND fl."numberOfUnits" IS NULL
  AND fl."pricePerUnit" IS NULL
  AND fl."fundName" IS NOT NULL
  AND fl.status = 'AI_EXTRACTED'
ORDER BY fl."createdAt" DESC
```

Easy follow-up for someone looking at this.

## Related

- Case: staging FH-2026-000135 David Armstrong (prod FH-135 is a
  different client; Mirae Parkhouse on prod has fully-populated fund
  rows).
- Frontend wording fix: commit on the 2026-10-05 batch following
  `c096670`.
- Not yet filed as a KI because it belongs to the AI layer, not this
  repo. If it reaches a sprint ticket, this doc is the writeup.
