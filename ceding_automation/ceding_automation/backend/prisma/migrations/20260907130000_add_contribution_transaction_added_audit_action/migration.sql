-- H33-followup PR2: add audit action for manual contribution entries.
--
-- Fires when a CA types a number into a contributions grid cell via
-- POST /:caseId/contributions/:id/transactions. One row per user
-- action; metadata captures the new value and full details of any
-- rows that were superseded by the entry (both AI and MANUAL — see
-- services/contributionsService.ts docstring for the supersede-ALL
-- rationale). Additive enum value; no ALTER on existing rows.

ALTER TYPE "AuditAction" ADD VALUE 'CONTRIBUTION_TRANSACTION_ADDED';
