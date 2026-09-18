# Offboarding a user who has a local password

**Applies to:** any account where `users.passwordHash` is non-null.

## Why this runbook exists

Under SSO-only, Microsoft Entra was the kill switch: IT disabled the ex-employee's Entra account and they could no longer sign in to any FH app. That single control does NOT cover users who have a local password — the password login endpoint verifies bcrypt hashes against our own `users` table and does not consult Entra at all.

**A departed employee whose Microsoft account is disabled but whose `passwordHash` is still set will continue to log in and access their cases until an admin sets `status='INACTIVE'`.** The kill switch across both routes is the `status` column, checked by `checkUserActive` in `middleware/auth.ts` on every request AND before issuing a new token on `/auth/login`.

## When this applies

Any of the following triggers this runbook:

- An FH staff member with a password (rare in phase 1 but possible) leaves.
- An Anchor Wealth staff member with a password leaves. IT does not manage Anchor's Entra tenant, so there is no automatic external signal — the CA team or a manager must escalate.
- Any third-party contractor with a temporary local account completes the engagement.

## Steps

1. **Sign in as ADMIN.**
2. Open the User Management screen. Filter to "manually managed accounts" (accounts with a password set). Confirm the user is listed.
3. Click "Edit" on the row and set **Status → INACTIVE**. Save.
   - Do NOT delete the row. Deletion cascades to `assignedToId`, `paralPlannerId`, `createdById` and other FK references, orphaning the cases they worked on and the audit rows attributed to them. Deactivation preserves all attributions while blocking further sign-in.
4. Verify the audit trail: the User Audit section should show a `USER_STATUS_CHANGED` row with the actor and timestamp.
5. Post-verify: from a separate browser or private window, try `POST /api/auth/login` with the ex-user's email + any password. Response must be `401 Invalid credentials`.

## What deactivation does NOT touch

- The user's `passwordHash` remains in place. If reactivated later, the same password works. If that is undesirable, follow with `POST /api/users/:id/set-password` after reactivation to rotate.
- `assignedToId` / `paralPlannerId` / `adviserId` FKs on cases stay pointed at the deactivated user's id — those cases still show them as the historical owner. Reassign explicitly if the work needs to move.
- Audit rows they authored (`auditLog.userId`, `userAuditLog.actorUserId`) remain attributed to them. This is the correct behaviour — history is the point of an audit log.

## Quarterly review

Once per quarter an ADMIN should review the "manually managed accounts" list against the roster of people who should still have access. Look for:

- Password users who have not signed in for 90+ days — candidates for deactivation.
- Password users whose organisation (from their email domain) has ended its relationship with FH.
- Users who now have SSO available (Anchor Wealth users after their tenant migration in phase 2) — consider clearing the password once SSO is confirmed working for them.

## What this runbook does NOT cover

- **Email verification / self-service password reset:** phase 2. Until then, an admin doing this runbook is the only way a forgotten password gets recovered — see `POST /users/:id/set-password`.
- **SSO offboarding for FH users without a password:** the pre-existing IT process (Entra disable) is sufficient because `requireAuth` will fail-closed on the missing `ssoId` → user lookup path once Microsoft rejects the sign-in.
- **Deletion of the users row:** not recommended (see step 3). If a row must be removed for GDPR reasons, that is a separate process involving the DPO and requires deliberate handling of the FK references.
