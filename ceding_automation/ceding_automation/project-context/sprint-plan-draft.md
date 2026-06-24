# Sprint Plan Draft — Ceding Automation
Generated: 2026-05-07

> Review artefact for the Zoho Sprints push. Stop point for human approval before any Zoho write occurs.
> Existing Zoho Projects PMO project (`The Information Express (Ceding)`, id `148800000003113295`) tracks PMO deliverables and the 17 dev tasks listed in **Section A** below. Those dev tasks have been merged into the sprints below with their original dates preserved.

---

## Section A — Zoho Projects dev tasks (merged into sprints)

Imported from `task_export_148800000003238001.xlsx` — owners filtered to Revathy S, Nishant R, Srinath K (with collaborators). 17 dev tasks identified, mapped to sprints by start date.

| Owners | Zoho task | Start | End | % | Status | Sprint |
|---|---|---|---|---|---|---|
| Revathy | Define project deliverables | 18 Mar | 27 Mar | 100% | Closed | 1 (history) |
| Revathy | Define project scope (IN/OUT) | 18 Mar | 27 Mar | 100% | Closed | 1 (history) |
| Revathy | Define project KPIs | 27 Mar | 31 Mar | 100% | Closed | 1 (history) |
| Revathy | Explore Origo integration feasibility | 24 Mar | 31 Mar | 100% | Closed | 1 (history) |
| Revathy | Capture project requirements (BR/FR/TR) | 19 Mar | 13 Apr | 100% | Closed | 1 (history) |
| Revathy + Daniel | Finalise + approve requirements | 14 Apr | 16 Apr | 100% | Closed | 1 (history) |
| Revathy | Lovable design | 20 Mar | 16 Apr | 100% | Closed | 1 (history) |
| Nishant | Front/Back end architecture | 6 Apr | 16 Apr | 100% | Closed | 1 (history) |
| Nishant + Srinath | DB set up | 27 Apr | 7 May | 100% | Closed | 1 (history) |
| Srinath + Nishant | Back end set up | 27 Apr | 7 May | 20% | ON TRACK | 1 (finishing) |
| Nishant | AI set up | 20 Apr | 8 May | 20% | AT RISK | 1 (finishing) |
| Nishant + Chris | AI training | 28 Apr | 26 May | 10% | ON TRACK | 1–3 (long-running) |
| Srinath + Revathy + Nishant | Integration Development | 7 May | 21 May | 0% | ON TRACK | 1–2 (long-running) |
| Revathy | IT test (dev integration) | 22 May | 28 May | 0% | AT RISK | 3 |
| Nishant + Srinath + Revathy | IT bug fix | 20 May | 3 Jul | 0% | ON TRACK | 3–6 (long-running) |
| Revathy + Daniel | Launch / Go live | 10 Jun | 10 Jun | 0% | AT RISK | 6 ⚠️ **date mismatch** — Zoho says 10 Jun, plan says 16/17 Jun. Update Zoho. |
| Revathy | Present success at June team event | 1 Jul | 1 Jul | 0% | ON TRACK | 7 |

---

# Sprint 1: Foundation & Backlog Capture
**Goal:** Record completed prototype work; harden existing features; kick off Azure tenant prep.
**Proposed dates:** 7 May → 14 May 2026 (8 days)
**Branch:** `feature/foundation-hardening` (B1)

## Epic: TR-01 — Architecture & scaffold
> App on Furnley House Azure tenant using Azure OpenAI. Foundational scaffold work captured here.

### Task: Express + Prisma backend scaffold (12 routes)
Agent: shared-backendDev
Priority: High
Branch: main (already merged)
Dependencies: none
Status: completed
Acceptance criteria:
- 12 route modules registered (auth, cases, checklist, checklist-templates, crm, documents, fund-lines, providers, users, audit, notifications, calls)
- Prisma schema + migrations applied
- Health endpoint responds 200

### Task: React + Vite frontend scaffold
Agent: shared-frontendDev
Priority: High
Branch: main (already merged)
Dependencies: none
Status: completed
Acceptance criteria:
- 20 pages routed via React Router
- shadcn/ui + Tailwind theme installed
- Auth-gated routes via RoleGuard

### Task: Front/Back end architecture (Zoho Projects task)
Agent: Nishant R
Priority: High
Branch: main (already merged)
Dependencies: none
Status: completed (6–16 Apr per Zoho)
Acceptance criteria:
- Architecture document produced
- Stack choices ratified by team

### Task: DB set up (Zoho Projects task)
Agent: Nishant R, Srinath K
Priority: High
Branch: main (already merged)
Dependencies: architecture
Status: completed (27 Apr – 7 May per Zoho)
Acceptance criteria:
- Postgres dev DB provisioned
- Prisma schema applied
- Seed data loaded for local dev

### Task: Back end set up (Zoho Projects task)
Agent: Srinath K, Nishant R
Priority: High
Branch: main
Dependencies: DB set up
Status: in-progress (20%, ON TRACK, finishing 7 May)
Acceptance criteria:
- All 12 route modules wired
- Auth middleware in place
- Prisma client generated

## Epic: BR-05 + BR-06 — Project definition & KPIs (PMO history)
> Captured for record from Zoho Projects.

### Task: Define project deliverables
Agent: Revathy S
Priority: High
Status: completed (18–27 Mar)

### Task: Define project scope (IN/OUT)
Agent: Revathy S
Priority: High
Status: completed (18–27 Mar)

