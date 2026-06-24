# Ceding Automation — Project Brief

> Source-of-truth Claude context for the Ceding Scheme Process Automation project.
> See `sprint-plan-draft.md` for the live sprint plan; this file is the standing brief.
> Generated: 2026-05-07

---

## Project Overview

Build the **Ceding Scheme Process Automation** application for Furnley House Financial Planning Partners. The app automates the 10-stage ceding process: Letter of Authority preparation, provider request routing, AI-powered document extraction, call-script + transcript analysis, paraplanner review, and WorkDrive export. Replaces a heavily manual workflow with AI-assisted, audit-trailed case processing.

Repo scope: **frontend (React/Vite)**, **backend (Express/Prisma)**, **Postgres DB**. Separate AI layer (Azure OpenAI + Palindrome) is built in a parallel repo by Nishant.

---

## Goals

- Increase ceding throughput from **20–25 cases/week → 78+ cases/week** (primary KPI, BR-01).
- Cut time-per-case from **~195 → ~60 minutes** (60% reduction).
- Eliminate manual re-keying of provider PDFs via AI extraction (BR-02).
- Reduce provider calls per case from **3–4 → 1** via AI-generated call scripts + Palindrome transcript analysis (BR-03).
- Full immutable per-field audit trail so advisers trust the data without re-doing provider calls (BR-04).
- Hit **85% HIGH-confidence AI extraction** across 50+ PDFs from 6+ providers before UAT clearance (NFR-04, hard gate).
- MVP go-live mid-June 2026; success meet 1 July 2026.

---

## Requirements in Scope

> Full BR → FR → TR chain. This is the only stored copy of requirements (PMO decision: not stored in any MCP-connected service due to commercial sensitivity). Edit this section directly if requirements change — do not re-run project initiation.

### Business Requirements (BR)

| ID | Description | Priority | Owner | RAG |
|---|---|---|---|---|
| BR-01 | Reduce time per ceding case from ~195 min to ~60 min, enabling 78+ cases/week. | Must | Lee Parkinson | RED |
| BR-02 | Eliminate manual re-keying of provider data into Zoho by automating extraction from provider PDFs. | Must | Lee Parkinson | AMBER |
| BR-03 | Reduce provider calls per case from 3–4 to 1 (60% reduction) using AI-generated call scripts. | Must | Lee Parkinson | AMBER |
| BR-04 | Full audit trail per data point so advisers can trust data without re-doing provider calls. | Must | Lee Parkinson | AMBER |
| BR-05 | Define and agree quantifiable success metrics before build begins. | Must | Lee Parkinson | GREEN |
| BR-06 | Weekly SLT reporting on case throughput, time saved, AI accuracy, manual intervention. | Must | Lee / Natalie | RED |

### Functional Requirements (FR) — Phase 1 in scope

