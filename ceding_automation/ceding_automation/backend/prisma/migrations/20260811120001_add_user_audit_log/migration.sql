-- Ship: user-admin audit trail (write-only in this pass).
--
-- Purely additive: creates a new enum type, a new table, two FK
-- constraints, and two indexes. Nothing on the existing audit_logs
-- table is touched — AuditLog stays case-scoped by design (its caseId
-- is NOT NULL). The new user_audit_logs table records changes made by
-- an ADMIN to another user's canAccessAiTraining / role / status; the
-- PATCH /api/users/:id handler writes one row per actually-changed
-- field, so a no-op PATCH writes nothing.
--
-- There is no viewer UI in this pass; the indexes anticipate a future
-- admin viewer scoped either by target (a specific user's history) or
-- by actor (what an admin has done). The predeploy scanner will
-- classify this migration as [additive].

CREATE TYPE "UserAuditAction" AS ENUM ('USER_PERMISSION_CHANGED', 'USER_ROLE_CHANGED', 'USER_STATUS_CHANGED');

CREATE TABLE "user_audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "action" "UserAuditAction" NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_audit_logs_targetUserId_createdAt_idx" ON "user_audit_logs"("targetUserId", "createdAt");

CREATE INDEX "user_audit_logs_actorUserId_createdAt_idx" ON "user_audit_logs"("actorUserId", "createdAt");

ALTER TABLE "user_audit_logs" ADD CONSTRAINT "user_audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_audit_logs" ADD CONSTRAINT "user_audit_logs_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