### Task: Define project KPIs
Agent: Revathy S
Priority: High
Status: completed (27–31 Mar)

### Task: Capture project requirements (BR/FR/TR)
Agent: Revathy S
Priority: High
Status: completed (19 Mar – 13 Apr)
Acceptance criteria:
- BR-01..06, FR-01..29, TR-01..13, NFR-01..06 all captured in v5 sign-off doc

### Task: Finalise + approve requirements
Agent: Revathy S, Daniel Worthing
Priority: High
Status: completed (14–16 Apr)
Acceptance criteria:
- Requirements doc v5 signed off

## Epic: TR-12 — Origo integration feasibility (PMO history)

### Task: Explore Origo integration with API functionality
Agent: Revathy S
Priority: High
Status: completed (24–31 Mar)
Outcome: No API. URL link only in MVP (Q-22 resolved).

## Epic: UI/UX — Lovable design (PMO history)

### Task: Lovable design
Agent: Revathy S
Priority: High
Status: completed (20 Mar – 16 Apr)
Outcome: Prototype design implemented in `frontend/`.

## Epic: TR-02 + TR-07 — SSO & RBAC

### Task: Microsoft Azure SSO + auto-provisioning
Agent: shared-backendDev, shared-securityDev
Priority: High
Branch: main (already merged)
Dependencies: none
Status: completed
Acceptance criteria:
- `/auth/azure` redirect → callback → JWT issued
- Unknown email auto-provisioned as `CA_TEAM` `ACTIVE` with `ssoId` set
- Inactive users blocked
- Auth race-condition fixed (no user reverting on refresh)

### Task: RBAC across 4 roles (CA / Adviser / PP / Admin)
Agent: shared-backendDev, shared-securityDev
Priority: High
Branch: main (already merged)
Dependencies: SSO
Status: completed
Acceptance criteria:
- `requireAuth` + `requireRole` middleware on protected routes
- Frontend `RoleGuard` mirrors
- Admin routes (`/users`, `/checklist-templates`, `/providers POST/PUT/DELETE`) require ADMIN
- Self-protection: admins cannot demote/deactivate themselves (FE + BE)

## Epic: FR-01..05 — Case lifecycle + audit trail

