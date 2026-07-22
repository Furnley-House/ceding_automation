-- Add a nullable website column to the Provider directory.
-- Additive: no backfill, no data risk. Existing rows get NULL and the
-- admin panel exposes an Edit dialog to populate the field per-provider
-- over time.
--
-- Table name is "providers" (lowercase plural) — Prisma's @@map directive
-- on the Provider model. Matches the casing used by the User table.
ALTER TABLE "providers" ADD COLUMN "website" TEXT;
