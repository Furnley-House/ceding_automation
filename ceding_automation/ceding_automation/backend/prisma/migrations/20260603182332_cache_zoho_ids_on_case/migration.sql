-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "zohoClientOwnerIds" TEXT[],
ADD COLUMN     "zohoOwnerId" TEXT,
ADD COLUMN     "zohoParaplannerId" TEXT,
ADD COLUMN     "zohoProviderRecordId" TEXT,
ADD COLUMN     "zohoSyncedAt" TIMESTAMP(3);
