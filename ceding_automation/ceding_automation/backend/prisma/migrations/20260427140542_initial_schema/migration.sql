-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CA_TEAM', 'ADVISER', 'PARAPLANNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('PENSION', 'ISA', 'GIA', 'BOND', 'FINAL_SALARY', 'PROTECTION');

-- CreateEnum
CREATE TYPE "PlanSubType" AS ENUM ('PERSONAL_PENSION', 'SIPP', 'STAKEHOLDER', 'WORKPLACE', 'GROUP_PENSION', 'SECTION_32', 'OCCUPATIONAL_DC', 'IPP', 'ISA_STOCKS_SHARES', 'ISA_CASH', 'GIA', 'BOND_INVESTMENT', 'BOND_OFFSHORE');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('DRAFT', 'STAGE_1_LOA_PREP', 'STAGE_2_COLLECT_DETAILS', 'STAGE_3_CRM_SETUP', 'STAGE_4_PROVIDER_REQUEST', 'STAGE_5_CHASING', 'STAGE_6_DOCUMENT_UPLOAD', 'STAGE_7_MISSING_INFO', 'STAGE_8_VERIFY_CHECKLIST', 'STAGE_9_ADVISER_REVIEW', 'STAGE_10_COMPLETE', 'ON_HOLD', 'IN_REVIEW', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LOAStatus" AS ENUM ('NOT_SENT', 'SENT', 'SIGNED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'EXTRACTED', 'ERROR');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'MISSING', 'CONFLICT');

-- CreateEnum
CREATE TYPE "FieldStatus" AS ENUM ('AI_EXTRACTED', 'MANUALLY_ENTERED', 'MANUALLY_OVERRIDDEN', 'APPROVED', 'REVIEW_REQUESTED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CASE_CREATED', 'CASE_UPDATED', 'CASE_STATUS_CHANGED', 'CASE_ASSIGNED', 'DOCUMENT_UPLOADED', 'AI_EXTRACTION_RUN', 'FIELD_EXTRACTED', 'FIELD_EDITED', 'FIELD_APPROVED', 'FIELD_REVIEW_REQUESTED', 'CONFLICT_RESOLVED', 'CALL_SCRIPT_GENERATED', 'TRANSCRIPT_UPLOADED', 'TRANSCRIPT_ANALYSED', 'CASE_MARKED_READY', 'CASE_APPROVED', 'CHECKLIST_EXPORTED', 'WORKDRIVE_EXPORTED', 'COMMENT_ADDED', 'CHASE_LOGGED', 'LOA_STATUS_UPDATED', 'ZOHO_TASK_CREATED', 'NOTIFICATION_SENT');

-- CreateEnum
CREATE TYPE "ContactMethod" AS ENUM ('PHONE', 'EMAIL', 'POST');

-- CreateEnum
CREATE TYPE "LOAFormat" AS ENUM ('ELECTRONIC', 'WET_SIGNATURE', 'EITHER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "ssoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneMain" TEXT,
    "phoneCedingDept" TEXT,
    "emailMain" TEXT,
    "emailCedingDept" TEXT,
    "postalAddress" TEXT,
    "loaFormat" "LOAFormat" NOT NULL DEFAULT 'EITHER',
    "isOnOrigo" BOOLEAN NOT NULL DEFAULT false,
    "acceptedSigType" TEXT,
    "planTypePrefixes" TEXT[],
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cases" (
    "id" TEXT NOT NULL,
    "caseRef" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientZohoId" TEXT,
    "zohoCaseId" TEXT,
    "zohoDeepLink" TEXT,
    "zohoTaskId" TEXT,
    "planType" "PlanType" NOT NULL,
    "planSubType" "PlanSubType",
    "policyRef" TEXT,
    "planStartDate" TIMESTAMP(3),
    "providerId" TEXT,
    "status" "CaseStatus" NOT NULL DEFAULT 'STAGE_1_LOA_PREP',
    "loaStatus" "LOAStatus" NOT NULL DEFAULT 'NOT_SENT',
    "loaSentAt" TIMESTAMP(3),
    "loaSignedAt" TIMESTAMP(3),
    "ragStatus" TEXT,
    "createdById" TEXT NOT NULL,
    "assignedToId" TEXT,
    "paralPlannerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "readyForReviewAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "onHoldReason" TEXT,
    "workDriveExportPath" TEXT,
    "workDriveExportedAt" TIMESTAMP(3),

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "storageUrl" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "pageCount" INTEGER,
    "extractionModel" TEXT,
    "extractionMs" INTEGER,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_templates" (
    "id" TEXT NOT NULL,
    "planType" "PlanType" NOT NULL,
    "sectionName" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL,
    "dropdownOptions" TEXT[],
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "conditionalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_fields" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "value" TEXT,
    "aiRawValue" TEXT,
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'MISSING',
    "status" "FieldStatus" NOT NULL DEFAULT 'AI_EXTRACTED',
    "sourceDocumentId" TEXT,
    "sourcePageNumber" INTEGER,
    "sourceSection" TEXT,
    "sourceQuote" TEXT,
    "isManuallyOverridden" BOOLEAN NOT NULL DEFAULT false,
    "manualEditedById" TEXT,
    "manualEditedAt" TIMESTAMP(3),
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "reviewRequestedAt" TIMESTAMP(3),
    "hasConflict" BOOLEAN NOT NULL DEFAULT false,
    "conflictValues" JSONB,
    "fromTranscript" BOOLEAN NOT NULL DEFAULT false,
    "transcriptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_scripts" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scriptContent" JSONB NOT NULL,
    "missingFieldIds" TEXT[],
    "providerPhone" TEXT,
    "providerDept" TEXT,

    CONSTRAINT "call_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "ringCentralId" TEXT,
    "analysedAt" TIMESTAMP(3),
    "fieldsUpdated" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chase_attempts" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "method" "ContactMethod" NOT NULL,
    "notes" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedById" TEXT NOT NULL,

    CONSTRAINT "chase_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "fieldId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "fieldId" TEXT,
    "fieldKey" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "source" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "deepLink" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_ssoId_key" ON "users"("ssoId");

-- CreateIndex
CREATE UNIQUE INDEX "providers_name_key" ON "providers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "cases_caseRef_key" ON "cases"("caseRef");

-- CreateIndex
CREATE INDEX "cases_status_idx" ON "cases"("status");

-- CreateIndex
CREATE INDEX "cases_clientZohoId_idx" ON "cases"("clientZohoId");

-- CreateIndex
CREATE INDEX "cases_createdById_idx" ON "cases"("createdById");

-- CreateIndex
CREATE INDEX "cases_assignedToId_idx" ON "cases"("assignedToId");

-- CreateIndex
CREATE INDEX "documents_caseId_idx" ON "documents"("caseId");

-- CreateIndex
CREATE INDEX "checklist_templates_planType_isActive_idx" ON "checklist_templates"("planType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_templates_planType_fieldKey_key" ON "checklist_templates"("planType", "fieldKey");

-- CreateIndex
CREATE INDEX "checklist_fields_caseId_idx" ON "checklist_fields"("caseId");

-- CreateIndex
CREATE INDEX "checklist_fields_confidence_idx" ON "checklist_fields"("confidence");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_fields_caseId_templateId_key" ON "checklist_fields"("caseId", "templateId");

-- CreateIndex
CREATE INDEX "call_scripts_caseId_idx" ON "call_scripts"("caseId");

-- CreateIndex
CREATE INDEX "transcripts_caseId_idx" ON "transcripts"("caseId");

-- CreateIndex
CREATE INDEX "chase_attempts_caseId_idx" ON "chase_attempts"("caseId");

-- CreateIndex
CREATE INDEX "comments_caseId_idx" ON "comments"("caseId");

-- CreateIndex
CREATE INDEX "audit_logs_caseId_idx" ON "audit_logs"("caseId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_idx" ON "notifications"("userId", "isRead");

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_paralPlannerId_fkey" FOREIGN KEY ("paralPlannerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_fields" ADD CONSTRAINT "checklist_fields_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_fields" ADD CONSTRAINT "checklist_fields_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "checklist_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_fields" ADD CONSTRAINT "checklist_fields_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_fields" ADD CONSTRAINT "checklist_fields_manualEditedById_fkey" FOREIGN KEY ("manualEditedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_scripts" ADD CONSTRAINT "call_scripts_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chase_attempts" ADD CONSTRAINT "chase_attempts_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
