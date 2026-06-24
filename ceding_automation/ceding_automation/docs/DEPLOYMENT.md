# Deployment — Canonical Entry Point

> **MUST READ before any staging or production deploy.** Skipping the
> checks below has broken production three times in this repo's short
> life ([DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md) §"Why this exists").
>
> **If you are an AI agent (Claude / Copilot / etc.):** read this entire
> file in full before proposing or executing any `az containerapp update`,
> `prisma migrate deploy`, `az acr build`, or `az storage blob upload-batch`
> against either environment. Then read the environment-specific runbook
> linked in §6.

---

## 1. The two environments

| | **Staging** | **Production** |
|---|---|---|
| **Resource Group** | `rg-ceding-ai-staging` | `rg-ceding-ai-prod` |
| **Subscription** | `fh-ceding-ai` | `fh-ceding-ai` |
| **Region** | UK South | UK South |
| **Backend** | `ca-cedingai-backend-staging` | `ca-cedingai-backend-prod` |
| **Backend FQDN** | `ca-cedingai-backend-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io` | `ca-cedingai-backend-prod.ambitioushill-a2e27dbd.uksouth.azurecontainerapps.io` |
| **Static site** | `stcedingaistaging` ($web) | `stcedingaiprod` ($web) |
| **Frontend URL** | `https://stcedingaistaging.z33.web.core.windows.net/` | `https://stcedingaiprod.z33.web.core.windows.net/` |
| **ACR** | `crcedingaistaging` | `crcedingaiprod` |
| **Postgres** | `pg-cedingai-staging` (B1ms, no HA) | `pg-cedingai-prod` (D2s_v3, HA, 35d backup, GZRS) |
| **Key Vault** | `kv-cedingai-staging` | `kv-cedingai-prod` |
| **BFF / AI pipeline** | `ca-cedingai-api-staging` + 4 stages + DLQ | (reuses staging BFF — Nishant cuts over later) |
| **Deploys from** | `develop` | `main` |
| **GDPR / TR-09** | not gated | **signed off — required for live data** |

---

## 2. The behavior matrix (one codebase, two configs)

The same code runs in both environments. Behavior differs purely via env vars:

| Behavior | Staging / local | Production | Mechanism |
|---|---|---|---|
| **Role picker** | Shown | Hidden (auto-SSO) | `VITE_DISABLE_DEMO_LOGIN` — frontend build-time |
| **WorkDrive folder** | Env-var fallback (shared folder) | Per-client from `Contact.Client_Record_Folder_ID` (hard-fail if empty) | `WORKDRIVE_REQUIRE_PER_CLIENT_FOLDER` — backend runtime |
| **Backend URL the SPA calls** | Staging FQDN | Prod FQDN | `VITE_API_URL` — frontend build-time |
| **BFF URL the backend calls** | Staging BFF | Staging BFF *(until Nishant ships BFF prod)* | `BFF_BASE_URL` — backend runtime |
| **JWT issuer secret, DB URL, Zoho creds, RC creds, etc.** | Staging values | Prod values | Container App secret refs into KV |

**Never** put environment-specific values in code. Every difference between
staging and prod is one of:

- A **frontend** env var read at `vite build` time → lives in
  `.env.staging` (for `npm run build:staging`) or `.env.production` (for
  `npm run build`).
- A **backend** env var read at runtime → set on the Container App via
  `az containerapp update --set-env-vars` or `az containerapp secret set`.

---

## 3. Build commands — must use the right one per environment

Because Vite reads a different `.env.*` file per mode, **the wrong build
command silently produces a bundle that talks to the other environment's
backend.** This has happened in this repo. The matrix:

| Build target | Command | Reads | Output points at |
|---|---|---|---|
| **Staging static site** | `npm run build:staging` | `frontend/.env.staging` | staging backend FQDN, role picker enabled |
| **Production static site** | `npm run build` | `frontend/.env.production` | prod backend FQDN, role picker disabled |
| **Local dev** | `npm run dev` | `.env`, `.env.local`, `.env.development` | whatever `.env.local` says (typically `/api` proxied) |

