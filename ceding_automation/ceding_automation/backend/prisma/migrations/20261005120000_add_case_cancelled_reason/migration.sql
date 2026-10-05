-- NPW (Not Proceeding With): reason + timestamp for cancelled cases.
-- Written by POST /cases/:id/npw together with status CANCELLED.
--
-- Additive-only and safe under an unattended `prisma migrate deploy`:
-- two nullable columns, no default, no backfill. Existing rows take NULL
-- (no NPW recorded); the UI falls back to "No reason recorded."
--
-- Rolling the backend image back WITHOUT reverting this migration is
-- safe: older code never reads or writes these columns.

ALTER TABLE "cases" ADD COLUMN "cancelledReason" TEXT;
ALTER TABLE "cases" ADD COLUMN "cancelledAt" TIMESTAMP(3);
