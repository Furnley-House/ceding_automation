# Ceding Scheme Process Automation
**Furnley House** | Version 1.0 | Target Go-Live: End Q2 2026

---

## Overview
A full-stack application automating the 10-stage pension/ISA/GIA ceding process. CA Team (Chennai) uploads provider documents, Azure OpenAI extracts checklist fields with confidence scores, advisers/paraplanners review and approve, and completed checklists export to Zoho WorkDrive.

**AI layer is managed separately on Azure** — this repo contains the frontend, backend API, and database only.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + Tailwind CSS + TanStack Query |
| Backend | Node.js + Express + TypeScript |
| Database | PostgreSQL + Prisma ORM |
| File Storage | Azure Blob Storage |
| AI Extraction | Azure OpenAI GPT-4o (separate Azure layer) |
| Auth | JWT (demo) → Zoho SSO (production) |

---

## Project Structure

```
ceding_automation/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma       ← Full DB schema
│   │   └── seed.ts             ← Checklist templates + providers
│   ├── src/
│   │   ├── index.ts            ← Express app entry
│   │   ├── middleware/auth.ts  ← JWT + RBAC
│   │   ├── routes/
│   │   │   ├── auth.ts         ← Login / /me
│   │   │   ├── cases.ts        ← Case CRUD + stage management
│   │   │   ├── documents.ts    ← Upload + AI extraction trigger
│   │   │   ├── checklist.ts    ← Field edits + adviser approve
│   │   │   ├── providers.ts    ← Provider directory
│   │   │   ├── users.ts        ← User management (Admin)
│   │   │   ├── audit.ts        ← Immutable audit log
│   │   │   └── notifications.ts
│   │   └── services/
│   │       ├── storage.ts      ← Azure Blob Storage
│   │       └── aiExtraction.ts ← Azure OpenAI extraction
│   ├── .env.example
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx             ← Router + protected routes
│   │   ├── lib/
│   │   │   ├── api.ts          ← All API calls (axios)
│   │   │   └── store.ts        ← Zustand auth store
│   │   ├── components/
│   │   │   └── Layout.tsx      ← Sidebar + navbar
│   │   └── pages/
│   │       ├── LoginPage.tsx   ← Role-selector demo login
│   │       ├── DashboardPage.tsx
│   │       ├── CreateCasePage.tsx
│   │       ├── CaseDetailPage.tsx  ← 🚧 Build out 10-stage UI
│   │       ├── ProviderDirectoryPage.tsx
│   │       └── AdminPage.tsx
│   ├── .env.example
│   └── package.json
│
└── docs/
    └── SCHEMA.md               ← Entity relationship notes
```

---

## Quick Start

### 1. Clone the target repo
```bash
git clone https://github.com/Furnley-House/ceding_automation.git
cd ceding_automation
```

### 2. Database setup (PostgreSQL)
```bash
# Create DB
createdb ceding_automation

# Copy and fill in env
cp backend/.env.example backend/.env
# Edit DATABASE_URL in backend/.env

cd backend
npm install
npm run db:generate   # generate Prisma client
npm run db:migrate    # run migrations
npm run db:seed       # seed templates + providers
```

### 3. Start backend
```bash
cd backend
npm run dev           # runs on :3001
```

### 4. Start frontend
```bash
cd frontend
cp .env.example .env
npm install
npm run dev           # runs on :5173
```

### 5. Open http://localhost:5173
Use the demo role-selector to log in.

---

## Database Schema – Key Entities

```
User ──────────────────────────────────────────────────┐
  │ role: CA_TEAM | ADVISER | PARAPLANNER | ADMIN       │
  │                                                     │
Case ─────────────────────────────────────────────────┐ │
  │ caseRef: FH-2026-000001                           │ │
  │ planType: PENSION | ISA | GIA                     │ │
  │ status: STAGE_1...STAGE_10 | ON_HOLD | APPROVED   │ │
  │ loaStatus: NOT_SENT | SENT | SIGNED               │ │
  │                                                   │ │
  ├── Document[] ─────────────────────────────────────┤ │
  │     status: UPLOADED→PROCESSING→EXTRACTED|ERROR   │ │
  │     storagePath: Azure Blob path                  │ │
  │                                                   │ │
  ├── ChecklistField[] (one per template field)       │ │
  │     value, confidence: HIGH|MEDIUM|LOW|MISSING    │ │
  │     sourceDocument → page + section + quote       │ │
  │     isApproved (set by Adviser/PP)                │ │
  │                                                   │ │
  ├── AuditLog[] (immutable)                          │ │
  ├── CallScript[]                                    │ │
  ├── Transcript[]                                    │ │
  ├── ChaseAttempt[]                                  │ │
  └── Comment[]                                       │ │
                                                      │ │
ChecklistTemplate (Admin-configurable) ────────────────┘ │
  planType + fieldKey (unique)                           │
  sectionName, fieldName, fieldType, dropdownOptions     │
                                                        │
Provider ───────────────────────────────────────────────┘
  isOnOrigo, loaFormat, phoneCedingDept, emailCedingDept
```

