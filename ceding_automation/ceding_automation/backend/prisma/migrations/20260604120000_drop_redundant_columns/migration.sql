-- Drop redundant columns and unused PlanSubType enum.
-- Audit (2026-06-04) confirmed these as either pure duplicates of another
-- column or never populated:
--   • providers.acceptedSigType    → duplicate of providers.loaFormat (enum)
--   • cases.planSubType            → never populated (0 of 3 cases)
--   • call_scripts.providerPhone   → stale snapshot; provider phone lives in scriptContent JSON
--   • call_scripts.providerDept    → stale snapshot; same reason
--   • PlanSubType enum             → no remaining references after cases.planSubType drop

ALTER TABLE "providers" DROP COLUMN IF EXISTS "acceptedSigType";

ALTER TABLE "cases" DROP COLUMN IF EXISTS "planSubType";

ALTER TABLE "call_scripts" DROP COLUMN IF EXISTS "providerPhone";
ALTER TABLE "call_scripts" DROP COLUMN IF EXISTS "providerDept";

DROP TYPE IF EXISTS "PlanSubType";