| ID | Area | Description | Priority | RAG |
|---|---|---|---|---|
| FR-01 | Case Mgmt | Dashboard: active cases with RAG, status stages, link to Zoho CRM Tasks. | Must | AMBER |
| FR-02 | Case Mgmt | Each case linked to Zoho CRM Task and client record. | Must | RED |
| FR-03 | Case Mgmt | Auto-create case in app when ceding task reaches correct stage in Zoho blueprint. | Must | RED |
| FR-04 | Case Mgmt | Plan type from CRM drives which checklist loads (Pension / ISA / GIA in Phase 1). | Must | AMBER |
| FR-05 | Case Mgmt | Immutable case audit trail: PDF uploaded, field extracted, edited, call made, approved. | Must | AMBER |
| FR-06 | Doc Ingest | Upload one+ documents per case (PDF/Word/Excel/text). Each upload triggers AI extraction. | Must | GREEN |
| FR-07 | Doc Ingest | Multiple documents — each new doc re-runs extraction and updates confidence. | Must | AMBER |
| FR-08 | Doc Ingest | Source citation per extracted field: filename, page, table/section heading. | Must | GREEN |
| FR-09 | Doc Ingest | Zoho Scan integration for client statement at meeting. | Should | RED |
| FR-10 | AI Extract | AI extracts data from docs and maps to checklist field for plan type. <2 min. | Must | AMBER |
| FR-11 | AI Extract | Confidence per field: HIGH / MEDIUM / LOW / MISSING. | Must | AMBER |
| FR-12 | AI Extract | Plan-type-specific extraction — Pension / ISA / GIA rules; wrong-type fields not shown. | Must | AMBER |
| FR-13 | Checklist | CA team: view, edit manually, save with manual flag. Both values stored. | Must | AMBER |
| FR-14 | Checklist | Summary panel: HIGH / MEDIUM-LOW / MISSING counts, real-time. | Must | GREEN |
| FR-15 | Checklist | Adviser/PP review: Approve, Request Review (with comment), Add Comment. | Must | AMBER |
| FR-16 | Checklist | Zoho task created for paraplanner when CA marks case Ready for Review (deep link). | Must | RED |
| FR-17 | Checklist | Output: Excel auto-saved to Zoho WorkDrive when adviser approves. | Must | RED |
| FR-18 | Call Assist | AI-generated call script from missing/low-confidence fields. Provider phone, dept, questions. | Must | AMBER |
| FR-19 | Call Assist | Provider directory lookup: phone, email, department, LOA format per provider/plan/prefix. | Must | RED |
| FR-20 | Call Assist | Post-call AI extracts answers from transcript, pre-fills checklist. Tagged transcript-source. | Must | AMBER |
| FR-21 | LOA | Updated LOA template: policy ref, scheme name, plan type, GDPR consent. | Must | RED |
| FR-22 | LOA | Advice standard updated: advisers scan client's latest provider statement at meeting. | Must | RED |
| FR-23 | LOA | App surfaces correct provider send address / email / Origo routing from directory. | Must | RED |
| FR-25 | Case Mgmt | Case status On Hold when client cannot provide policy details; adviser notified. | Must | RED |
| FR-27 | Doc Ingest | Origo: once LOA submitted and PDF received, manual upload + create case. | Must | RED |
| FR-29 | Collab | Shared WorkDrive project folder for all ceding project working documents. | Must | RED |

### Technical Requirements (TR) — In scope

| ID | Area | Description | Priority | RAG |
|---|---|---|---|---|
| TR-01 | Architecture | App on Furnley House Azure tenant using Azure OpenAI. No client data to public OpenAI. | Must | RED |
| TR-02 | Integration — Zoho | SSO between Zoho CRM and ceding app via SAML or OAuth. | Must | RED |
| TR-03 | Integration — Zoho | Deep link from Zoho CRM ceding task to relevant case. Passes client ID + case ID. | Must | RED |
| TR-04 | Integration — Zoho | New case auto-created via Zoho CRM API when blueprint task transitions trigger. | Must | RED |
| TR-05 | Integration — RingCentral | Call recordings retrieved via API, passed to Palindrome for transcription. | Should | RED |
| TR-06 | Integration — WorkDrive | Checklist + audit trail .xlsx saved to Zoho WorkDrive. Folder: Client / Deal WIP. | Must | RED |
| TR-07 | Security & Access | RBAC: CA team = edit; Adviser/PP = approve+comment; Admin = manage directory + users. | Must | AMBER |
| TR-08 | Security & Access | All data encrypted at rest (AES-256) + in transit (TLS 1.2+). Deletion automated. | Must | RED |
| TR-09 | Security & Compliance | **HARD BLOCKER:** Formal GDPR sign-off from IT Manager / SLT before live data. | Must | RED |
| TR-10 | Security & Compliance | Data retention policy: 1 year for app + AI. Aligned to FCA COBS rules. | Must | RED |
| TR-11 | AI / Architecture | Azure OpenAI = PDF extraction. Palindrome = transcription. Lovable AI = prototype only. | Must | AMBER |
| TR-12 | Integration — Origo | Origo = URL link only. No API in MVP. Auto-integration in Phase 2. | Must | RED |
| TR-13 | Integration — WorkDrive | Zoho Scan: user names file when saving from app. | Must | AMBER |

