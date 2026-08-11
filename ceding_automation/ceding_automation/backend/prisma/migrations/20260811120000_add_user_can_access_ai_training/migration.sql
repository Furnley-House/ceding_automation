-- Ship: AI Training Hub permission (per-user access flag).
--
-- Additive-only: adds a boolean to the users table so specific
-- individuals across CA_TEAM and ADMIN can be granted access to the
-- /ai-training page without a role change. DEFAULT false preserves
-- current no-permission state for every existing row; NOT NULL is
-- safe because of the default. The predeploy scanner will classify
-- this migration as [additive].

ALTER TABLE "users" ADD COLUMN "canAccessAiTraining" BOOLEAN NOT NULL DEFAULT false;