---

## Environment Variables

### Backend (backend/.env)
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for JWT signing |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource URL |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment name (e.g. gpt-4o) |
| `AZURE_STORAGE_ACCOUNT_NAME` | Blob storage account |
| `AZURE_STORAGE_ACCOUNT_KEY` | Blob storage key |
| `AZURE_STORAGE_CONTAINER_NAME` | Container name |
| `ZOHO_CLIENT_ID` | Zoho CRM OAuth client ID |
| `ZOHO_CLIENT_SECRET` | Zoho CRM OAuth secret |
| `ZOHO_REFRESH_TOKEN` | Zoho CRM refresh token |

### Frontend (frontend/.env)
| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend URL (default: http://localhost:3001/api) |

---

## Roles & Permissions

| Action | CA_TEAM | ADVISER | PARAPLANNER | ADMIN |
|--------|---------|---------|-------------|-------|
| Create/edit case | ✅ | ❌ | ❌ | ✅ |
| Upload documents | ✅ | ❌ | ❌ | ✅ |
| Run AI extraction | ✅ | ❌ | ❌ | ✅ |
| Edit checklist fields | ✅ | ✅ (logged) | ✅ (logged) | ✅ |
| Approve fields | ❌ | ✅ | ✅ | ❌ |
| Generate call script | ✅ | ❌ | ❌ | ✅ |
| Mark ready for review | ✅ | ❌ | ❌ | ✅ |
| Manage providers | ❌ | ❌ | ❌ | ✅ |
| Manage users | ❌ | ❌ | ❌ | ✅ |
| Manage checklist templates | ❌ | ❌ | ❌ | ✅ |

---

## Key API Endpoints

```
POST   /api/auth/login
GET    /api/auth/me

GET    /api/cases                    list with filters
POST   /api/cases                    create case
GET    /api/cases/:id                case detail with checklist
PATCH  /api/cases/:id/status         advance stage
PATCH  /api/cases/:id/loa            update LOA status
POST   /api/cases/:id/assign-paraplanner
POST   /api/cases/:id/chase          log chase attempt

POST   /api/cases/:id/documents      upload document
GET    /api/cases/:id/documents
GET    /api/cases/:id/documents/:docId/url   SAS URL for viewer
POST   /api/cases/:id/documents/:docId/extract   retrigger

GET    /api/cases/:id/checklist
PATCH  /api/cases/:id/checklist/:fieldId        edit field
POST   /api/cases/:id/checklist/:fieldId/approve
POST   /api/cases/:id/checklist/:fieldId/request-review
POST   /api/cases/:id/checklist/approve-all
POST   /api/cases/:id/call-script    generate AI call script
POST   /api/cases/:id/transcript     upload/paste transcript

GET    /api/providers
POST   /api/providers               (Admin)
PUT    /api/providers/:id           (Admin)

GET    /api/audit/cases/:caseId
GET    /api/notifications
```

---

## What to Build Next

The scaffold is complete. Priority order for the next sprint:

1. **CaseDetailPage** – 10-stage tab/progress UI with stage-gated navigation
2. **DocumentUpload component** – drag-and-drop with progress bar
3. **ChecklistPanel component** – grouped fields with confidence badges + source citations
4. **SplitView component** – PDF viewer (Azure SAS URL) alongside checklist
5. **CallScriptPanel** – rendered call script with answer fields
6. **TranscriptPanel** – paste or upload, trigger analysis
7. **AuditTrail component** – timeline view
8. **ExportChecklist** – download Excel + send to WorkDrive
9. **Zoho CRM integration** – wire `zohoCaseId` deep links
10. **SSO** – swap demo login for Zoho SAML/OAuth

---

## Reference

- **Requirements:** `Ceding_Requirements_SignOff_v5.docx`
- **Architecture:** `Ceding_Provider_Data_Extraction_Review_Platform_Architecture.pdf`
- **Lovable prototype:** https://preview--provider-flow-pilot.lovable.app/dashboard
- **Lovable source:** https://github.com/Furnley-House/providerhub-ai.git
- **Target repo:** https://github.com/Furnley-House/ceding_automation.git
- **Brand:** Navy `#0D1B2A` | Teal `#00C2CB` | Font: Inter

---

*Confidential — Furnley House Financial Planning Partners*
