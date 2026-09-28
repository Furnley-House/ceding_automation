-- Audit action for the middleware's sync-on-403 recovery path.
--
-- Fires when requireCaseAccess would refuse access, runs a narrow
-- resync against Zoho, and the caller STILL doesn't qualify after
-- the sync. metadata captures: which user tried, the sync outcome
-- (applied | timeout | no-zoho-owner | task-gone | error), and the
-- Zoho task owner email as seen at that moment so ops can tell
-- "person X wanted case Y and Zoho did not back them up" apart from
-- "our sync failed to reach Zoho".
--
-- Additive enum value; no ALTER on existing rows. Deliberately a
-- distinct action (not a flag on CASE_UPDATED) so ops queries and
-- alerts can key on it directly — half-measure deferred-to-flag
-- artefacts rarely get finished, and this shape is trivial.

ALTER TYPE "AuditAction" ADD VALUE 'CASE_ACCESS_RETRY_DENIED';
