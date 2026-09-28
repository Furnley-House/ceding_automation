# `palindromeAPI` — rebase handover

**For:** Srinath
**From:** Nishant / this session (2026-09-28)
**Branch:** `origin/palindromeAPI` at `d81a9e8`
**Branch base:** `e1236bf` (2026-08-07)
**Main tip today:** `faf225e` (2026-09-24)

The palindromeAPI branch is a single commit ahead of an 8-week-old base. Main has moved on quite a bit in those 8 weeks — 50 commits, some of them semantic changes to files your commit also touches. A textual merge won't land cleanly, and a couple of the collisions aren't reconcilable by looking at the diff alone — they need you to know what the rule was and what the rule is now. Hence this note.

## What has landed on main since 2026-08-07

Grouped by theme, not chronology.

**Auth block (H36 / H27)**
- Password login + admin-controlled kill switch, closed the demo login endpoint, stopped `PATCH /api/cases/:id` leaking `assignedTo.ssoRefreshToken` / `createdBy.ssoRefreshToken`. Multiple follow-ups (SSO redirect trap, `setRole` on password login, logout leaking role, login-redirect-requires-role, `/auth/me` applying INACTIVE). Filed KI-07 on the two-store drift between `useAuthStore` and `useRole`. Roughly 10 commits.

**Contributions H33 follow-up (PRs 1–5)**
- New `contribution_transactions` + AI-total columns; backend for manual contribution entries; two-grid contributions UI + drill-down; optimistic local update with Tab/Type flow; stages 6/7/8 read-only grid + legacy scalars hidden; per-cell "N/A" on the contributions grid; label-truth apply + orphan audits wrapped in a tx. Nine commits, includes 4 new Prisma migrations.

**Mirror fixes** *(this is the one that touches your branch semantically — read the caseFieldMirror section below)*
- `33b309e fix(mirror): remove plan_number → Case.policyRef silent overwrite` (2026-09-23)
- `2d63610 fix(mirror): restore plan_number branch, block only the AI caller` (2026-09-23)

**Access control**
- `sync-on-403 recovery in requireCaseAccess` (with case-insensitive email + skip-when-unchanged retry). Hotfix so `requireCaseAccess` prefers `:caseId` when both params present.

**Checklist UX / dropdown fix (2026-09-24)**
- `faf225e fix(checklist): show N/A in frequency dropdowns + block silent-clear on blur`.

**Docs / infrastructure**
- Prod backend now routes AI via prod-AI BFF, not staging BFF (runbook update).
- Several PITR anchors in `.prod-pitr-log`.
- Filed KI-01 (frontend type coverage), KI-02 (case-detail empty-states + counts on !loading).

Nothing else touches the surface area your commit touches, so most of the 50 commits are additive from your point of view — free to inherit on rebase.

## Files that conflict (4)

`git merge-tree` reports these four as "changed in both". Each explained:

### 1. `backend/prisma/schema.prisma`

Not a semantic conflict, but not a trivial one either. Your commit adds ~25 schema lines directly. Since your branch point, main has landed **12 new Prisma migrations** and the corresponding schema.prisma updates:

```
20260811120000_add_user_can_access_ai_training
20260811120001_add_user_audit_log
20260812120000_add_case_adviser
20260830120000_add_seeding_audit_actions
20260904120000_add_ai_extraction_notes
20260907120000_add_contribution_transactions
20260907130000_add_contribution_transaction_added_audit_action
20260908120000_add_contribution_not_applicable
20260908130000_add_contribution_marked_na_audit_action
20260916120000_add_contribution_orphan_audit_actions
20260917130000_add_password_login
20260919120000_add_case_access_retry_denied_audit_action
```

**Recommended reconciliation:** take main's `schema.prisma` and all 12 migrations verbatim, then create a fresh migration on top (something like `20260928120000_add_palindrome_...`) that contains only the schema deltas your commit was adding. Do not try to hand-merge your 25 lines into main's schema.prisma — you'll accidentally miss additions.

### 2. `backend/src/services/caseFieldMirror.ts` — **semantic change, read carefully**

Your commit adds +22 lines to this file. Main rewrote parts of it this week. The rules changed on 2026-09-23.

**Before your branch point (what the file did on 2026-08-07):**
- `mirrorChecklistToCase(caseId, fieldKey, value)` was called unconditionally from every checklist-field write path, including the AI merge in `services/aiBffApply.ts`.
- For `plan_number`, the mirror unconditionally overwrote `Case.policyRef` with whatever new value arrived — including when the AI extracted a different value from what Zoho had set.

