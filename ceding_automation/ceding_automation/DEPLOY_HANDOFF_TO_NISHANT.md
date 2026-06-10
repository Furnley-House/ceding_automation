# Deploy handoff — `develop` → staging
**From:** Rev · **For:** Nishant (or his Claude Code)
**Window covered:** 2–10 June 2026 (post `feature/ai-bff-integration` merge)
**Branch:** `develop`
**Local commit ready to push:** `59af584` "feat: BFF AI integration, export route, fund details, Zoho field caching, and schema migrations" + uncommitted changes from the Emma→Megan switch

---

## TL;DR

Three days of fixes on top of your BFF integration. Two destructive Prisma migrations need to apply on the staging DB. One data-migration script needs to run **post-deploy** to clean up legacy paraplanner refs. One OAuth re-authorisation needed for new Zoho scopes (WorkDrive + custom modules + contacts).

I tested everything locally against a local Postgres. Couldn't test against staging because that's where the BFF integration lives. The changes are designed to be safe but I want you to sanity-check before pushing to prod.

---

## 1. What changed at a glance

| Area | Summary |
|---|---|
| **Approval loop** | Full CA → Paraplanner → CA handoff now works end-to-end. Many small fixes (stage mapping, role-aware landing, notification dedup, returned-fields banner on Stage 6, send-anyway button, etc.) |
| **Zoho integration** | All Zoho IDs cached on the Case row at sync time; export reads only local DB. Contact-driven user-lookup field copy. Providers-module search by name. `/users` cache for email→id resolution. New OAuth scopes added (`modules.ALL`, `WorkDrive.files.ALL`, `WorkDrive.team.READ`). |
| **Stage 9 export** | Single "Complete export" button → downloads XLSX locally + uploads to WorkDrive + PATCHes Plans-module in one call. New Fund Details sheet in the workbook. |
| **Fund Details table** | BFF `fund_lines[]` are now persisted into `ChecklistFundLine`. New `FundDetailsTable` component (editable on Stage 4, read-only on Stages 6 + 8). New XLSX sheet. |
| **Checklist→Case mirror** | When `provider_name` / `plan_number` / `start_date` get filled (AI or manual), they're projected onto `Case.providerId / policyRef / planStartDate`. |
| **DB cleanup** | Reconciled DB checklist templates with canonical JSON (deactivated 63 orphans). Dropped redundant columns (`Provider.acceptedSigType`, `Case.planSubType`, `CallScript.providerPhone/Dept`) + `PlanSubType` enum. Notification dedup with 5-min window. |
| **Dashboard cleanup** | Removed 4 mock-data tiles (On hold / AI confidence / Phase medians chart / Median provider response). New "Prepare for SR" CTA when all client cases are complete (opens Zoho Contact in a new tab). |
| **Test wiring** | Demo paraplanner switched from dummy "Emma Clarke" → real "Megan Doherty" (already a Furnley House user). |
| **"Missing" unification** | Single `isMissing(row)` / `displayValue(row)` helper used by Stages 4 / 5 / 6 / 8 / Export. AI write-back now normalises the literal string `"MISSING"` → `null` + `confidence=MISSING` so the UI counters agree across stages. Plus a one-shot cleanup script for legacy rows. |

Full per-day breakdown: see `CHANGELOG_2026-06-02_to_06-04.md` at the repo root.

---

## 2. Migrations that will apply on staging deploy

Three migrations are in `backend/prisma/migrations/` and will apply via `prisma migrate deploy`:

| Migration | Type | Risk |
|---|---|---|
| `20260602154309_add_document_deleted_audit_action` | `ALTER TYPE ... ADD VALUE 'DOCUMENT_DELETED'` | None — additive |
| `20260603182332_cache_zoho_ids_on_case` | Adds 5 nullable columns on `cases` | None — additive |
| `20260604120000_drop_redundant_columns` | **Drops 4 columns + 1 enum** | ⚠ Destructive. Confirmed safe via audit (columns were either pure duplicates of another column or never populated). See `backend/prisma/migrations/20260604120000_drop_redundant_columns/migration.sql` for the SQL. |