### Non-Functional Requirements (NFR)

| ID | Area | Description | Priority | RAG |
|---|---|---|---|---|
| NFR-01 | Performance | AI extraction <2 min for documents up to 20 pages. Progress indicator otherwise. | Must | AMBER |
| NFR-02 | Performance | Page load <3 s on 10 Mbps+ connection. Tested from UK and Chennai. | Must | RED |
| NFR-03 | Reliability | 99.5% uptime during UK business hours (08:00–18:00 GMT, Mon–Fri). | Must | RED |
| NFR-04 | AI Accuracy | **HARD GATE:** ≥85% of fields at HIGH confidence across 50+ PDFs from 6+ providers before UAT. | Must | RED |
| NFR-05 | Usability | Adviser/PP complete review with ≤10 min training. | Should | RED |
| NFR-06 | Scalability | 20 concurrent Chennai CA users without performance degradation. | Must | RED |

### Open Blocking Questions (RED, must be resolved before MVP build proceeds)

| Q-Ref | Question | Blocks | Owner |
|---|---|---|---|
| Q-06 | Provider directory (LOA format + sig types) loadable immediately? | FR-19, FR-23 | Aruna |
| Q-07 | Policy reference prefix patterns indicating correct dept within a provider? | FR-19 | Aruna |
| Q-08 | Who leads the checklist field review? Which advisers/PPs participate? | FR-12 | Natalie |
| Q-24 | For each pension sub-type, which checklist fields apply / don't? | FR-12, AI training | Matt / Stu / Natalie |
| Q-29 | Checklist: separate tabs per pension sub-type or one consolidated? | FR-12 | Matt |

---

## Project Standards

