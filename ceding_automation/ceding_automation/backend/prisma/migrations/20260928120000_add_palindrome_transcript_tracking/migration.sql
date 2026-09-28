-- Palindrome transcription job tracking on the transcripts table.
--
-- Context: Palindrome is not a request/response transcription API. It is a
-- worker that sweeps a Zoho Creator form for rows flagged "Ready For
-- Processing", transcribes the audio it finds in WorkDrive, and stamps the
-- row when done. There is no callback. These columns are how a ceding
-- transcript row holds onto its place in that queue between submit and
-- completion. See backend/src/services/palindrome.ts.
--
-- Additive-only and safe under an unattended `prisma migrate deploy`:
--   * every new column is nullable, so existing rows take NULL with no
--     backfill and no NOT NULL violation;
--   * "rawText" gains a DEFAULT '' but stays NOT NULL — adding a default
--     does not rewrite or invalidate existing rows, and it lets the submit
--     path insert a transcript row before any text exists;
--   * the three indexes are additive.
--
-- Rolling the backend image back WITHOUT reverting this migration is safe:
-- no older code reads or writes these columns, and the "rawText" default is
-- only exercised by inserts that omit the column, which older code never does.
--
-- Table name is "transcripts" (lowercase plural) — Prisma's @@map directive
-- on the Transcript model. Matches the convention used by "providers".

ALTER TABLE "transcripts" ALTER COLUMN "rawText" SET DEFAULT '';

ALTER TABLE "transcripts" ADD COLUMN "palindromeRecordId" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "palindromeStatus" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "palindromeCode" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "palindromeError" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "requestedAt" TIMESTAMP(3);
ALTER TABLE "transcripts" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "transcripts" ADD COLUMN "lastPolledAt" TIMESTAMP(3);
ALTER TABLE "transcripts" ADD COLUMN "workdriveRecordingFileId" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "workdriveTranscriptsFolder" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "workdriveTranscriptFileId" TEXT;

-- Poller lookups: by Creator row id (settling one job) and by status
-- (finding everything still in flight on each tick).
CREATE INDEX "transcripts_palindromeRecordId_idx" ON "transcripts"("palindromeRecordId");
CREATE INDEX "transcripts_palindromeStatus_idx" ON "transcripts"("palindromeStatus");