A common failure mode: someone runs `npm run build` for a staging deploy
and the staging static site starts hitting the prod backend (or vice
versa). The bundle file name (e.g. `index-Df1bQcdw.js`) plus a grep for
`ca-cedingai-backend-prod` or `-staging` in `dist/assets/*.js` will tell
you which environment a built artifact is for **before** you upload it.

---

## 4. Mandatory pre-deploy checks (every deploy, no exceptions)

Run these BEFORE touching any Azure resource. If you skip any, stop and
do them first.

### 4.1 Confirm you know which environment you're deploying to

```bash
echo "Subscription: $(az account show --query name -o tsv)"
echo "Target RG:    rg-ceding-ai-{staging|prod}"
echo "Target ACR:   crcedingai{staging|prod}"
echo "Target app:   ca-cedingai-backend-{staging|prod}"
```

If those four lines don't match the target environment, **stop**. A typo
here sends prod code to staging or staging code to prod.

### 4.2 Confirm the branch matches the environment

```bash
git branch --show-current
git log -1 --oneline
```

- Staging deploys must run from **`develop`** (or a clean branch off it)
- Production deploys must run from **`main`**

Mixing these up is how unreviewed code reaches prod.

### 4.3 Run the offline migration scanner

```bash
./scripts/predeploy-check.sh
```

Lists every migration in the repo, flags additive vs destructive. Cross-
reference against `prisma migrate status` (which needs a live DB
connection, so it requires opening a temporary firewall rule — see §6
runbooks for the ceremony).

### 4.4 Confirm migration table-name convention

