-- H33-followup PR5: per-cell "not applicable" flag on contributions.
--
-- Four NULLABLE columns on checklist_contributions — two timestamps
-- (double as boolean state + provenance) + two FKs (who set it).
-- Non-null timestamp = cell is marked N/A; null = cell is either
-- filled with transactions or empty. Empty and N/A are now
-- distinguishable, which they weren't before.
--
-- MANUAL ONLY. The AI does not set N/A — a human decides whether an
-- empty cell means "does not apply" or "not yet reviewed". No backfill
-- needed; existing rows stay all-null which reads as "empty",
-- preserving today's behaviour for the whole backlog.

-- ── Add the four columns ─────────────────────────────────────────────
ALTER TABLE "checklist_contributions"
    ADD COLUMN "employerNotApplicableAt"   TIMESTAMP(3),
    ADD COLUMN "employerNotApplicableById" TEXT,
    ADD COLUMN "personalNotApplicableAt"   TIMESTAMP(3),
    ADD COLUMN "personalNotApplicableById" TEXT;

-- ── FK constraints to users(id) ──────────────────────────────────────
-- ON DELETE SET NULL matches the pattern used elsewhere for
-- who-did-what audit FKs (manualEditedById, approvedById): if the
-- user is deleted, the contribution row keeps the N/A flag itself but
-- the "who" reverts to unknown rather than cascading a delete.
ALTER TABLE "checklist_contributions"
    ADD CONSTRAINT "checklist_contributions_employerNotApplicableById_fkey"
        FOREIGN KEY ("employerNotApplicableById") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "checklist_contributions"
    ADD CONSTRAINT "checklist_contributions_personalNotApplicableById_fkey"
        FOREIGN KEY ("personalNotApplicableById") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
