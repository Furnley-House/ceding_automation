-- Adds Case.zohoPlanName to cache the Zoho Plans.Name field (auto-generated,
-- e.g. "Plan119575"). Populated during /sync-from-zoho whenever we find or
-- already know the linked Plans record. Display-only — never read by the
-- export payload, which uses zohoCaseId as the canonical record id.
ALTER TABLE "cases" ADD COLUMN "zohoPlanName" TEXT;
