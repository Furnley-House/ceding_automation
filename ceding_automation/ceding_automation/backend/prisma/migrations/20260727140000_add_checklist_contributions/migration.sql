-- Additive migration: adds the checklist_contributions table used by the
-- Stage 4 Pension contributions table (4 rows per case, one per tax year).
-- No data loss / no destructive change / no rename of existing columns.

CREATE TABLE "checklist_contributions" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "taxYearLabel" TEXT NOT NULL,
    "amount" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_contributions_pkey" PRIMARY KEY ("id")
);

-- One row per (case, position). Position 1 = current tax year, 4 = current − 3.
CREATE UNIQUE INDEX "checklist_contributions_caseId_position_key"
    ON "checklist_contributions"("caseId", "position");

-- Case-level lookup index (mirrors checklist_fund_lines convention).
CREATE INDEX "checklist_contributions_caseId_idx"
    ON "checklist_contributions"("caseId");

-- FK — cascade so a case delete cleans its contribution rows.
ALTER TABLE "checklist_contributions"
    ADD CONSTRAINT "checklist_contributions_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "cases"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
