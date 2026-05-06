-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'FUND_LINE_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'FUND_LINE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'FUND_LINE_REMOVED';

-- CreateTable
CREATE TABLE "checklist_fund_lines" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "planType" "PlanType" NOT NULL,
    "fundName" TEXT NOT NULL,
    "isinSedolCiti" TEXT,
    "numberOfUnits" DECIMAL(20,6),
    "pricePerUnit" DECIMAL(20,6),
    "value" DECIMAL(20,2),
    "fundCharge" DECIMAL(8,4),
    "isWithProfits" BOOLEAN NOT NULL DEFAULT false,
    "sourceDocumentId" TEXT,
    "sourcePageNumber" INTEGER,
    "sourceQuote" TEXT,
    "status" "FieldStatus" NOT NULL DEFAULT 'MANUALLY_ENTERED',
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'MISSING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedById" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "checklist_fund_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checklist_fund_lines_caseId_idx" ON "checklist_fund_lines"("caseId");

-- CreateIndex
CREATE INDEX "checklist_fund_lines_caseId_isWithProfits_idx" ON "checklist_fund_lines"("caseId", "isWithProfits");

-- CreateIndex
CREATE INDEX "checklist_fund_lines_planType_idx" ON "checklist_fund_lines"("planType");

-- AddForeignKey
ALTER TABLE "checklist_fund_lines" ADD CONSTRAINT "checklist_fund_lines_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_fund_lines" ADD CONSTRAINT "checklist_fund_lines_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_fund_lines" ADD CONSTRAINT "checklist_fund_lines_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
