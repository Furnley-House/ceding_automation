-- Drop LOA columns that no frontend feature consumes. Audit results:
--   loaSignedAt    — never read or written by any UI surface. The /:id/loa
--                    route stamped it when status flipped to SIGNED, but
--                    nothing in the app ever sends that status.
--   loaReceivedAt  — added one migration ago to receive pdf_received_date,
--                    but the UI never reads it back. Write-only field.
-- Keeping these around makes the schema feel ambiguous ("which date is the
-- canonical 'sent' value?") and confuses future readers. The unused
-- LOAStatus.SIGNED enum value is harmless and left in place — dropping
-- Postgres enum values requires a type swap which isn't worth it here.
ALTER TABLE "cases" DROP COLUMN IF EXISTS "loaSignedAt";
ALTER TABLE "cases" DROP COLUMN IF EXISTS "loaReceivedAt";
