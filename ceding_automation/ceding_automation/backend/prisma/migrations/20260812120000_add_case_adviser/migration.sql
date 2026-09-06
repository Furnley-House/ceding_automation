-- Additive: adds Case.adviserId (FK → users.id) and Case.zohoAdviserId
-- (audit column). Both nullable so pre-existing rows are untouched.
-- The Refresh-from-Zoho sync populates both on first refresh, reading
-- the Adviser field off the linked Zoho Contact.

ALTER TABLE "cases"
    ADD COLUMN "adviserId"     TEXT,
    ADD COLUMN "zohoAdviserId" TEXT;

-- FK — SET NULL on user delete so removing a user account doesn't
-- cascade-delete the cases they advise (they may still need auditing).
ALTER TABLE "cases"
    ADD CONSTRAINT "cases_adviserId_fkey"
    FOREIGN KEY ("adviserId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Lookup index — the case-list filter now unions adviserId into the
-- role-scoped OR clause, and this is by far the hottest single-user
-- selector on the cases table.
CREATE INDEX "cases_adviserId_idx" ON "cases"("adviserId");
