# Ceding Automation

Furnley House Financial Planning Partners — Ceding Scheme Process Automation.

Repo layout:
- `frontend/` — React 18 + Vite + shadcn/ui + Tailwind
- `backend/` — Node.js + Express + TypeScript + Prisma
- `backend/prisma/` — Postgres schema and migrations

The AI layer (Azure OpenAI prompts + Palindrome integration) is built in a separate repo by Nishant; this repo integrates over HTTP.

## Project Context

See `project-context/brief.md` for project brief, architecture decisions, requirements register (BR / FR / TR / NFR), constraints, agent assignments, and MCP context.

See `project-context/sprint-plan-draft.md` for the live sprint plan (7 sprints, 7 May → 1 July 2026).

## Quick facts

- **Target launch:** 16–17 June 2026 · **Success meet:** 1 July 2026
- **Primary KPI:** 20–25 → 78+ ceding cases per week (BR-01)
- **Hard blocker:** GDPR sign-off (TR-09) before any live client data
- **Hard gate:** ≥85% HIGH-confidence AI extraction on 50+ PDFs / 6+ providers before UAT (NFR-04)
- **In scope (Phase 1):** Pension, ISA, GIA · **Phase 2:** Bond, Final Salary / DB, Protection

## Deployment — MUST READ before any deploy

**Before proposing or executing any deploy command** (`az containerapp update`,
`az acr build`, `prisma migrate deploy`, `az storage blob upload-batch`, frontend
build commands) targeting either **staging** (`rg-ceding-ai-staging`) or
**production** (`rg-ceding-ai-prod`), read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
in full. It contains:

- the two-environment behavior matrix (staging vs prod env-flag policy),
- the right `npm run build` vs `npm run build:staging` command per environment,
- the mandatory pre-deploy checks (branch ↔ env mapping, migration scanner,
  PITR capture, table-name convention),
- the Windows / Git Bash gotchas (cp1252, MAX_PATH, MSYS path-mangling),
- environment-specific runbooks ([DEPLOY_CHECKLIST.md](docs/DEPLOY_CHECKLIST.md)
  for staging, [PROD_DEPLOY.md](docs/PROD_DEPLOY.md) for production).

Skipping these checks has broken UAT three times in this repo's short
history. The doc is the canonical entry point — runbooks are linked from
it. **Do not deploy without reading it first.**
