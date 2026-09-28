-- H33-followup PR1: additive schema for the contributions redesign.
--
-- Adds contribution_transactions (new child table under checklist_contributions)
-- and two DECIMAL(12,2) nullable columns on checklist_contributions for the
-- AI's own per-cell totals. NO data migration, NO alter of existing columns,
-- legacy `amount` TEXT untouched (kept-and-deprecated per the design session).
--
-- Purpose: the current 4-row parent stores one amount per (year, both-types-
-- combined) as free text. The redesign displays two 4-year grids (employer,
-- personal) with totals summed from per-transaction children. Manual entries
-- create a source='MANUAL' child; AI extractions create source='AI' children
-- plus set the matching *AiTotal column.
--
-- CA-takes-ownership rule: when a CA overrides AI extractions in a cell,
-- the backend stamps supersededAt on the AI rows but the *AiTotal on the
-- parent is PRESERVED — it is the AI's forensic record of what it read
-- from the document (FH-2026-000188 pattern; losing it would make
-- hand-entered vs model comparisons impossible after the fact). Sums
-- always filter WHERE supersededAt IS NULL.
--
-- Conflicts are derived at read time, never stored. The naive form
-- (abs(AiTotal - sum) > 0.01) needs a manual-ownership branch — otherwise
-- every CA-corrected cell would go amber forever. That branch is a PR3
-- decision; this migration deliberately encodes no rule and no flag.
--
-- `date` is NULLABLE by design: manual entries have no source date, and a
-- default like tax-year-end would misrepresent the row as observed evidence.

-- ── 1. New enums ────────────────────────────────────────────────────────
CREATE TYPE "ContributionTransactionType" AS ENUM ('EMPLOYER', 'PERSONAL');
CREATE TYPE "ContributionTransactionSource" AS ENUM ('AI', 'MANUAL');

-- ── 2. New child table ──────────────────────────────────────────────────
CREATE TABLE "contribution_transactions" (
    "id"             TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "type"           "ContributionTransactionType" NOT NULL,
    "date"           DATE,
    "amount"         DECIMAL(12, 2) NOT NULL,
    "description"    TEXT NOT NULL,
    "documentId"     TEXT,
    "sourcePage"     INTEGER,
    "sourceRef"      TEXT,
    "source"         "ContributionTransactionSource" NOT NULL DEFAULT 'AI',
    "supersededAt"   TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contribution_transactions_pkey" PRIMARY KEY ("id")
);

-- Hot path: read all EMPLOYER (or PERSONAL) transactions for a given
-- contribution cell, filtering supersededAt at the query level.
CREATE INDEX "contribution_transactions_contributionId_type_idx"
    ON "contribution_transactions"("contributionId", "type");

-- Parent link — CASCADE so deleting a case (which already cascades to
-- checklist_contributions) also cleans up its transactions in one hop.
ALTER TABLE "contribution_transactions"
    ADD CONSTRAINT "contribution_transactions_contributionId_fkey"
    FOREIGN KEY ("contributionId") REFERENCES "checklist_contributions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Document link — SET NULL (not CASCADE) so a document delete does not
-- cascade-delete transaction rows. Losing the "Jump to source PDF" link
-- is acceptable; losing the transaction history is not.
ALTER TABLE "contribution_transactions"
    ADD CONSTRAINT "contribution_transactions_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "documents"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. AI-total columns on the parent (nullable, no default) ───────────
ALTER TABLE "checklist_contributions"
    ADD COLUMN "employerAiTotal" DECIMAL(12, 2),
    ADD COLUMN "personalAiTotal" DECIMAL(12, 2);