| Field | Value |
|---|---|
| Code style | TypeScript strict; ESLint + Prettier enforced; no Supabase references (already removed) |
| Naming | snake_case for DB columns, camelCase for TS, PascalCase for components |
| Testing | Vitest + Supertest (backend), Vitest + RTL (frontend), Playwright (E2E). CI gate: lint + unit pass on PR |
| Branch protection | `main` requires PR + review + CI green; `release/*` cherry-picks only |
| Commit format | Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`) |
| API style | REST under `/api`. Zod validation on all input. Errors return `{error, details?}` |
| Auth | Microsoft SSO via Azure AD. Auto-provisions new users as `CA_TEAM`. Admins manage role escalation |
| Logging | Audit log row per state-changing action; immutable. Application Insights for runtime |
| Compliance | GDPR sign-off required (TR-09) before any live client data; 1-year retention auto-deletion (TR-10) |

---

## Architecture Direction

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | React 18 + Vite + shadcn/ui + Tailwind | Existing scaffold; fast HMR; rich component library |
| Backend | Node.js + Express + TypeScript | Existing scaffold; integrates well with Prisma |
| ORM | Prisma 5 | Type-safe queries; migrations via `prisma migrate` |
| DB | PostgreSQL (Azure Database for PostgreSQL — Flexible Server in prod) | Native JSON, full-text search, audit-friendly |
| File storage | Local in dev, Azure Blob Storage in prod | TR-08 encryption at rest |
| Auth | Microsoft Azure AD via OIDC; JWT issued internally (`/auth/azure/callback`) | TR-02 SSO from Zoho-aligned tenant |
| AI extraction | Azure OpenAI (production); Anthropic API (prototype only) | TR-11 — no client data to public endpoints |
| Transcription | Palindrome (live), RingCentral API for recording retrieval | TR-05, TR-11 |
| Document export | XLSX via `xlsx` lib; uploaded to WorkDrive via Zoho API | TR-06 |
| Hosting | Azure App Service (backend), Azure Static Web Apps (frontend) | TR-01 — Furnley House tenant |
| Secrets | Azure Key Vault | TR-08 |
| Observability | Azure Application Insights + alerts | NFR-03 |
| CI/CD | GitHub Actions on the `Furnley-House/ceding_automation` repo | Automated PR + deploy gates |

---

## Core Technical Approach

- **Repo split:** main repo holds frontend / backend / Prisma. AI layer is a separate repo owned by Nishant; backend integrates over HTTP to Nishant's Azure OpenAI proxy.
- **Zoho-driven case lifecycle:** cases originate in Zoho CRM blueprint trigger (TR-04 webhook). On every case-detail page load, the backend re-pulls the linked Zoho task and updates DB fields if Zoho has changed (existing `POST /cases/:id/sync-from-zoho` endpoint).
- **Provider mapping:** Zoho task's `Provider_group` field → app provider; auto-resolves via name match against the Provider Directory.
- **Owner sync:** Zoho Owner → app `assignedToId`. If the Zoho Owner email doesn't match an existing user, the user is auto-provisioned (CA_TEAM default). No fallback to previous owner — old assignee loses access on Zoho ownership change.
- **Plan-type-driven checklist:** templates live in `checklist_templates` table; per-case fields are cloned at case-creation time. Future template edits affect only NEW cases (existing case checklists are an immutable snapshot).
- **AI extraction flow:** PDFs uploaded → AI service called → fields populated with confidence + page citation → side-by-side viewer + per-field approve/review by paraplanner.
- **Audit trail:** every state-changing action writes to `audit_logs` with `caseId`, `userId`, `action` (enum), `oldValue`, `newValue`, `source`, `metadata`. Immutable.
- **RBAC:** `requireAuth` (any logged-in) + `requireRole(['ROLE'])` middleware on protected routes. Frontend's `RoleGuard` mirrors. Admin endpoints (`/users`, `/checklist-templates`, `/providers POST/PUT/DELETE`) require `ADMIN`.
- **Self-protection:** admins cannot demote / deactivate their own account (frontend toast + backend 400).

---

## Constraints & Assumptions

- **Hard blocker:** GDPR sign-off (TR-09) required before processing live client data. Owner: John / Lee.
- **Hard gate:** ≥85% AI HIGH-confidence on 50+ PDFs from 6+ providers before UAT (NFR-04).
- **Code freeze:** 1 June 2026.
- **Internal testing window:** 1–7 June (CA team Chennai).
- **UAT window:** 8–15 June (5 business users).
- **Production launch:** 16–17 June (revised — Zoho Project task currently shows 10 June and needs updating).
- **Hypercare:** 16–27 June (10 working days).
- **Success meet:** 1 July 2026 (Lee + SLT).
- **Out-of-scope (Phase 2):** Bond, Final Salary / DB, Protection sub-types, EIS / VCT, Suitability Report automation, FE fundinfo APIs, Fact Find integration, Origo API.
- **AI tenant:** must be Furnley House Azure tenant — no public OpenAI endpoints.
- **Data retention:** 1 year for app and AI pipeline only (not WorkDrive / Zoho CRM).
- **Provider data load:** dependent on Aruna delivering the verified Provider Directory file pre-launch (Q-06, Q-07 unblocked).

---

## Out of Scope

- Bond (Investment Bond / Offshore Bond) — Phase 2
- Final Salary / Defined Benefit — Phase 2
- Protection sub-types — Phase 2 (FR-24 deferred)
- EIS / VCT / alternative investments — fully out
- Suitability Report automation — out
- FE fundinfo APIs — out
- Fact Find integration — out
- Origo API integration (URL link only in MVP) — Phase 2
- Custom in-house AI model trained on FH call conversations — Phase 3 (Nishant)
- Zoho Blueprint pre-meeting checklist (FR-26 removed per Q-23)

---

## Active Agents

| Agent | Scope |
|---|---|
| shared-frontendDev | React UI for 10-stage workspace, admin panels, dashboards, polish |
| shared-backendDev | Express/Prisma APIs, integrations (Zoho, RingCentral, WorkDrive, Azure OpenAI), retention job |
| shared-databaseDev | Prisma schema migrations, indexes, prod data migration + seed |
| shared-devOpsDev | Azure tenant + infra, CI/CD, secrets, monitoring, deployment runbook |
| shared-securityDev | SSO hardening, RBAC review, secrets management, GDPR pack, pen-test |
| shared-testerDev | UAT planning, AI accuracy benchmark, E2E + perf + load + a11y tests, UAT facilitation |
| shared-sprintCoordinator | Pulls active sprint, dispatches tasks with human approval at every step |
| shared-sprintReview | Per-task metrics, Zoho Sprints status updates, Desk escalations for genuine config failures |

Deferred (re-activate if needed): shared-apiDesigner, shared-architectDev.

---

## MCP Context Cache

Last refreshed: 2026-05-07.

### Zoho Projects (existing PMO project)

- **Portal:** `furnleyhouse964` (Zoho EU). Numeric portal ID still required for write APIs — fetch via Get Portals before push.
- **Project:** `The Information Express (Ceding)` — id `148800000003113295`
- **Status:** In Progress · 56% complete · 21 open / 27 closed
- **Owner:** Natalie Tring · **Group:** Magnificent 7 · **Started:** 2026-03-05 · **Last modified:** 2026-04-15
- **Dev tasks identified (17):** see `sprint-plan-draft.md` Section "Zoho Projects task mapping" for the full list with owners, dates, and status.

### Zoho Sprints (target system for dev sprints)

- **Status:** Phase 8 push completed 2026-05-08 — see `## Zoho Reference` below for sprint/epic/item summary.
- **Workspace:** `superbia` · **Project:** `Ceding Automation` (P35).