**Pre-deploy snapshot recommended** — `pg_dump` the staging DB before running. Not required, but cheap insurance.

---

## 3. OAuth re-authorisation needed

The `buildAuthorizeUrl` consent URL added these scopes during the export work:

```
ZohoCRM.modules.ALL          # custom Plans module access
ZohoCRM.modules.contacts.READ
WorkDrive.files.ALL
WorkDrive.team.READ
```

The existing staging `ZOHO_REFRESH_TOKEN` was minted before these scopes existed, so it can't access the Plans module or WorkDrive. You'll see errors like `OAUTH_SCOPE_MISMATCH` / `F7007 Invalid OAuth scope` until re-auth.

**To fix:**
1. In a browser logged into the Zoho org, open: `https://<staging-backend>/api/crm/oauth/authorize`
2. Approve the consent screen (will list all the new scopes)
3. The callback page prints a new refresh token
4. Update the staging environment's `ZOHO_REFRESH_TOKEN` secret (Key Vault or whichever you use)
5. Restart the Container App revision so the token cache picks up the new value

---

## 4. New env vars (optional but useful)

All have sensible defaults. Override only if your CRM uses different field names:

```bash
# Zoho CRM module names (defaults in parens)
ZOHO_PLAN_MODULE=Plans                              # (Plans)
ZOHO_PROVIDER_MODULE=Providers                      # (Providers)
ZOHO_PROVIDER_NAME_FIELD=Name                       # (Name)

# Zoho CRM Contact field names
ZOHO_CONTACT_FIELD_CLIENT_OWNERS=Client_Owners      # (Client_Owners)
ZOHO_CONTACT_FIELD_PARAPLANNER=Paraplanner          # (Paraplanner)
ZOHO_CONTACT_FIELD_OWNER=Owner                      # (Owner)

# WorkDrive folder for exports + recordings
ZOHO_WORKDRIVE_FOLDER_ID=a7yip2d39bf2cd6074a09a5190cf73e7a61bf
# (currently hardcoded as a default in services/workdrive.ts for the sandbox;
# set this env var for prod to override cleanly)
```

---

## 4a. "Missing" field unification (10 Jun)

**Problem this fixed:** the AI sometimes wrote the literal string `"MISSING"` into `ChecklistField.value` when the source PDF itself printed `MISSING` in a form box. The UI was inconsistent — Stage 4 (Extract) showed those as filled (because `value` was truthy), but Stage 5 (Call) / Stage 6 (Review) / Stage 8 (Approval) / the Export each had slightly different ad-hoc checks. Counts disagreed across screens, and "MISSING" leaked into the downloaded XLSX.

**What changed:**

1. **Shared helpers** in [frontend/src/hooks/useChecklistFields.ts](frontend/src/hooks/useChecklistFields.ts):
   - `isMissing(row)` — true if `value` is empty/whitespace, OR `value.toUpperCase() === "MISSING"`, OR `confidence === "MISSING"`.
   - `displayValue(row)` — returns `"—"` for missing rows, trimmed value otherwise. Use this in tables instead of `row.value ?? "—"`.

2. **Stages 4 / 5 / 6 / 8 + Export** all import and use these helpers — no more local `!row.value` checks. Stats counters, filters, bulk-approve targets, and XLSX columns are now in lock-step.

3. **Backend AI write-back guard** in [backend/src/services/aiBffApply.ts](backend/src/services/aiBffApply.ts):
   - Incoming `value === "MISSING"` (any case) is now treated identically to `null` + `confidence=MISSING`. The string is never persisted going forward.
   - The "don't overwrite a non-missing existing value with a missing one" guard also triggers on the literal string, not just `null`.