### Task: Case CRUD + status + LOA + chase + paraplanner assign
Agent: shared-backendDev, shared-frontendDev
Priority: High
Branch: main (already merged)
Dependencies: SSO, RBAC
Status: completed
Acceptance criteria:
- 10-stage workflow visible per case
- Stage gating (sequential, can't jump ahead)
- Audit trail row written on every state change
- LOA status: Not Sent / Sent / Signed; gates Stage 2

### Task: Zoho CRM task panel + Zoho-to-DB sync on case load
Agent: shared-backendDev
Priority: High
Branch: main (already merged)
Dependencies: Zoho CRM API client
Status: completed
Acceptance criteria:
- `POST /cases/:id/sync-from-zoho` re-pulls task and updates clientName, policyRef, planType, providerId, assignedToId, zohoDeepLink, zohoCaseId, clientZohoId
- Provider resolved from Zoho `Provider_group` field
- Owner email resolved → app user; auto-creates user if not in DB; never falls back to old assignee
- Audit log entry per sync with diff

## Epic: FR-06 + FR-08 + FR-13 — Document upload & checklist edit

### Task: Document upload (PDF/Word/Excel/text) multi-file
Agent: shared-backendDev, shared-frontendDev
Priority: High
Branch: main (already merged)
Status: completed

### Task: Side-by-side PDF viewer + source citations
Agent: shared-frontendDev
Priority: High
Branch: main (already merged)
Status: completed

### Task: Manual edit + audit trail + per-field approve / request review / comment
Agent: shared-backendDev, shared-frontendDev
Priority: High
Branch: main (already merged)
Status: completed

## Epic: FR-17 — Excel + WorkDrive export

### Task: Excel export (Summary + Checklist + Audit Trail tabs)
Agent: shared-backendDev, shared-frontendDev
Priority: High
Branch: main (already merged)
Status: completed
Acceptance criteria:
- Three sheets generated; file naming matches `[Client]_[Provider]_[PlanRef]_[YYYYMMDD].xlsx`

### Task: WorkDrive upload (stub)
Agent: shared-backendDev
Priority: High
Branch: main (already merged)
Status: completed (stub only — production wiring in Sprint 2)

## Epic: Section 13 — Admin Panel

### Task: Admin Panel — User Management / Provider Management / Checklist Templates
Agent: shared-frontendDev, shared-backendDev
Priority: High
Branch: main (already merged)
Status: completed
Acceptance criteria:
- Users tab: search/filter, role inline edit, status toggle, add user dialog, self-protection
- Providers tab: full CRUD, soft-delete, prefix routing
- Templates tab: per plan-type, drag-reorder, type editor, dropdown options manager

## Epic: Sprint 1 hardening (pending)

### Task: Zod validation audit across all backend routes
Agent: shared-backendDev, shared-securityDev
Priority: High
Branch: feature/foundation-hardening (B1)
Dependencies: none
Status: pending
Acceptance criteria:
- Every POST/PUT/PATCH route has explicit Zod schema for body
- Unknown fields silently dropped, never persisted
- 400 returned with `{error: ...}` for invalid input

### Task: Prisma indexes on frequently filtered columns
Agent: shared-databaseDev
Priority: Medium
Branch: feature/foundation-hardening (B1)
Status: pending
Acceptance criteria:
- Indexes added for `cases.assignedToId`, `cases.status`, `cases.zohoTaskId`, `audit_logs.caseId`, `audit_logs.createdAt`
- Migration file checked in
- Query benchmarks show measurable improvement

### Task: Test scaffold (Vitest + Supertest + Playwright) + CI gate
Agent: shared-testerDev, shared-devOpsDev
Priority: High
Branch: feature/foundation-hardening (B1)
Status: pending
Acceptance criteria:
- Backend: Vitest + Supertest configured, sample test passes
- Frontend: Vitest + RTL configured, sample test passes
- E2E: Playwright configured, smoke test passes
- GitHub Actions: lint + unit run on every PR; failed runs block merge

### Task: Local dev workflow + env-template documented
Agent: shared-devOpsDev
Priority: Medium
Branch: feature/foundation-hardening (B1)
Status: pending
Acceptance criteria:
- `README.md` updated with setup steps
- `.env.example` files for backend + frontend with all required variables
- `docker-compose.yml` for local Postgres (optional convenience)

### Task: Azure subscription / resource group provisioned
Agent: shared-devOpsDev
Priority: High
Branch: (infra-as-code in B9)
Status: pending
Acceptance criteria:
- Furnley House Azure subscription confirmed
- Resource groups: `rg-ceding-dev`, `rg-ceding-staging`, `rg-ceding-prod`
- IAM: Contributor for dev team, Reader for SLT
Dependencies: none

## Epic: TR-11 — AI architecture

### Task: AI set up (Zoho Projects task)
Agent: Nishant R
Priority: High
Branch: (Nishant's separate AI repo)
Dependencies: none
Status: in-progress (20%, **AT RISK**, due 8 May)
Acceptance criteria:
- Azure OpenAI deployment provisioned in Furnley tenant
- Endpoint accessible from backend
- Authentication via API key in Key Vault

### Task: AI training (long-running, spans Sprints 1–3)
Agent: Nishant R, Chris Vaughan
Priority: High
Branch: (Nishant's separate AI repo)
Dependencies: AI set up
Status: in-progress (10%, ON TRACK, due 26 May)
Acceptance criteria:
- Prompts iteratively tuned against benchmark PDFs
- Hits NFR-04 gate (≥85% HIGH-confidence on 50+ PDFs / 6+ providers) by Sprint 3 end

## Epic: Long-running — Integration Development (spans Sprints 1–2)

### Task: Integration Development (Zoho Projects task)
Agent: Srinath K, Revathy S, Nishant R
Priority: High
Branch: spans B2, B3, B5 (multiple Sprint 2 branches)
Dependencies: AI set up, Back end set up
Status: pending (0%, ON TRACK, 7–21 May)
Acceptance criteria:
- Backend ↔ AI service integration live
- Backend ↔ Zoho CRM integration live (incl. webhook)
- Backend ↔ RingCentral / Palindrome wiring live
- Backend ↔ WorkDrive live wiring

---

# Sprint 2: Production Integration Wiring
**Goal:** Replace prototype stubs with production integrations (Azure OpenAI, Zoho webhook, WorkDrive, RingCentral).
**Proposed dates:** 15 May → 22 May 2026 (8 days)
**Branches:** B2, B3, B4, B5, B6, B7, B8

## Epic: TR-04 + FR-03 — Auto-create case via Zoho blueprint

### Task: Zoho CRM blueprint webhook → auto-create case
Agent: shared-backendDev
Priority: High
Branch: feature/zoho-blueprint-webhook (B3)
Dependencies: B1 merged
Status: pending
Acceptance criteria:
- Webhook endpoint authenticates Zoho callbacks
- Triggers case creation when blueprint hits "Request ceding" stage
- Handles duplicate signal idempotently (existing case returned, not duplicated)
- Audit log entry written

## Epic: TR-06 + FR-17 — WorkDrive export

### Task: WorkDrive API live wiring (folder: Client / Deal WIP)
Agent: shared-backendDev
Priority: High
Branch: feature/workdrive-prod-api (B4)
Dependencies: B1 merged
Status: pending
Acceptance criteria:
- OAuth-authed upload of `[Client]_[Provider]_[PlanRef]_[YYYYMMDD].xlsx`
- Returns WorkDrive deep link, stored on case
- Case status auto-flips to Complete on success
- Errors surfaced with retry option in UI

## Epic: TR-05 — RingCentral + Palindrome

### Task: RingCentral API → recording retrieval
Agent: shared-backendDev
Priority: High
Branch: feature/ringcentral-palindrome (B5)
Dependencies: B1 merged
Status: pending
Acceptance criteria:
- "Fetch from RingCentral" button retrieves a specific recording by call ID
- Audio file uploaded to internal storage
- Manual paste fallback retained

### Task: Palindrome integration for transcription
Agent: shared-backendDev
Priority: High
Branch: feature/ringcentral-palindrome (B5)
Dependencies: RingCentral retrieval
Status: pending
Acceptance criteria:
- Audio handed to Palindrome API; transcript retrieved
- Transcript stored on case + persisted to audit log
- Failure modes degrade gracefully to manual paste flow

## Epic: TR-12 + FR-23 — Origo & LOA template

### Task: Origo URL routing per provider in Stage 1
Agent: shared-frontendDev
Priority: Medium
Branch: feature/origo-and-loa (B6)
Dependencies: B1 merged
Status: pending
Acceptance criteria:
- Stage 1 surfaces "Open in Origo" button when provider `isOnOrigo=true`
- Falls back to "Send via Email" with pre-filled mailto for non-Origo
- Wet-signature providers show "Print LOA" + postal address

### Task: Updated LOA template + email subject lines
Agent: shared-backendDev
Priority: High
Branch: feature/origo-and-loa (B6)
Dependencies: B1 merged
Status: pending
Acceptance criteria:
- LOA template includes policy ref, scheme name, plan type, GDPR consent
- Email subject auto-fills: `LOA – [Client] – [Provider] – [Policy ref]`
- Ceding-dept email pre-filled, main email cc'd

## Epic: FR-16 — Stage 9 paraplanner notification

### Task: Stage 9 paraplanner notification (in-app + Zoho task)
Agent: shared-backendDev
Priority: High
Branch: feature/notifications-stage9 (B7)
Dependencies: B3 (uses Zoho task creation)
Status: pending
Acceptance criteria:
- "Mark as Ready for Review" creates a Zoho task with deep link
- In-app notification banner sent to assigned paraplanner
- Re-review loop: any field sent back triggers fresh notification + audit entry

## Epic: TR-08 — Secrets

### Task: Azure Key Vault wiring (env wiring)
Agent: shared-securityDev, shared-devOpsDev
Priority: High
Branch: feature/secrets-keyvault (B8)
Dependencies: B1 merged
Status: pending
Acceptance criteria:
- All secrets (DB password, Azure OpenAI key, Zoho refresh token, RingCentral credentials, Palindrome key, JWT secret) moved out of `.env` into Key Vault
- Backend reads via managed identity in prod, file-based in dev
- Rotation policy documented

## Epic: TR-11 — Backend AI swap

### Task: Backend swap `aiExtraction.ts` Anthropic → Azure OpenAI
Agent: shared-backendDev
Priority: High
Branch: feature/azure-openai-swap (B2)
Dependencies: Nishant's AI endpoint live (1.0k AI set up)
Status: pending
Acceptance criteria:
- `aiExtraction.ts` calls Nishant's Azure OpenAI proxy, not Anthropic
- Same input/output contract maintained
- All existing extraction unit tests pass
- Anthropic SDK removed from production build

### Task: Backend swap `aiCallAssist.ts` Anthropic → Azure OpenAI
Agent: shared-backendDev
Priority: High
Branch: feature/azure-openai-swap (B2)
Dependencies: Nishant's AI endpoint live
Status: pending
Acceptance criteria:
- Call script generation + transcript analysis hit Azure OpenAI
- Same response format (script object, missing-fields summary)
- All existing call-assist tests pass

## Epic: AI track (Nishant's repo, captured here for visibility)

### Task: Pension extraction prompts (53 fields)
Agent: Nishant R (AI repo)
Priority: High
Status: pending
Acceptance criteria:
- All Pension checklist fields per requirements §8 covered
- Conditional logic respected (e.g. With-profits sub-section)

### Task: ISA extraction prompts (33 fields)
Agent: Nishant R (AI repo)
Priority: High
Status: pending

### Task: GIA extraction prompts (28 fields)
Agent: Nishant R (AI repo)
Priority: High
Status: pending

### Task: Confidence scoring + page citation
Agent: Nishant R (AI repo)
Priority: High
Status: pending
Acceptance criteria:
- Each field returned with `{value, confidence, page, evidenceRef}`
- Confidence one of HIGH / MEDIUM / LOW / MISSING

### Task: Multi-document conflict detection
Agent: Nishant R (AI repo)
Priority: High
Status: pending
Acceptance criteria:
- When second doc contradicts first, field flagged CONFLICT
- CA team prompted to choose value to keep

### Task: Call script generation prompts
Agent: Nishant R (AI repo)
Priority: High
Status: pending

### Task: Transcript analysis prompts
Agent: Nishant R (AI repo)
Priority: High
Status: pending

## Epic: NFR-01 — Test fixtures

### Task: Integration test fixtures (Zoho / RingCentral / WorkDrive mocks)
Agent: shared-testerDev
Priority: Medium
Branch: feature/foundation-hardening (B1) extension
Dependencies: B1 merged
Status: pending
Acceptance criteria:
- MSW or nock-based mocks for outbound HTTP
- Tests run hermetic (no network)

---

# Sprint 3: Azure Deploy & Pre-Launch Polish
**Goal:** Stand up Azure prod, run perf + load tests, deploy, code-freeze on 1 June.
**Proposed dates:** 23 May → 1 June 2026 (10 days)
**Branches:** B9, B10, B11, B12, B13, B14, B15

## Epic: TR-01 — Azure infrastructure

### Task: Azure App Service (backend) + Static Web Apps (frontend)
Agent: shared-devOpsDev
Priority: High
Branch: feature/azure-infrastructure (B9)
Dependencies: B8 merged
Status: pending
Acceptance criteria:
- Backend on App Service Linux, Node 20
- Frontend deployed to Static Web Apps with custom domain
- Both wired to Application Insights

### Task: Azure Database for PostgreSQL (Flexible Server)
Agent: shared-devOpsDev, shared-databaseDev
Priority: High
Branch: feature/azure-infrastructure (B9)
Dependencies: subscription provisioned
Status: pending
Acceptance criteria:
- Postgres 15+ Flexible Server in Furnley tenant
- Private endpoint, firewall locked to App Service
- Automated backups configured (TR-08)

### Task: Azure Blob Storage for documents
Agent: shared-devOpsDev
Priority: High
Branch: feature/azure-infrastructure (B9)
Status: pending
Acceptance criteria:
- Blob container created
- Server-side encryption (AES-256)
- SAS-based access from backend

### Task: Azure OpenAI deployment + private endpoint
Agent: shared-devOpsDev, Nishant R
Priority: High
Branch: feature/azure-infrastructure (B9)
Status: pending
Acceptance criteria:
- Azure OpenAI provisioned in Furnley tenant
- GPT-4o (or equivalent) model deployed
- Private endpoint; backend reaches via internal network only

### Task: Application Insights + alerts
Agent: shared-devOpsDev
Priority: High
Branch: feature/azure-infrastructure (B9)
Status: pending
Acceptance criteria:
- Backend + frontend traces, requests, exceptions
- Alerts: error rate > 1%, response time p95 > 5s, availability < 99.5%
- SLT-visible dashboard

### Task: TLS cert + custom domain (ceding.furnleyhouse.co.uk)
Agent: shared-devOpsDev, shared-securityDev
Priority: High
Branch: feature/azure-infrastructure (B9)
Status: pending
Acceptance criteria:
- TLS 1.2+ enforced, HSTS header set
- Domain wired to Static Web Apps
- Auto-renewal via Azure-managed cert

### Task: Auto-scaling rules + budget alerts
Agent: shared-devOpsDev
Priority: Medium
Branch: feature/azure-infrastructure (B9)
Status: pending
Acceptance criteria:
- Scale-out at CPU > 70% (max 4 instances during business hours)
- Budget alert at 50% / 80% / 100% of monthly cap

### Task: Postgres backup / restore procedure
Agent: shared-devOpsDev, shared-databaseDev
Priority: High
Branch: feature/azure-infrastructure (B9)
Status: pending
Acceptance criteria:
- Daily automated backup, 35-day retention
- Restore drill performed on staging; documented in runbook

## Epic: TR-01 + CI/CD

### Task: GitHub Actions CI/CD — build / test / deploy
Agent: shared-devOpsDev
Priority: High
Branch: feature/ci-cd-pipeline (B10)
Dependencies: B9 merged
Status: pending
Acceptance criteria:
- PR pipeline: lint + typecheck + unit tests
- Merge to main: deploy to dev
- Tag `release/*`: deploy to staging
- Tag `v*.*.*`: deploy to prod (manual approval gate)

### Task: Environments — dev / staging / prod separate config
Agent: shared-devOpsDev
Priority: High
Branch: feature/ci-cd-pipeline (B10)
Status: pending
Acceptance criteria:
- Three resource groups, three Key Vaults, three Postgres servers
- Per-env DNS: dev.ceding..., staging.ceding..., ceding.furnleyhouse.co.uk

## Epic: TR-10 — Data retention

### Task: 1-year automated retention deletion job
Agent: shared-backendDev, shared-devOpsDev
Priority: High
Branch: feature/data-retention (B11)
Dependencies: B9
Status: pending
Acceptance criteria:
- Daily Azure Function: deletes documents and AI artefacts > 365 days old
- Audit log entry per deletion (caseId, document IDs, count)
- Manual override / extension supported via admin
- Aligned to FCA COBS rules

## Epic: FR-19 + Q-06 + Q-07 — Provider directory data

### Task: Production DB migration + seed (providers, templates, users)
Agent: shared-databaseDev, shared-backendDev
Priority: High
Branch: feature/provider-directory-load (B12)
Status: pending
Acceptance criteria:
- All Prisma migrations applied to staging + prod
- Seed scripts run for default checklist templates (Pension / ISA / GIA per requirements §8)
- Initial admin user created

### Task: Provider Directory full data load
Agent: shared-backendDev
Priority: High
Branch: feature/provider-directory-load (B12)
Dependencies: Aruna delivers verified Provider Directory file (Q-06)
Status: pending
Acceptance criteria:
- All Origo providers loaded (§9.2)
- All known contact details loaded (§9.3)
- LOA signature categorisation applied (§9.1)
- Verified by Aruna pre-launch

### Task: Policy reference prefix routing rules
Agent: shared-backendDev
Priority: High
Branch: feature/provider-directory-load (B12)
Dependencies: Aruna confirms prefix patterns (Q-07)
Status: pending
Acceptance criteria:
- `policyTypePrefixes[]` populated per provider
- Stage 1 routes correctly based on prefix match
- Audit log records prefix-driven routing decisions

## Epic: UI/UX polish

### Task: Final UI polish — Inter font, navy/teal branding
Agent: shared-frontendDev
Priority: Medium
Branch: feature/ui-launch-polish (B13)
Dependencies: Sprint 2 branches merged
Status: pending
Acceptance criteria:
- Inter font loaded; primary #0D1B2A; accent #00C2CB
- Furnley lion logo in navbar
- Card-based layout consistent across all pages

### Task: Empty states + skeleton loaders + global error toast
Agent: shared-frontendDev
Priority: Medium
Branch: feature/ui-launch-polish (B13)
Status: pending
Acceptance criteria:
- Every list page has skeleton + empty state with CTA
- AI extraction failure shows red banner with retry
- Required-field errors highlighted in red on save

### Task: Accessibility audit (WCAG AA basics)
Agent: shared-testerDev, shared-frontendDev
Priority: Medium
Branch: feature/ui-launch-polish (B13)
Status: pending
Acceptance criteria:
- Axe scan passes on all main pages
- Keyboard navigation works for case detail + admin panels
- Colour contrast ≥ 4.5:1 for text

## Epic: Security

### Task: Security review (TLS, headers, secrets, RBAC matrix)
Agent: shared-securityDev
Priority: High
Branch: (review only, no code)
Dependencies: B9 + B10 merged
Status: pending
Acceptance criteria:
- TLS 1.2+ enforced; HSTS / CSP / X-Frame-Options headers set
- No secrets in code or env files (Key Vault verified)
- RBAC matrix matches requirements §6 (verified line by line)
- Findings documented; high-severity issues blocked from prod

### Task: GDPR sign-off pack prepared + handed to John/Lee
Agent: shared-securityDev
Priority: High
Branch: (doc only)
Dependencies: TR-08 implemented
Status: pending
Acceptance criteria:
- DPIA completed
- Data flow diagram
- Retention policy aligned to FCA COBS (TR-10)
- Submitted to John Hood / Lee Parkinson — **HARD BLOCKER for prod launch**

## Epic: NFR-04 — AI accuracy gate

### Task: AI accuracy benchmark across 50 PDFs / 6+ providers
Agent: Nishant R, shared-testerDev
Priority: High
Branch: (Nishant's AI repo + benchmark scripts)
Dependencies: AI training (Sprint 2)
Status: pending
Acceptance criteria:
- 50+ representative PDFs from 6+ providers staged
- Per-field confidence scored
- ≥85% HIGH-confidence rate per field type — **HARD GATE for UAT**

### Task: Prompt tuning iterations to reach 85% HIGH confidence
Agent: Nishant R
Priority: High
Status: pending (continues from Sprint 2 AI training)

## Epic: NFR-01 + NFR-02 + NFR-06 — Performance

### Task: E2E tests for full 10-stage flow (Playwright)
Agent: shared-testerDev
Priority: High
Branch: feature/perf-tuning (B14)
Status: pending
Acceptance criteria:
- Test suite walks Case Create → Stage 1 → ... → Stage 10 export
- Runs in CI on every PR
- Records video on failure

### Task: Performance benchmarks (page load <3s, AI <2min)
Agent: shared-testerDev
Priority: High
Branch: feature/perf-tuning (B14)
Status: pending
Acceptance criteria:
- Page load p95 < 3s on 10 Mbps connection (UK + Chennai test)
- AI extraction p95 < 2 min for 20-page PDFs
- Slow paths optimised; results recorded in runbook

### Task: Load test for 20 concurrent users
Agent: shared-testerDev
Priority: High
Branch: feature/perf-tuning (B14)
Status: pending
Acceptance criteria:
- k6 / Artillery script simulates 20 concurrent CA users
- Backend p95 < 1s under load
- No 5xx errors
- Resources scaling correctly per auto-scale rules

## Epic: TR-01 — Deployment runbook + IT test

### Task: Production deployment runbook + rollback plan
Agent: shared-devOpsDev
Priority: High
Branch: (doc)
Status: pending
Acceptance criteria:
- Step-by-step prod cutover procedure
- Rollback procedure (release tag revert + DB restore)
- DNS cutover plan
- On-call rota documented

### Task: IT test (dev integration test, Zoho Projects task)
Agent: Revathy S
Priority: High
Branch: release/v1.0-rc (B15) cut at start
Dependencies: Sprint 3 main branches merged
Status: pending (22–28 May, AT RISK per Zoho)
Acceptance criteria:
- Dev team validates end-to-end happy path
- Bugs raised + triaged before code freeze
- Sign-off given before 1 June freeze

### Task: Code freeze 1 June — RC tag, handover to internal testing
Agent: All
Priority: High
Branch: release/v1.0-rc (B15) cut at end
Status: pending
Acceptance criteria:
- All Sprint 1–3 branches merged
- `release/v1.0-rc` tag pushed
- Backend + frontend deployed to staging
- Hand-off doc to Chennai CA team

---

# Sprint 4: Internal Testing (Chennai CA team)
**Goal:** Hit the 85% AI accuracy gate (NFR-04) and clear functional testing in Chennai.
**Proposed dates:** 1 June → 7 June 2026 (7 days)
**Branch:** release/v1.0-rc (B15) + hotfix/* (B16)

## Epic: NFR-04 — AI accuracy gate (final)

### Task: AI accuracy gate verification (85% HIGH at field level)
Agent: Nishant R, shared-testerDev
Priority: High
Status: pending
Acceptance criteria:
- Final benchmark on staged 50+ PDFs / 6+ providers
- ≥85% HIGH-confidence per field — **HARD GATE for UAT**
- Sign-off from Lee + Aruna

## Epic: NFR-05 — CA team functional UAT

### Task: CA functional UAT plan + scenario script
Agent: shared-testerDev
Priority: High
Status: pending
Acceptance criteria:
- Test cases cover all 10 stages
- One full test per plan type (Pension / ISA / GIA)
- Edge cases: re-review loop, conflict resolution, On Hold case status

### Task: Test data pack — 50 PDFs from 6+ providers staged
Agent: shared-testerDev
Priority: High
Status: pending

### Task: Daily bug triage + fix rota (BE / FE / AI / DevOps rotation)
Agent: All
Priority: High
Branch: hotfix/* (B16) → cherry-pick to main + release branch
Status: pending
Acceptance criteria:
- Daily 30-min standup
- Bug board prioritised; blockers <24h fix SLA
- All fixes covered by tests

### Task: Daily test status report to Lee + Aruna
Agent: shared-testerDev
Priority: High
Status: pending

### Task: Live security smoke test on staging
Agent: shared-securityDev
Priority: High
Status: pending
Acceptance criteria:
- OWASP Top 10 quick checks
- Auth bypass attempts
- SQL injection / XSS spot checks

### Task: Staging stability + monitoring review
Agent: shared-devOpsDev
Priority: High
Status: pending
Acceptance criteria:
- Application Insights shows error rate < 1% over the week
- Resource usage within auto-scale envelope

## Epic: Long-running — IT bug fix

### Task: IT bug fix (Zoho Projects task, spans Sprints 3–6)
Agent: Nishant R, Srinath K, Revathy S
Priority: High
Branch: hotfix/* (B16)
Status: pending (20 May → 3 Jul per Zoho)
Acceptance criteria:
- Daily bug board kept current
- All Severity 1/2 bugs fixed before next gate
- Severity 3/4 carried forward as Phase 2 candidates

---

# Sprint 5: Business UAT
**Goal:** Five business users sign off; final pen-test; cutover plan ready.
**Proposed dates:** 8 June → 15 June 2026 (8 days)
**Branch:** release/v1.0-rc2 (B17) + hotfix/* (B18)

## Epic: NFR-05 — Business UAT

### Task: UAT scenarios authored with business sign-off owners
Agent: shared-testerDev
Priority: High
Status: pending
Acceptance criteria:
- Per-stakeholder scenarios (Lee, Natalie, Aruna, Matt, Nicki)
- Cover paraplanner approval flow, adviser handoff, export

### Task: UAT facilitation (5 business users)
Agent: shared-testerDev
Priority: High
Status: pending

### Task: UAT bug triage + fix
Agent: All
Priority: High
Branch: hotfix/* (B18)
Status: pending

### Task: UAT sign-off package to Lee Parkinson
Agent: shared-testerDev
Priority: High
Status: pending
Acceptance criteria:
- Signed-off scenario list
- Open-bug register with target fix dates
- Lee's go/no-go decision recorded

## Epic: TR-08 — Final security

### Task: Final pen-test on staging
Agent: shared-securityDev
Priority: High
Status: pending
Acceptance criteria:
- External pen-tester engaged (or internal sec team)
- Findings documented; high-severity issues fixed before cutover

## Epic: TR-01 — Cutover prep

### Task: Production cutover plan + rollback drill
Agent: shared-devOpsDev
Priority: High
Status: pending
Acceptance criteria:
- Step-by-step cutover script (DNS, secrets, data migration)
- Rollback drill performed on staging
- Cutover window agreed with Lee + Natalie

### Task: Final data migration scripts (provider directory, templates)
Agent: shared-databaseDev
Priority: High
Status: pending
Acceptance criteria:
- Idempotent migration scripts for Provider Directory + checklist templates
- Validation queries to confirm prod state matches expected

---

# Sprint 6: Production Launch & 10-day Hypercare
**Goal:** Cutover 16/17 June; 10 days of hypercare monitoring.
**Proposed dates:** 16 June → 27 June 2026 (12 days)
**Branch:** release/v1.0 (B19) + hotfix/hypercare-* (B20)

## Epic: TR-01 — Cutover

### Task: Production cutover (16 or 17 June)
Agent: shared-devOpsDev + All
Priority: High
Branch: release/v1.0 (B19) tagged `v1.0.0`
Dependencies: UAT sign-off
Status: pending ⚠️ **Zoho task currently shows 10 Jun — update to 16/17 Jun**
Acceptance criteria:
- Cutover script executed
- Smoke tests pass on prod
- DNS active; users redirected
- Rollback ready if needed

### Task: DNS + traffic routing
Agent: shared-devOpsDev
Priority: High
Status: pending

### Task: Production smoke tests post-deploy
Agent: shared-testerDev
Priority: High
Status: pending
Acceptance criteria:
- Login + create case + extract + export end-to-end
- Smoke pack runs in <15 min
- All green before SLT announcement

### Task: Post-deploy security audit
Agent: shared-securityDev
Priority: High
Status: pending

## Epic: NFR-03 — Hypercare

### Task: Hypercare daily standup (10 working days)
Agent: All
Priority: High
Status: pending

### Task: On-call rota (BE / FE / AI / DevOps)
Agent: All
Priority: High
Status: pending
Acceptance criteria:
- 24/5 on-call cover during UK business hours
- Pager rotation defined and shared

### Task: Hot-fix patches (BE) as needed
Agent: shared-backendDev
Priority: High
Branch: hotfix/hypercare-* (B20) — double-merged to release/v1.0 + main
Status: pending

### Task: Hot-fix patches (FE) as needed
Agent: shared-frontendDev
Priority: High
Branch: hotfix/hypercare-* (B20)
Status: pending

### Task: Production monitoring + alerts active (Application Insights)
Agent: shared-devOpsDev
Priority: High
Status: pending
Acceptance criteria:
- 99.5% uptime hit during UK business hours (NFR-03)
- All Sev 1 incidents resolved within 4h
- Metrics summarised daily

## Epic: BR-06 — KPI dashboard

### Task: KPI dashboard for SLT (cases/week, AI accuracy, calls/case)
Agent: shared-backendDev
Priority: High
Status: pending
Acceptance criteria:
- Live dashboard accessible to SLT
- Tracks cases processed/week vs 78 target
- Tracks AI HIGH-confidence rate vs 85% target
- Tracks provider calls per case vs 1 target

---

# Sprint 7: Success Review & Closeout
**Goal:** KPI metrics report + success meet + Phase 2 backlog grooming.
**Proposed dates:** 28 June → 1 July 2026 (4 days)
**Branch:** main only (no new dev work)

## Epic: BR-05 + BR-06 — Success metrics

### Task: KPI metrics extraction (cases/week, time saved, AI accuracy, calls/case)
Agent: shared-backendDev, shared-testerDev
Priority: High
Status: pending
Acceptance criteria:
- Hard numbers vs baselines for all 4 KPIs
- Comparison: prototype vs production
- Report shared with Lee + Natalie pre-meeting

### Task: Lessons learned doc compiled
Agent: All
Priority: Medium
Status: pending
Acceptance criteria:
- Per-track retrospective (FE / BE / DB / AI / DevOps / Sec / QA)
- "What went well" / "What didn't" / "What we'd change"

### Task: Present success at June team event (Zoho Projects task)
Agent: Revathy S
Priority: High
Status: pending (1 Jul per Zoho)
Acceptance criteria:
- Slide deck prepared
- KPI numbers + UAT outcomes shown
- Phase 2 roadmap previewed

### Task: Phase 2 backlog grooming
Agent: shared-backendDev + All
Priority: Medium
Status: pending
Acceptance criteria:
- Bond, Final Salary, Protection feature epics drafted
- EIS / VCT / Suitability Report automation as separate workstream
- Estimated sizing for next initiation

### Task: Hypercare metrics + post-launch retro report
Agent: shared-devOpsDev
Priority: Medium
Status: pending

### Task: Phase 2 security plan
Agent: shared-securityDev
Priority: Medium
Status: pending

---

## Branch Plan

| # | Branch | Sprint | Purpose | Merge after |
|---|---|---|---|---|
| B1 | feature/foundation-hardening | 1 | Zod audit, indexes, test scaffold + CI gate, dev-workflow docs | — (off main) |
| B2 | feature/azure-openai-swap | 2 | Backend swap Anthropic → Azure OpenAI | B1; depends on Nishant's AI endpoint live |
| B3 | feature/zoho-blueprint-webhook | 2 | Auto-create case via webhook | B1 |
| B4 | feature/workdrive-prod-api | 2 | WorkDrive live wiring | B1 |
| B5 | feature/ringcentral-palindrome | 2 | RingCentral retrieval + Palindrome transcription | B1; depends on Nishant's Palindrome wrapper |
| B6 | feature/origo-and-loa | 2 | Origo URL routing + LOA template + email subjects | B1 |
| B7 | feature/notifications-stage9 | 2 | Stage 9 paraplanner notification | B3 |
| B8 | feature/secrets-keyvault | 2 | Azure Key Vault wiring | B1 |
| B9 | feature/azure-infrastructure | 3 | App Service, Static Web Apps, Postgres, Blob, Insights, TLS, scaling, backups | B8 |
| B10 | feature/ci-cd-pipeline | 3 | GitHub Actions + dev/staging/prod env config | B9 |
| B11 | feature/data-retention | 3 | 1-year retention deletion job | B9 |
| B12 | feature/provider-directory-load | 3 | Prod migration + seed + provider data load + prefix routing | B1 |
| B13 | feature/ui-launch-polish | 3 | Branding, empty states, error toast, a11y audit | B2–B7 |
| B14 | feature/perf-tuning | 3 | E2E + perf benchmarks + load tests | All Sprint 2 branches + B13 |
| B15 | release/v1.0-rc | 3 end | RC cut at code freeze (1 Jun) | After B1–B14 |
| B16 | hotfix/* | 4 | Bugs from Chennai CA testing — cherry-pick to main, merge forward | — |
| B17 | release/v1.0-rc2 | 5 | UAT-fix cut from B15 after Chennai sign-off | B15 + Sprint 4 hotfixes |
| B18 | hotfix/* | 5 | Bugs from business UAT | — |
| B19 | release/v1.0 | 6 | Production cutover, tagged v1.0.0 | B17 + Sprint 5 hotfixes |
| B20 | hotfix/hypercare-* | 6 | 10-day hypercare patches; double-merged release/v1.0 + main | — |

**No code branches in Sprint 7** — closeout work only (KPIs, retros, success meet).

---

## Notes & Open Questions to Resolve Before Push

1. **Zoho Sprints MCP not yet visible.** Push to Zoho Sprints (Phase 8) deferred to a follow-up session once MCP is loaded.
2. **Launch date discrepancy.** Zoho Projects task `Launch / Go live` shows 10 Jun. Update to **16 or 17 Jun** when pushing.
3. **Provider Directory data load (B12)** depends on Aruna delivering verified provider file (Q-06). Sprint 3 cannot complete without this.
4. **Policy reference prefix routing (B12)** depends on Aruna confirming patterns (Q-07). Same window.
5. **GDPR sign-off (TR-09)** is the **hard blocker for Sprint 6 cutover**. Sprint 3 task "GDPR sign-off pack" hands off to John/Lee — track separately.
6. **NFR-04 AI accuracy gate (≥85% HIGH on 50+ PDFs / 6+ providers)** is the **hard gate from Sprint 4 → Sprint 5**. Nishant's track must hit this.

---
