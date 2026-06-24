-- S5 / Decision 6 step 2 — snapshot the source document's filename on each
-- checklist field. Persists after the FK SET NULL fires on doc-delete, so
-- the audit trail can still name the (now-gone) source. Nullable; existing
-- rows will have NULL until the next AI extraction touches them.
-- AlterTable
ALTER TABLE "checklist_fields" ADD COLUMN "sourceDocumentName" TEXT;
