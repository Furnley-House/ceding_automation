-- Add a nullable Text column for the Microsoft (Entra) refresh_token.
-- Used by POST /api/auth/refresh to silently mint a new app JWT when the
-- previous one expires, so users in the middle of an extraction don't get
-- dumped to the login screen.
--
-- Additive: no backfill, no data risk. Existing rows get NULL — those users
-- will fall back to the existing SSO redirect flow on token expiry.
ALTER TABLE "User" ADD COLUMN "ssoRefreshToken" TEXT;