### Requirements Document

- **Source:** `C:\Users\RevathyS\Downloads\Ceding_Requirements_SignOff_v5.docx` (1525 paragraphs extracted to `_requirements_extracted.txt` under `project-context/`).
- **Authoritative copy of BR/FR/TR/NFR is in this brief** (`## Requirements in Scope` section).

### GitHub

- **Repo:** `Furnley-House/ceding_automation` (branch `main`)
- **Path noted by user:** `ceding_automation/ceding_automation/ceding_automation/ceding_automation/` (deep nested working directory)
- **Tech stack on disk:** frontend (React/Vite), backend (Express/Prisma/Postgres). AI layer in separate repo (Nishant).

### Fireflies

- Not provided this session. Add via `/shared-contextRefresh` if a meeting transcript becomes relevant.

---

## Zoho Reference

- **PMO project (Zoho Projects):** `The Information Express (Ceding)`
- **Dev project (Zoho Sprints):** `Ceding Automation` (workspace `superbia`, project number `P35`)
- **Sprints (created 2026-05-08):**
  - Sprint 1 — Foundation & Backlog Capture (30 Apr → 14 May 2026)
  - Sprint 2 — Production Integration Wiring (14 May → 22 May 2026)
  - Sprint 3 — Azure Deploy & Pre-Launch Polish (22 May → 1 Jun 2026)
  - Sprint 4 — Internal Testing (Chennai) (31 May → 7 Jun 2026)
  - Sprint 5 — Business UAT (7 Jun → 15 Jun 2026)
  - Sprint 6 — Production Launch & 10-day Hypercare (15 Jun → 27 Jun 2026)
  - Sprint 7 — Success Review & Closeout (27 Jun → 1 Jul 2026)
- **Epics:** 39 (E01 → E39), each tagged with originating TR/FR/NFR/BR
- **Items:** 106 work items pushed 2026-05-08, distributed: S1=30, S2=18, S3=27, S4=8, S5=7, S6=10, S7=6
- **Task-level dependencies:** captured in the `Dependencies:` line of each item's description (Zoho `LinkItems` not used — link-type ID lookup is not exposed by the available MCP). The canonical dependency map remains in `sprint-plan-draft.md` Section "Branch Plan" + per-task body.

> **Source of truth** for all sprint and task data is Zoho Sprints — query live via the MCP. The names above are the search anchor; numeric IDs are intentionally not cached here so the brief does not go stale.
