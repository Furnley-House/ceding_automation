-- Fund-master verification for checklist fund lines (stage 6).
--
-- Purpose: tell the CA when what they entered disagrees with the reference
-- data, and let them decide which figure is right. Four values are checked
-- per holding — fund name, unit price, OCF and transaction costs — against
-- fund_master_feed (name, OCF, costs) and FE Fund Info (price). Neither side
-- silently wins: verification records both, and the CA picks per field.
--
-- Why the chosen values are stored rather than looked up again at export:
-- the CA signs off the holdings at stage 6, so CRM must carry the figures
-- they approved. A fresh lookup at export would push prices nobody reviewed
-- and would contradict the plan-level Valuation, which already comes from the
-- checklist — two different numbers for one case, which is exactly what makes
-- "the data was wrong" impossible to answer.
--
-- Identifier resolution: isinSedolCiti is free text holding an ISIN, a SEDOL,
-- a Citi code, a placeholder or junk. Across production (Sept 2026, 550 rows)
-- 249 were ISINs and 174 GB SEDOLs. SEDOLs resolve via
-- substring(isin from 5 for 7), since a GB ISIN is 'GB00' + SEDOL + check
-- digit — measured at 93% on a live sample.
--
-- holdingRag feeds the Zoho Holdings subform RAG picklist: RED where the
-- identifier did not resolve or no price came back, AMBER where fund name and
-- price both did. Green exists in the picklist but this process never sets it.
--
-- All columns nullable and additive: existing rows land unverified, which is
-- correct — they have not been through the stage-6 check.

-- CreateEnum
CREATE TYPE "HoldingRag" AS ENUM ('RED', 'AMBER');

-- CreateEnum
-- Which side of a comparison the CA chose to carry forward. CEDING is the
-- figure they entered on the checklist; LOOKUP is what the reference data
-- returned (fund_master_feed for name/OCF/costs, FE Fund Info for price).
CREATE TYPE "FundValueSource" AS ENUM ('CEDING', 'LOOKUP');

-- AlterTable
ALTER TABLE "checklist_fund_lines"
  ADD COLUMN "resolvedIsin"      TEXT,
  ADD COLUMN "resolvedFundName"  TEXT,
  ADD COLUMN "resolvedUnitPrice" DECIMAL(20,6),
  ADD COLUMN "resolvedPriceDate" TIMESTAMP(3),
  ADD COLUMN "resolvedOcf"       DECIMAL(8,4),
  ADD COLUMN "resolvedTxCost"    DECIMAL(8,4),
  ADD COLUMN "verifiedAt"        TIMESTAMP(3),
  ADD COLUMN "holdingRag"        "HoldingRag",
  -- Per-field choice. Set by verification to a sensible default (LOOKUP where
  -- reference data came back, CEDING otherwise) and overridable by the CA, so
  -- export reads the decision directly instead of re-deriving it.
  ADD COLUMN "fundNameSource"    "FundValueSource",
  ADD COLUMN "priceSource"       "FundValueSource",
  ADD COLUMN "ocfSource"         "FundValueSource",
  ADD COLUMN "txCostSource"      "FundValueSource";
