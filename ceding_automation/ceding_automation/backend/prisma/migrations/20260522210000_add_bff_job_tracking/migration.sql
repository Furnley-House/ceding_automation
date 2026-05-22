-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "aiJobCompletedAt" TIMESTAMP(3),
ADD COLUMN     "aiJobCostUsd" DECIMAL(10,6),
ADD COLUMN     "aiJobError" TEXT,
ADD COLUMN     "aiJobId" TEXT,
ADD COLUMN     "aiJobLastPolledAt" TIMESTAMP(3),
ADD COLUMN     "aiJobProgress" INTEGER,
ADD COLUMN     "aiJobStage" TEXT,
ADD COLUMN     "aiJobStatus" TEXT,
ADD COLUMN     "aiJobSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "aiJobTokens" INTEGER;

-- AlterTable
ALTER TABLE "checklist_fields" ADD COLUMN     "aiExtractedAt" TIMESTAMP(3),
ADD COLUMN     "aiJobId" TEXT;

-- CreateIndex
CREATE INDEX "documents_aiJobStatus_aiJobSubmittedAt_idx" ON "documents"("aiJobStatus", "aiJobSubmittedAt");

-- CreateIndex
CREATE INDEX "documents_aiJobId_idx" ON "documents"("aiJobId");

