-- Per-method LOA notes + tracking refs.
--
-- Before: one `loaNotes` + one `loaTrackingRef` column shared across all
-- three Stage 2 method tabs (Origo / Email / Courier). Operator complaint
-- (UAT 16 Jun): typing in any tab populated all the others, and the
-- "loaded" value was identical on every panel — there was no way to record
-- distinct Origo and Courier references on the same case (e.g. if a re-issue
-- went out by Origo first then Courier when the portal failed).
--
-- After: three panels each own their own state.
--   Origo:   loaOrigoRef + loaOrigoNotes
--   Email:   loaEmailNotes (no separate ref — the recipient address is enough)
--   Courier: loaCourierRef + loaCourierNotes
--
-- Migrating existing data: any value currently in loaNotes / loaTrackingRef
-- belongs to whichever method the operator most recently used (loaMethod).
-- Project them into the new per-method column and then drop the shared
-- columns. If loaMethod is null, data is parked under loaEmailNotes /
-- (no ref) as a safe default — email is the most common method.

ALTER TABLE "cases" ADD COLUMN "loaOrigoRef" TEXT;
ALTER TABLE "cases" ADD COLUMN "loaOrigoNotes" TEXT;
ALTER TABLE "cases" ADD COLUMN "loaEmailNotes" TEXT;
ALTER TABLE "cases" ADD COLUMN "loaCourierRef" TEXT;
ALTER TABLE "cases" ADD COLUMN "loaCourierNotes" TEXT;

-- Backfill from the legacy shared columns into the method-scoped slots.
UPDATE "cases"
SET "loaOrigoNotes" = "loaNotes",
    "loaOrigoRef"   = "loaTrackingRef"
WHERE "loaMethod" = 'origo';

UPDATE "cases"
SET "loaEmailNotes" = "loaNotes"
WHERE "loaMethod" = 'email';

UPDATE "cases"
SET "loaCourierNotes" = "loaNotes",
    "loaCourierRef"   = "loaTrackingRef"
WHERE "loaMethod" = 'courier';

-- Fallback: no method recorded yet — park under email (the most common
-- default) so the operator doesn't lose what they typed.
UPDATE "cases"
SET "loaEmailNotes" = "loaNotes"
WHERE "loaMethod" IS NULL AND "loaNotes" IS NOT NULL;

ALTER TABLE "cases" DROP COLUMN "loaNotes";
ALTER TABLE "cases" DROP COLUMN "loaTrackingRef";
