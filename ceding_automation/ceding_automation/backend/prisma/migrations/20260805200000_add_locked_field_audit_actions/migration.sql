-- Ship #1: Locked-field guard audit actions (H18 Decisions 1 + 2 + 3).
--
-- Additive-only: extends the "AuditAction" enum with five new values used
-- by the guard that freezes case.planType / providerId / policyRef once a
-- case has any checklistField.aiExtractedAt IS NOT NULL, and by the
-- warning path when the per-field lookup detects orphan-planType rows.
--
-- Safe under an unattended prisma migrate deploy: enum ADD VALUE is
-- non-destructive, cannot fail on existing rows, and preserves ordinal
-- stability of the pre-existing values. Rollback of the deployed
-- backend image WITHOUT rolling this migration back is safe because no
-- existing row can carry a value that was added by this migration
-- (the writers are gated behind new code that only ships in the same
-- image). Rolling this migration back is unnecessary in prod — it is
-- accepted practice to leave additive enum values in place across a
-- rollback (see docs/DEPLOYMENT.md §9).

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLAN_TYPE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LOCKED_FIELD_CHANGE_BLOCKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LOCKED_FIELD_CHANGE_DISMISSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LOCKED_FIELD_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CHECKLIST_TEMPLATE_MISMATCH_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CHECKLIST_ROWS_SNAPSHOTTED';
