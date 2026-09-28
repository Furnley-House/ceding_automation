-- Optional checklist-section toggles (With-Profit Funds, Guarantees,
-- Protected Tax-Free Cash (Pre-A-Day)) chosen by the CA on Stage 4.
--
-- Additive-only and safe under an unattended `prisma migrate deploy`:
-- a single nullable JSONB column, no default, no backfill. Existing rows
-- take NULL, which the app reads as "no explicit choice" and falls back
-- to "section on if any of its fields holds real data".
--
-- Rolling the backend image back WITHOUT reverting this migration is
-- safe: older code never reads or writes this column.

ALTER TABLE "cases" ADD COLUMN "sectionToggles" JSONB;
