-- Phase 1 password login alongside SSO.
--
-- Nishant's intent (2026-09-17): Anchor Wealth staff cannot use SSO because
-- their accounts are outside our Entra tenant, and multi-tenant SSO needs
-- their IT's admin consent which is slow to arrange. Admins can create
-- local accounts with a password so those users sign in without touching
-- their tenant. Furnley House staff stay on SSO unchanged.
--
-- A user CAN eventually have both a passwordHash AND an ssoId — an Anchor
-- Wealth user who moves to Microsoft SSO later, or an FH user who gets a
-- password once the ceding mailbox exists in phase 2. There is NO check
-- constraint enforcing mutual exclusion; both routes co-exist on one row.
--
-- The single kill switch across both routes is users.status = 'INACTIVE',
-- enforced in requireAuth (auth.ts:51) and mirrored in the /auth/login
-- endpoint via the shared assertUserActive helper. If an FH user leaves,
-- IT disables Microsoft AND an admin sets status=INACTIVE — the second
-- step is the runbook item (docs/RUNBOOKS/offboarding-password-user.md).
-- Without it a lingering passwordHash would let the ex-employee keep
-- logging in even after Microsoft is disabled.
--
-- Additive migration; existing rows land with passwordHash=NULL and
-- mustChangePassword=false, matching the pre-migration behaviour of
-- "password login is not available for this account."

ALTER TABLE "users" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "lockedUntil" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "passwordUpdatedAt" TIMESTAMP(3);

-- Two new UserAuditLog action values. USER_PASSWORD_SET fires when an
-- admin creates or resets another user's password. USER_PASSWORD_CHANGED
-- fires when a user changes their own password via /auth/change-password
-- (target=actor). Neither is emitted for the auto-provision SSO flow.
ALTER TYPE "UserAuditAction" ADD VALUE 'USER_PASSWORD_SET';
ALTER TYPE "UserAuditAction" ADD VALUE 'USER_PASSWORD_CHANGED';
