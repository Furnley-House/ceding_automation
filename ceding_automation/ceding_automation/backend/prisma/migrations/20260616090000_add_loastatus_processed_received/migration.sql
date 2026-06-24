-- The SendLOAWorkspace state machine drives four transitions:
--   not_sent → sent → processed → received
-- But the Prisma LOAStatus enum only had NOT_SENT / SENT / SIGNED, so the
-- PATCH /:id mapper's `(Object.values(LOAStatus)).includes(upper)` check
-- rejected "PROCESSED" and "RECEIVED" payloads silently — the status never
-- advanced past SENT, the next-stage button never rendered, and any
-- loaNotes / loaTrackingRef sent in the same body were dropped because
-- the mapper short-circuited before setting them.
--
-- Add the two missing values so the workflow can complete end-to-end.
-- Postgres requires ADD VALUE outside of a transaction block.
ALTER TYPE "LOAStatus" ADD VALUE IF NOT EXISTS 'PROCESSED';
ALTER TYPE "LOAStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
