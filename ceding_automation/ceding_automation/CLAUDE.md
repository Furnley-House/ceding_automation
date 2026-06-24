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
