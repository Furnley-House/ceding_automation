-- Adds the per-user RingCentral OAuth columns on User.
-- All nullable; existing rows will have NULL until each user connects their RC account.
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "rcAccessToken" TEXT,
ADD COLUMN     "rcAccessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "rcAccountId" TEXT,
ADD COLUMN     "rcConnectedAt" TIMESTAMP(3),
ADD COLUMN     "rcExtensionId" TEXT,
ADD COLUMN     "rcOwnerName" TEXT,
ADD COLUMN     "rcRefreshToken" TEXT;
