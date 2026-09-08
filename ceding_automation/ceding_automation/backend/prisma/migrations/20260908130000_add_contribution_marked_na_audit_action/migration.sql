-- H33-followup PR5: audit action for per-cell "not applicable" flip.
--
-- Fires when a CA marks a contribution cell as N/A (or clears the
-- flag) via POST /:caseId/contributions/:id/not-applicable. One row
-- per user action; metadata captures which cell (contributionId +
-- type), whether the flip set or cleared the flag, and the full
-- supersededDetails of any transactions superseded when the flag was
-- set. Shape mirrors CONTRIBUTION_TRANSACTION_ADDED so the audit-
-- timeline description helper can reuse the parser with minor
-- branching. Additive enum value; no ALTER on existing rows.

ALTER TYPE "AuditAction" ADD VALUE 'CONTRIBUTION_MARKED_NA';
