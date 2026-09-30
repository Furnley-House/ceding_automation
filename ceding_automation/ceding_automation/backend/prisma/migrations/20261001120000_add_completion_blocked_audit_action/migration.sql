-- New AuditAction enum value used by utils/completionInvariant.ts to
-- record attempted-but-blocked (or observe-only-would-have-blocked)
-- transitions into APPROVED / STAGE_10_COMPLETE while unapproved-valued
-- checklist fields remain. See KI-09 for the rationale.
--
-- Additive-only and safe under an unattended `prisma migrate deploy`:
-- ALTER TYPE ... ADD VALUE is non-locking on modern Postgres and old
-- code paths that read audit_logs treat the enum as an opaque string.
--
-- Rolling the backend image back WITHOUT reverting this migration is
-- safe: older code never emits or matches on this value.

ALTER TYPE "AuditAction" ADD VALUE 'COMPLETION_BLOCKED';