Prisma's `@@map` directive renames PascalCase models to lowercase plural
in Postgres. The User model → `users` table. This has bitten us already
([commit 35a3395](https://github.com/Furnley-House/ceding_automation/commit/35a3395)).
When writing migrations:

```sql
-- WRONG:
ALTER TABLE "User" ADD COLUMN ...;
-- RIGHT (matches the @@map):
ALTER TABLE "users" ADD COLUMN ...;
```

Cross-check against existing migrations like
`20260615143000_add_user_ringcentral_columns/migration.sql` to confirm
the casing convention before applying.

### 4.5 Capture PRE_MIGRATE_UTC for PITR

```bash
PRE_MIGRATE_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "$PRE_MIGRATE_UTC  pg-cedingai-{env}  reason" >> docs/.prod-pitr-log
```

Mandatory for production. Strongly recommended for staging. If a
destructive migration goes sideways, you'll need this timestamp to
target a PITR restore.

### 4.6 Verify the right `.env.{mode}` for the static-site build

Before `npm run build` or `npm run build:staging`, **read** the env file
you're about to bake in. The bundle is immutable once shipped — wrong
URL = wrong environment for the next ~6 months until someone notices.

```bash
cat frontend/.env.production  # for prod deploys
cat frontend/.env.staging     # for staging deploys
```

---

## 5. Local cp1252 / Windows path-length quirks (must-know)

The local Azure CLI on Windows has two known failure modes that look
fatal but are not:

### 5.1 cp1252 UnicodeEncodeError on `az acr build`

The `az acr` stream-logs writer crashes when Prisma prints a `✔`
checkmark. **The server-side build keeps running.** Verify via:

```bash
az acr task list-runs -r crcedingai{env} --top 1 -o table
az acr repository show-tags -n crcedingai{env} --repository ceding-backend
```

Never trust the local exit code; trust the ACR query.

### 5.2 Windows MAX_PATH (260 chars) on file walk

`az acr build` packs the source tar by walking the filesystem before
respecting `.dockerignore`. If a path in `backend/uploads/cases/...` is
longer than 260 chars, the walk fails with `[WinError 3]`. Fix: keep
`backend/uploads/` empty (or only short filenames) before building.
`.dockerignore` does NOT save you here — the failure is pre-tar.

### 5.3 Git Bash MSYS path-mangling

Arguments starting with `/` (Azure resource IDs, KV URIs) get rewritten
to `c:/program files/git/...` by Git Bash. Prefix with `MSYS_NO_PATHCONV=1`:

```bash
MSYS_NO_PATHCONV=1 az role assignment create --scope "$RG_ID" ...
MSYS_NO_PATHCONV=1 az containerapp registry set --identity "$MI_ID" ...
```

If you see `c:/program files/git/subscriptions/...` in any error
message, that's this bug. The fix is always `MSYS_NO_PATHCONV=1`.

---

## 6. Environment-specific runbooks

Read these AFTER you've completed §4:

- **Staging:** [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md) — the
  3-incidents-deep "always migrate BEFORE rolling the image" rule, the
  firewall ceremony, and the staging-specific verification steps.
- **Production:** [PROD_DEPLOY.md](PROD_DEPLOY.md) — same shape but
  prod-tightened: PITR capture is mandatory, rollback playbook differs,
  GDPR sign-off reference required at the top.

---

## 7. Deployment cheat sheets

### 7.1 Staging deploy (from `develop`)

```bash
# 0. Pre-checks
git checkout develop && git pull --ff-only origin develop
./scripts/predeploy-check.sh

# 1. Apply pending migrations (with firewall ceremony — see DEPLOY_CHECKLIST §5)
cd backend
DATABASE_URL=$(az keyvault secret show --vault-name kv-cedingai-staging --name DATABASE-URL --query value -o tsv) \
  npx prisma migrate status   # confirm what's pending
# … open temp firewall rule, apply, close rule …

# 2. Build + roll backend
SHA=$(git rev-parse --short HEAD)
az acr build -t "ceding-backend:$SHA" -t "ceding-backend:latest" -r crcedingaistaging backend
az containerapp update -g rg-ceding-ai-staging -n ca-cedingai-backend-staging \
  --image "crcedingaistaging.azurecr.io/ceding-backend:$SHA"

# 3. Build + upload frontend  (NOTE: build:staging, NOT build)
cd ../frontend
npm ci
npm run build:staging     # reads .env.staging — role picker on, staging URL
STORAGE_KEY=$(az storage account keys list -g rg-ceding-ai-staging -n stcedingaistaging --query '[0].value' -o tsv)
az storage blob upload-batch --account-name stcedingaistaging --account-key "$STORAGE_KEY" \
  -s dist -d '$web' --overwrite

# 4. Verify
curl -sk -o /dev/null -w "HTTP %{http_code}\n" \
  https://ca-cedingai-backend-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io/health
# expect: HTTP 200
```

### 7.2 Production deploy (from `main`)

```bash
# 0. Pre-checks
git checkout main && git pull --ff-only origin main
./scripts/predeploy-check.sh

# 1. Capture PITR target + apply pending migrations (with firewall ceremony — see PROD_DEPLOY.md §3.5)
PRE_MIGRATE_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "$PRE_MIGRATE_UTC  pg-cedingai-prod  $(git rev-parse --short HEAD)" >> docs/.prod-pitr-log
cd backend
DATABASE_URL=$(az keyvault secret show --vault-name kv-cedingai-prod --name DATABASE-URL --query value -o tsv) \
  npx prisma migrate status
# … open temp firewall rule, apply, close rule …

# 2. Build + roll backend
SHA=$(git rev-parse --short HEAD)
az acr build -t "ceding-backend:$SHA" -t "ceding-backend:latest" -r crcedingaiprod backend
az containerapp update -g rg-ceding-ai-prod -n ca-cedingai-backend-prod \
  --image "crcedingaiprod.azurecr.io/ceding-backend:$SHA"

# 3. Build + upload frontend  (NOTE: npm run build, NOT build:staging)
cd ../frontend
npm ci
npm run build              # reads .env.production — role picker off, prod URL
STORAGE_KEY=$(az storage account keys list -g rg-ceding-ai-prod -n stcedingaiprod --query '[0].value' -o tsv)
az storage blob upload-batch --account-name stcedingaiprod --account-key "$STORAGE_KEY" \
  -s dist -d '$web' --overwrite

# 4. Verify
curl -sk https://ca-cedingai-backend-prod.ambitioushill-a2e27dbd.uksouth.azurecontainerapps.io/health
# expect: {"status":"ok",...}
```

### 7.3 The env vars that MUST be set on each backend Container App

Production-only env vars (must be present on the prod Container App,
must NOT be set on staging):

```
WORKDRIVE_REQUIRE_PER_CLIENT_FOLDER=true
```

Staging-only env vars (set on staging, must NOT be set on prod):

```
# none currently — staging is the "no prod-only flags" state
```

Both environments share the same env-var *list*; only the values differ.
The Container App env vars include:

```
PORT, NODE_ENV, FRONTEND_URL, JWT_EXPIRES_IN
AI_VIA_BFF, BFF_BASE_URL, BFF_SHARED_SECRET (secretref), INTERNAL_BFF_KEY (secretref)
AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_CONTAINER_NAME, AZURE_STORAGE_ACCOUNT_KEY (secretref)
AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (secretref), AZURE_REDIRECT_URI
AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_WHISPER_DEPLOYMENT, AZURE_OPENAI_API_KEY (secretref)
AZURE_SPEECH_REGION, AZURE_SPEECH_KEY (secretref)
ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET (secretref), ZOHO_REFRESH_TOKEN (secretref)
ZOHO_ACCOUNTS_URL, ZOHO_API_BASE, ZOHO_REDIRECT_URI
ZOHO_WORKDRIVE_API_BASE, ZOHO_WORKDRIVE_FOLDER_ID
RINGCENTRAL_SERVER_URL, RINGCENTRAL_CLIENT_ID, RINGCENTRAL_AGENT_PHONE
  RINGCENTRAL_CLIENT_SECRET (secretref), RINGCENTRAL_JWT (secretref)
DATABASE_URL (secretref), JWT_SECRET (secretref)
RATE_LIMIT_MAX_REQUESTS
# Prod only:
WORKDRIVE_REQUIRE_PER_CLIENT_FOLDER=true
```

---

## 8. After the deploy

| | Staging | Production |
|---|---|---|
| **Backend `/health`** | must return 200 | must return 200 |
| **Static site root** | must return 200 + show role picker | must return 200 + auto-redirect to `/auth/azure` |
| **Bundle URL grep** | `ca-cedingai-backend-staging` | `ca-cedingai-backend-prod` |
| **Backend logs** | clean (no `P2022`, no `PrismaClient` errors) for 5 min | clean for 15 min |
| **E2E smoke** | walk a Stage 1→10 case | walk a Stage 1→10 case — confirm Stage 9 hard-fails on Contacts missing `Client_Record_Folder_ID` |
| **Rollback prep** | last good image tag captured | last good image tag captured + PITR timestamp in `.prod-pitr-log` |

---

## 9. Don't do these (concrete anti-patterns from this repo's history)

1. **Don't run `npm run build` for a staging deploy** — it'll bake the
   prod backend URL into the staging static site. Use `npm run build:staging`.
2. **Don't trust the local `az acr build` exit code** — verify via ACR
   queries (§5.1).
3. **Don't roll the image before applying migrations** — three prod-style
   incidents (DEPLOY_CHECKLIST.md §"Why this exists") trace to this.
4. **Don't write `ALTER TABLE "User"` in migrations** — the Postgres
   table is `"users"` (§4.4).
5. **Don't push directly to `main`** unless explicitly authorized — open
   a PR.
6. **Don't enable `WORKDRIVE_REQUIRE_PER_CLIENT_FOLDER=true` in staging**
   — staging Contacts don't have `Client_Record_Folder_ID` populated,
   exports will 422.
7. **Don't put `VITE_DISABLE_DEMO_LOGIN=true` in `.env.staging`** — same
   reason; staging needs the role picker for cross-role QA.

---

*Last updated: post the auto-SSO + per-client-WorkDrive prod cutover
(commit `35a3395`). Maintained by Revathy. When env-flag policy changes,
update §2 and §7.3 in the same PR.*