4. **One-shot DB cleanup** ([backend/src/scripts/normaliseMissingValues.ts](backend/src/scripts/normaliseMissingValues.ts)) — needs to run **once post-deploy** on staging to clean up rows that already have `value = "MISSING"`. It:
   - Finds every `ChecklistField` where `value` matches `"MISSING"` case-insensitively
   - Skips approved + manually-overridden rows (won't stomp adviser/CA decisions)
   - Sets `value = null, confidence = MISSING` on the rest
   - Idempotent — safe to re-run; second run is a no-op once cleanup is done.

**No migration** — schema didn't change; it's pure code + a data backfill script.

---

## 5. Deploy sequence

```powershell
# 1. Pull develop, confirm what's coming
git fetch && git log origin/develop..develop --oneline

# 2. Push to remote → triggers CI/CD
git push origin develop

# 3. CI pipeline should do:
#    a. cd backend && npm ci
#    b. npx prisma migrate deploy       ← runs the 3 migrations above
#    c. npx prisma generate              ← regenerate client
#    d. npx prisma db seed               ← upserts Megan, demotes any Emma row
#    e. az acr build -t backend:<sha> -r crcedingaistaging ./backend
#    f. az containerapp update -n ca-cedingai-backend-staging
#         -g rg-ceding-ai-staging --image crcedingaistaging.azurecr.io/backend:<sha>
#    g. cd ../frontend && npm ci && npm run build
#    h. az storage blob upload-batch --account-name stcedingaistaging
#         -s dist -d '$web' --overwrite
#    (adjust to whatever your actual pipeline does — the above is illustrative)

# 4. Post-deploy: repoint any existing Emma-linked staging cases
#    Run from the staging container OR a workstation with the staging DATABASE_URL:
DATABASE_URL=<staging-url> npx tsx backend/src/scripts/replaceEmmaWithMegan.ts
#    Output will say what it migrated. Idempotent — safe to re-run.

# 5. Post-deploy: normalise legacy `value = "MISSING"` rows in the checklist
#    (see §4a — one-shot cleanup of strings the AI persisted before the guard landed):
DATABASE_URL=<staging-url> npx tsx backend/src/scripts/normaliseMissingValues.ts
#    Prints "Found N fields ... Normalised N rows" and exits. Idempotent.
```

---

## 6. Smoke tests after deploy

Order matters — confirm each before moving on:

| # | Test | Expected | Where |
|---|---|---|---|
| 1 | Backend `/health` | `200 {status: "ok"}` | `https://<staging-backend>/health` |
| 2 | Admin Panel → Checklist → ISA | **34 active fields** (was 51 before reconcile) | UI |
| 3 | Sign in as **Megan Doherty** on Role Picker | Lands on dashboard, no "Emma" anywhere | UI |
| 4 | Open a case → Stage 4 → fill missing fields → Stage 6 | "Returned" tile / "Send anyway" button visible | UI |
| 5 | Stage 6 → **Send for approval** | Toast "Sent to Megan Doherty"; Megan's My Inbox shows the case | UI (Revathy → Megan) |
| 6 | Megan → Approval (Stage 8) → Approve all → Mark case approved | No 403; status flips to APPROVED | UI |
| 7 | Stage 9 → **Complete export** | Downloads .xlsx + WorkDrive upload OK + Zoho `zohoUpdate.ok: true` | Network tab |
| 8 | Open the downloaded .xlsx | 4 sheets: Summary / Checklist / **Fund Details** / Audit Trail | Excel |
| 9 | All Barrie Addison cases complete → Dashboard | Purple "All ceding done · Prepare SR" badge; button opens Zoho Contact in new tab | UI |
| 10 | Refresh-from-Zoho link in case header | Pulls paraplanner from Contact module; case header updates | UI + DevTools network |
| 11 | After running `normaliseMissingValues.ts`: open any case with previously-"MISSING"-string fields | Stage 4 / 5 / 6 / 8 missing counts now agree; downloaded XLSX shows `—`, not the word `MISSING` | UI + Excel |

---

## 7. Things to watch / known issues

### a) Existing Emma-linked cases on staging
After deploy and seed, Emma is INACTIVE but old cases still have `paralPlannerId = Emma`. Run `replaceEmmaWithMegan.ts` to repoint, or leave them alone if you'd rather test with fresh cases.

### b) Hardcoded WorkDrive folder ID
`backend/src/services/workdrive.ts` has a hardcoded fallback (`a7yip2d39bf2cd6074a09a5190cf73e7a61bf`) for when `ZOHO_WORKDRIVE_FOLDER_ID` env var is missing. Fine for sandbox, **set the env var explicitly for prod**.

### c) `Client_Owners` deliberately not sent to Plans
The Multi-Select User Lookup on Plans.Client_Owners kept rejecting our cached IDs (`INVALID_DATA: id seems to be invalid`). We disabled the field on the PATCH after several attempts. The cached IDs are still saved on the Case row in case you crack it later. Re-enable by uncommenting the `setIf("Client_Owners", ...)` block in `backend/src/routes/export.ts` (around `buildPlanFields`).

### d) Two copies of canonical JSON
`backend/prisma/canonical/checklist-fields-v1.json` and `frontend/src/lib/canonical/checklist-fields-v1.json` must stay identical. If you change one, change both. Worth adding a build-time check eventually.

### e) Admin Panel writes are ephemeral
The seed re-applies canonical on every run, so any field added via the UI gets deactivated next deploy. Either lock Admin to read-only or skip the seed after first deploy in environments where Admin edits should persist.

### f) `CaseStatus` enum overlap (`IN_REVIEW` vs `STAGE_9_ADVISER_REVIEW` vs `APPROVED`)
Deliberately left alone — mid-test isn't the right window to consolidate workflow states. Mitigated by `STATUS_TO_STAGE` mapping. Should be cleaned up before prod.

---

## 8. New files / where to look

```
backend/
  prisma/
    migrations/
      20260602154309_add_document_deleted_audit_action/   ← additive
      20260603182332_cache_zoho_ids_on_case/              ← additive (5 cols)
      20260604120000_drop_redundant_columns/              ← DROP COLUMN × 4 + DROP TYPE × 1
  src/
    routes/
      export.ts                                            ← NEW: POST /cases/:id/complete-export
    services/
      caseFieldMirror.ts                                   ← NEW: checklist → case column projection
    scripts/
      diffTemplates.ts                                     ← diagnostic: DB vs canonical
      cleanDuplicateNotifications.ts                       ← one-shot
      replaceEmmaWithMegan.ts                              ← portable, run post-deploy on staging
      findMegan.ts                                         ← read-only helper
      normaliseMissingValues.ts                            ← NEW: one-shot post-deploy, clears legacy "MISSING" string rows
    services/
      aiBffApply.ts                                        ← MODIFIED: AI write-back normalises "MISSING" → null

frontend/
  src/
    components/
      case/
        FundDetailsTable.tsx                               ← NEW: editable + read-only modes
    hooks/
      useFundLines.ts                                      ← NEW
      useChecklistFields.ts                                ← MODIFIED: exports isMissing() + displayValue() helpers
    components/case/
      ChecklistPanel.tsx                                   ← MODIFIED: Stage 4 uses isMissing()
      CallWorkspace.tsx                                    ← MODIFIED: Stage 5 uses isMissing()
      stages.tsx (StageReviewChecklist)                    ← MODIFIED: Stage 6 uses isMissing() + displayValue()
      ApprovalWorkspace.tsx                                ← MODIFIED: Stage 8 stats/filter/bulkApprove use isMissing()
      ExportWorkspace.tsx                                  ← MODIFIED: XLSX value/status columns use isMissing()/displayValue()

CHANGELOG_2026-06-02_to_06-04.md                          ← detailed per-day log
DEPLOY_HANDOFF_TO_NISHANT.md                              ← this file
```

---

## 9. Where to start in Claude Code

You can paste this whole file into your Claude session as context. A good opening prompt:

> Here's the deploy handoff. Pull the latest develop, look at the three Prisma migrations under `backend/prisma/migrations/2026060*`, and walk me through what they'll do to the staging DB before I push. Then plan the deploy.

Or jump straight to:

> Deploy `develop` to staging. Follow the sequence in section 5 of `DEPLOY_HANDOFF_TO_NISHANT.md`. Pause after each step so I can verify.

---

## 10. Ping me if

- Any migration fails to apply (especially `drop_redundant_columns`)
- Complete-export response shows `zohoError` that's not the known `Client_Owners` skip
- Megan doesn't get auto-assigned on a fresh case
- The Refresh-from-Zoho button returns an `OAUTH_SCOPE_MISMATCH` (re-auth required — see §3)

I'll be on the Cliq channel.