**Today (main):**
- The AI merge caller in `services/aiBffApply.ts` **skips the mirror entirely for `fieldKey === "plan_number"`**. Specifically at `aiBffApply.ts:289`:

  ```ts
  if (field.template.fieldKey !== "plan_number") {
    await mirrorChecklistToCase(args.caseId, field.template.fieldKey, newValueStr);
  }
  ```

- The mirror function itself in `caseFieldMirror.ts` still has a `case "plan_number"` branch, still mirrors when called — but only manual CA paths (checklist PATCH, seed-with-value, N/A bulk-fill) call it for `plan_number` now. There is a lengthy inline comment at the branch explaining the team rule from 2026-09-23: **the AI never writes to `Case.policyRef`; CAs still can**.
- The `provider_name` branch has a "sticky operator pick" rule too, unchanged from before your branch point: mirror only if `Case.providerId` is null (i.e. first-time fill only). That's from Fix 2, already in place before you branched.

**What this means for your changes:** you added +22 lines to `caseFieldMirror.ts`. Read them against today's `caseFieldMirror.ts` (~180 lines) rather than yours (~30-line pre-Fix-2 stub). Almost certainly your addition is a new branch or helper, not a modification of `plan_number` / `provider_name` — but check. If your addition is a mirror rule for a call-related field (`palindrome_recording_id`, `transcript_url`, etc.), same-file conflict is textual, semantics unaffected. If your addition modifies existing branch logic, please compare against the new comments and confirm compatibility with the "AI never writes policyRef" rule.

### 3. `backend/src/services/workdrive.ts`

You added +214 lines here. Main touched this file during the Stage 9 export redesign (per-client-folder logic, `WORKDRIVE_REQUIRE_PER_CLIENT_FOLDER` env-flag hard-fail on prod, path-encoding fixes). Two contributors, two extension patterns. Almost certainly your additions are new helper functions with your own naming; likely reconcilable by putting your helpers in a new section rather than interleaving. Read main's version first; the file's shape has changed.

### 4. `backend/src/services/zohoCrm.ts`

You added +16 lines. Main touched this file multiple times: sync-on-403 recovery, case-owner reconciliation with Zoho (feature-then-reverted on `develop`, but relevant context), refresh-Zoho fixes for field-name mismatches with the Furnley org. Your +16 is likely a new function; if it's a helper that talks to a Zoho endpoint the sync-on-403 work also uses, worth aligning error-handling patterns.

## Files main added that you don't have (informational, not conflicts)

- `backend/src/middleware/requireCaseAccess.ts` + `.test.ts` — access-control middleware. If any of your new routes need caseId-scoped auth, use this rather than rolling your own.
- All 12 migration files listed above.
- Case adviser scoping additions in various routes.

Nothing here fights with your changes; these files just don't exist on your branch and will land on rebase.

## Flag: `backend/w.ts`

Your commit adds `backend/w.ts` (+22 lines). It looks like a debug scratch file — one-letter filename, in the wrong directory relative to the rest of the branch's structure, and not imported from anywhere obvious. **Please confirm what it is** before the rebase lands it on main. If it's a personal scratchpad, delete it; if it's an actual module, rename it and put it under `backend/src/`.

## Suggested rebase path

1. `git fetch origin && git checkout palindromeAPI && git rebase origin/main`
2. Migrations conflict — accept `theirs` for `backend/prisma/schema.prisma` and all `backend/prisma/migrations/*` files that appear as conflicts.
3. Then create a fresh migration for whatever your commit was adding to the schema. Migration file name should sort after `20260919120000` — pick a `20260928` timestamp.
4. For `caseFieldMirror.ts` / `workdrive.ts` / `zohoCrm.ts` — do the merges by hand against today's versions. Read the surrounding lines, not just the diff. Especially the `caseFieldMirror` "AI never writes policyRef" rule (documented in-file).
5. Delete or explain `backend/w.ts`.
6. Run `npm run build` in `backend/` and `frontend/` before pushing to catch type-level regressions from the new schema.
7. Push to your branch and open a PR against `develop` (not `main` — see below).

## Note on branch policy going forward

`develop` was fast-forwarded to `main` today. From today onwards, work is expected to merge to `develop` first, then `develop` → `main` for the prod cutover. If you push directly to `main`, you overwrite that arrangement and Revathy/I both end up pushing to the branch that deploys prod. Please target `develop`.

If any of the above is wrong or missing context, tell me and I'll amend the note.
