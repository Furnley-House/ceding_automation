# Production Deploy Runbook

**Environment:** `rg-ceding-ai-prod` (UK South). Backend + frontend only. AI extraction routes via the **staging** BFF (`ca-cedingai-api-staging`) until Nishant ships BFF prod.

**Migrations ALWAYS apply BEFORE the image rolls.** This is the same rule as `DEPLOY_CHECKLIST.md` — three staging incidents have been traced to violating it (2026-06-15 P2022, 2026-06-16 morning P2022, 2026-06-16 rollback P2022). On production it is a non-negotiable.

---

## 0. GDPR / TR-09 sign-off

Live client data is gated on a captured GDPR sign-off for TR-09. Reference recorded at prod-environment stand-up: **`<paste sign-off link / DocuSign ref / email message-id here at first deploy>`**. Do not load real client data until this line is filled in.

---

## 1. One-time: initial provisioning

Only run when the production environment does not yet exist. Idempotent — safe to re-run if a step half-fails.

```bash
# 1. confirm subscription
az account show --query name -o tsv         # expect: fh-ceding-ai

# 2. generate the Postgres admin password
#    32+ chars, mix of upper/lower/digit/special, NO '@' (pgbouncer quirk)
export PG_ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '@')"

# 3. run the provisioner
./scripts/provision-prod.sh
```

Outputs you need to capture from the run:
- `PG FQDN` — `pg-cedingai-prod.postgres.database.azure.com`
- `ACA env domain` — e.g. `<env-id>.uksouth.azurecontainerapps.io`
- `backend FQDN` — `ca-cedingai-backend-prod.<env-domain>.azurecontainerapps.io`
- `web endpoint` — `https://stcedingaiprod.z33.web.core.windows.net/`

---

## 2. Phase 2 — Secrets

Load `kv-cedingai-prod`. Names match staging convention (kebab-case in KV, SCREAMING_SNAKE in env vars).

```bash
KV=kv-cedingai-prod

# DATABASE-URL — built from PG admin password + FQDN captured above
PG_FQDN=$(az postgres flexible-server show -g rg-ceding-ai-prod -n pg-cedingai-prod \
  --query fullyQualifiedDomainName -o tsv)
DATABASE_URL="postgresql://ceding_admin:${PG_ADMIN_PASSWORD}@${PG_FQDN}:5432/ceding?sslmode=require"
az keyvault secret set --vault-name $KV --name DATABASE-URL --value "$DATABASE_URL" -o none

# JWT-SECRET — fresh
az keyvault secret set --vault-name $KV --name JWT-SECRET \
  --value "$(openssl rand -hex 48)" -o none

# BFF-SHARED-SECRET + INTERNAL-BFF-KEY — copied from staging (prod backend → staging BFF)
for s in BFF-SHARED-SECRET INTERNAL-BFF-KEY; do
  val=$(az keyvault secret show --vault-name kv-cedingai-staging --name $s --query value -o tsv)
  az keyvault secret set --vault-name $KV --name $s --value "$val" -o none
done

# AZURE-STORAGE-ACCOUNT-KEY — the prod storage account's primary key
SK=$(az storage account keys list -g rg-ceding-ai-prod -n stcedingaiprod \
  --query "[0].value" -o tsv)
az keyvault secret set --vault-name $KV --name AZURE-STORAGE-ACCOUNT-KEY --value "$SK" -o none

# AZURE-SPEECH-KEY — reuse staging Speech for v1 (matches BFF-reuse stance)
SPEECH=$(az cognitiveservices account keys list -g rg-ceding-ai-staging -n speech-cedingai-staging \
  --query "key1" -o tsv)
az keyvault secret set --vault-name $KV --name AZURE-SPEECH-KEY --value "$SPEECH" -o none

# The following five depend on out-of-band credentials. Set manually:
#   ZOHO-CLIENT-ID, ZOHO-CLIENT-SECRET   — from prod Zoho self-client
#   ZOHO-REFRESH-TOKEN                   — minted AFTER backend FQDN exists, in browser
#   AZURE-CLIENT-SECRET                  — Entra app secret for prod (separate from staging)
#   RINGCENTRAL-CLIENT-SECRET, RINGCENTRAL-JWT  — from prod RingCentral app
```

### Backend Container App env vars

Wire all secrets via `secretRef`, all non-sensitive inline. Replace the placeholder image and apply env in one update:

```bash
SHA=$(git rev-parse --short HEAD)
ACR=crcedingaiprod
BACKEND_FQDN=$(az containerapp show -g rg-ceding-ai-prod -n ca-cedingai-backend-prod \
  --query "properties.configuration.ingress.fqdn" -o tsv)
MI_ID=$(az identity show -g rg-ceding-ai-prod -n id-cedingai-prod --query id -o tsv)

# Mount KV-backed secrets onto the container app, each referencing the user-MI
for s in database-url jwt-secret bff-shared-secret internal-bff-key \
         azure-storage-account-key azure-speech-key azure-client-secret \
         zoho-client-secret zoho-refresh-token \
         ringcentral-client-secret ringcentral-jwt; do
  az containerapp secret set -g rg-ceding-ai-prod -n ca-cedingai-backend-prod \
    --secrets "$s=keyvaultref:https://kv-cedingai-prod.vault.azure.net/secrets/${s^^},identityref:$MI_ID" \
    -o none
done

az containerapp update -g rg-ceding-ai-prod -n ca-cedingai-backend-prod \
  --image $ACR.azurecr.io/ceding-backend:$SHA \
  --set-env-vars \
    PORT=3001 \
    NODE_ENV=production \
    "FRONTEND_URL=https://stcedingaiprod.z33.web.core.windows.net" \
    JWT_EXPIRES_IN=24h \
    AI_VIA_BFF=true \
    "BFF_BASE_URL=https://ca-cedingai-api-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io" \
    AZURE_STORAGE_ACCOUNT_NAME=stcedingaiprod \
    AZURE_STORAGE_CONTAINER_NAME=ceding-documents \
    AZURE_TENANT_ID=154b2b57-b0c8-49e8-8de9-3b252f5e7e27 \
    "AZURE_CLIENT_ID=<prod Entra app client id>" \
    "AZURE_REDIRECT_URI=https://${BACKEND_FQDN}/api/auth/azure/callback" \
    "AZURE_OPENAI_ENDPOINT=https://oai-cedingai-staging.openai.azure.com/" \
    AZURE_OPENAI_API_VERSION=2024-08-01-preview \
    AZURE_OPENAI_DEPLOYMENT=gpt-4.1 \
    AZURE_OPENAI_WHISPER_DEPLOYMENT=whisper \
    AZURE_SPEECH_REGION=uksouth \
    "ZOHO_CLIENT_ID=<prod Zoho self-client id>" \
    ZOHO_ACCOUNTS_URL=https://accounts.zoho.eu \
    ZOHO_API_BASE=https://www.zohoapis.eu/crm/v6 \
    "ZOHO_REDIRECT_URI=https://${BACKEND_FQDN}/api/crm/oauth/callback" \
    ZOHO_WORKDRIVE_API_BASE=https://www.zohoapis.eu/workdrive/api/v1 \
    "ZOHO_WORKDRIVE_FOLDER_ID=<prod WorkDrive folder id>" \
    RINGCENTRAL_SERVER_URL=https://platform.ringcentral.com \
    "RINGCENTRAL_CLIENT_ID=<prod RC client id>" \
    "RINGCENTRAL_AGENT_PHONE=<prod agent phone>" \
    RATE_LIMIT_MAX_REQUESTS=300 \
    DATABASE_URL=secretref:database-url \
    JWT_SECRET=secretref:jwt-secret \
    BFF_SHARED_SECRET=secretref:bff-shared-secret \
    INTERNAL_BFF_KEY=secretref:internal-bff-key \
    AZURE_STORAGE_ACCOUNT_KEY=secretref:azure-storage-account-key \
    AZURE_CLIENT_SECRET=secretref:azure-client-secret \
    AZURE_SPEECH_KEY=secretref:azure-speech-key \
    ZOHO_CLIENT_SECRET=secretref:zoho-client-secret \
    ZOHO_REFRESH_TOKEN=secretref:zoho-refresh-token \
    RINGCENTRAL_CLIENT_SECRET=secretref:ringcentral-client-secret \
    RINGCENTRAL_JWT=secretref:ringcentral-jwt \
  -o none
```

**Differences vs staging env worth flagging:**
- `ZOHO_API_BASE` flips from `sandbox.zohoapis.eu/crm/v6` (staging) → `www.zohoapis.eu/crm/v6` (prod, live Zoho org)
- `AZURE_REDIRECT_URI` + `ZOHO_REDIRECT_URI` use the prod backend FQDN
- `ZOHO_WORKDRIVE_FOLDER_ID` MUST be set (not relying on the sandbox-folder fallback in `backend/src/services/workdrive.ts` — see DEPLOY_HANDOFF §7b)
- `AZURE_CLIENT_ID` is the prod Entra app reg (new), not staging's `dff6d1a6-51d6-4854-ab3b-7ec09fadf2f8`
- `AI_VIA_BFF=true` and the BFF URL stays on staging until Nishant cuts over

### Entra (Azure AD) production app

Either (recommended) register a new app `ceding-automation-prod` in the FH tenant, or add the prod redirect URI to the existing app. With a separate app:
1. Azure Portal → Microsoft Entra ID → App registrations → New registration
2. Redirect URI (Web): `https://<backend-FQDN>/api/auth/azure/callback`
3. API permissions: openid, profile, email (admin consent)
4. Certificates & secrets → New client secret → store in `kv-cedingai-prod/AZURE-CLIENT-SECRET`
5. Capture the new `Application (client) ID` and put it in the `AZURE_CLIENT_ID` env var above

### Zoho prod re-auth (do after the backend FQDN is reachable)

The staging backend talks to **Zoho sandbox**; production must talk to the live Zoho org. New self-client + refresh token required.

1. In Zoho API Console (https://api-console.zoho.eu/), create a Server-based Application called `Ceding Automation Prod`. Redirect URI: `https://<backend-FQDN>/api/crm/oauth/callback`.
2. Capture `Client ID` + `Client Secret`, write them to KV (`ZOHO-CLIENT-ID` is non-sensitive but lives in env, secret is in KV).
3. From a browser logged into the **production** Zoho org, open: `https://<backend-FQDN>/api/crm/oauth/authorize`. Approve the consent screen — must include:
   - `ZohoCRM.modules.ALL`
   - `ZohoCRM.modules.contacts.READ`
   - `WorkDrive.files.ALL`
   - `WorkDrive.team.READ`
   - the base CRM read/write scopes
4. The callback prints the refresh token. Store via `az keyvault secret set --vault-name kv-cedingai-prod --name ZOHO-REFRESH-TOKEN --value "$TOKEN"`.
5. `az containerapp revision restart` so the token cache picks it up.

---

## 3. The sequence (every prod deploy, no exceptions)

### 3.1 Sync the repo

```powershell
git fetch origin
git pull --ff-only origin main      # or whichever branch ships to prod
```

Confirm `git status` shows up-to-date with the prod-deploying branch and a clean working tree.

### 3.2 Run the pre-deploy migration scan

```bash
./scripts/predeploy-check.sh
```

This is the same offline scanner used for staging. Flags additive vs destructive migrations.

### 3.3 Compare repo migrations vs prod's applied set

Open the firewall (see 3.5) just long enough to run:

```bash
cd backend
DATABASE_URL=$(az keyvault secret show --vault-name kv-cedingai-prod --name DATABASE-URL --query value -o tsv) \
  npx prisma migrate status
```

Look for the `Following migrations have not yet been applied` block. Cross-reference with 3.2's destructive-vs-additive labels.

### 3.4 Read every pending migration's SQL

For each migration listed by `migrate status` but not yet applied:

- **Purely additive** (`ALTER TABLE ... ADD COLUMN <nullable>`, `ALTER TYPE ... ADD VALUE`): safe to apply immediately. Existing rows are unaffected; no backfill needed.
- **Destructive** (`DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN`, `RENAME`, `DELETE FROM`, `UPDATE ... SET`, `TRUNCATE`): **AUDIT FIRST.** Write a row-count query proving zero data loss. The 2026-06-16 LOA migration audit in `docs/DEPLOY_CHECKLIST.md` §4 is the template.

### 3.5 Apply migrations via the firewall ceremony — **mandatory PITR capture**

```bash
# MANDATORY in prod (optional in staging): capture pre-migrate UTC for PITR
PRE_MIGRATE_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "PRE_MIGRATE_UTC=$PRE_MIGRATE_UTC" | tee -a docs/.prod-pitr-log

# Verify your public IP — it rotates on most consumer connections
MY_IP=$(curl -s https://api.ipify.org)
echo "MY_IP=$MY_IP"

# Open scope to your current IP only
az postgres flexible-server firewall-rule create \
  -n pg-cedingai-prod -g rg-ceding-ai-prod \
  --rule-name "$(whoami)-migrate-temp-$(date +%Y%m%d-%H%M)" \
  --start-ip-address "$MY_IP" --end-ip-address "$MY_IP"

# Wait ~15-20s for propagation
sleep 20

# Apply
cd backend
DATABASE_URL=$(az keyvault secret show --vault-name kv-cedingai-prod --name DATABASE-URL --query value -o tsv) \
  npx prisma migrate deploy

# Verify "Database schema is up to date!" + spot-check the new columns
DATABASE_URL=$(az keyvault secret show --vault-name kv-cedingai-prod --name DATABASE-URL --query value -o tsv) \
  npx prisma migrate status

# DELETE the firewall rule, ALWAYS, success or failure
az postgres flexible-server firewall-rule delete \
  -n pg-cedingai-prod -g rg-ceding-ai-prod \
  --rule-name "$(whoami)-migrate-temp-..."  # use the exact name from create
```

### 3.6 THEN build + roll the image

Only after 3.5 confirms the prod DB schema matches what the new image expects:

```bash
NEW_SHA=$(git rev-parse --short HEAD)
az acr build -t "ceding-backend:$NEW_SHA" -t "ceding-backend:latest" \
  -r crcedingaiprod backend
# (cp1252 crash in the local az CLI is expected on the build's `prisma generate`
#  step — verify success by querying the ACR tag, NOT the local exit code)

az acr repository show-tags -n crcedingaiprod --repository ceding-backend \
  --query "[?@=='$NEW_SHA']" -o tsv   # confirm tag landed

az containerapp update -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
  --image "crcedingaiprod.azurecr.io/ceding-backend:$NEW_SHA"
```

### 3.7 Frontend build + upload

```bash
cd frontend
npm ci
npm run build                      # vite uses .env.production
az storage blob upload-batch \
  --account-name stcedingaiprod \
  --auth-mode key \
  --account-key "$(az storage account keys list -g rg-ceding-ai-prod -n stcedingaiprod --query '[0].value' -o tsv)" \
  -s dist -d '$web' --overwrite
```

### 3.8 Verify the deploy

- Poll revision health until `Healthy` + `traffic: 100`:
  ```bash
  az containerapp revision list -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
    --query "[?properties.active].{name:name, health:properties.healthState, traffic:properties.trafficWeight}" -o table
  ```
- `curl https://<backend-FQDN>/health` returns HTTP 200.
- Scan Log Analytics for `P2022`, `PrismaClient`, `error` patterns on the new revision in a ~5-minute window. **Zero** is the only acceptable count.
- Open the static-site URL, log in, walk an end-to-end case (Stage 4 → 9 export) — see "Smoke tests" below.

---

## 4. Rollback playbook (prod-specific)

Production runs **2 min replicas with HTTP scale** to 5 — unlike staging (fixed 1/1). This makes weighted-traffic rollback feasible.

### Additive-migration rollback (safe)

```bash
PREV_SHA=$(az containerapp revision list -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
  --query "[?properties.active==\`false\`].properties.template.containers[0].image" -o tsv | head -1 | awk -F: '{print $NF}')

az containerapp update -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
  --image "crcedingaiprod.azurecr.io/ceding-backend:$PREV_SHA"
```

ACA spins a new revision with the old image. With single-revision mode, the new revision replaces traffic atomically; with multiple-revisions mode (a follow-up TR), use `containerapp revision set-mode multiple` and weight traffic 90/10 then 50/50.

### Destructive-migration rollback (UNSAFE — fix forward)

Per `DEPLOY_CHECKLIST.md` lessons: a destructive migration breaks the OLD image's Prisma client too, because that client references dropped/renamed columns. **Do not roll back; fix forward.** The forward-compatible new image heals automatically once the columns exist.

If forward-fix is impossible, restore from PITR to `$PRE_MIGRATE_UTC` captured in 3.5:

```bash
az postgres flexible-server restore \
  -g rg-ceding-ai-prod -n pg-cedingai-prod-restored-$(date +%Y%m%d%H%M) \
  --source-server pg-cedingai-prod \
  --restore-time "$PRE_MIGRATE_UTC"
```

Then update `DATABASE-URL` in KV to point at the restored server, restart the Container App revision.

---

## 5. Smoke tests after deploy

Same shape as `DEPLOY_HANDOFF_TO_NISHANT.md` §6, adapted for prod (Megan Doherty is the demo paraplanner; replace with prod-real users once they exist).

| # | Test | Expected | Where |
|---|------|----------|-------|
| 1 | Backend `/health` | `200 {status: "ok"}` | `https://<prod-backend>/health` |
| 2 | Admin Panel → Checklist → ISA | 34 active fields (canonical) | UI |
| 3 | Sign in via Entra | Lands on dashboard, role-aware | UI |
| 4 | Open a case → Stage 4 → fill missing fields → Stage 6 | "Returned" tile / "Send anyway" button visible | UI |
| 5 | Stage 6 → Send for approval | Toast confirms; paraplanner inbox shows the case | UI |
| 6 | Approval (Stage 8) → Approve all → Mark approved | No 403; status flips to APPROVED | UI |
| 7 | Stage 9 → Complete export | Downloads .xlsx + WorkDrive upload OK + `zohoUpdate.ok: true` | Network tab |
| 8 | Open the downloaded .xlsx | 4 sheets: Summary / Checklist / Fund Details / Audit Trail | Excel |
| 9 | All cases for a contact complete → Dashboard | Purple "All ceding done · Prepare SR" badge | UI |
| 10 | Refresh-from-Zoho on case header | Pulls paraplanner from Contact module | UI + DevTools |
| 11 | AI extraction request | Backend logs show outbound `BFF_BASE_URL` = staging FQDN, response 200 | Container App logs |

Item 11 confirms the cross-RG BFF path. If it fails, the most likely causes are wrong `BFF_SHARED_SECRET` (didn't copy from staging KV) or wrong `INTERNAL_BFF_KEY`.

---

## 6. BFF-prod cutover (future)

When Nishant ships BFF prod:

```bash
# 1. Read the new values
PROD_BFF_URL="https://ca-cedingai-api-prod.<prod-env-domain>.azurecontainerapps.io"

# 2. Update the two shared secrets in KV (provided by Nishant)
az keyvault secret set --vault-name kv-cedingai-prod --name BFF-SHARED-SECRET --value "$NEW_SHARED" -o none
az keyvault secret set --vault-name kv-cedingai-prod --name INTERNAL-BFF-KEY  --value "$NEW_INTERNAL" -o none

# 3. Update the URL on the Container App
az containerapp update -g rg-ceding-ai-prod -n ca-cedingai-backend-prod \
  --set-env-vars "BFF_BASE_URL=$PROD_BFF_URL"

# 4. Restart the revision so the new secrets are picked up
az containerapp revision restart -g rg-ceding-ai-prod -n ca-cedingai-backend-prod \
  --revision $(az containerapp revision list -g rg-ceding-ai-prod -n ca-cedingai-backend-prod \
    --query "[?properties.active].name" -o tsv | head -1)
```

**Rotate the staging copies of `BFF-SHARED-SECRET` / `INTERNAL-BFF-KEY` too** once prod has its own — staging shouldn't keep credentials that were ever shared with prod.

---

## 7. Lessons baked in (the why behind the rules)

These come straight from `docs/DEPLOY_CHECKLIST.md` and three real staging incidents; they apply identically to prod (and harder).

- **Rollback to an old image is only safe across an ADDITIVE migration.** Destructive migrations break the OLD image's Prisma client. For destructive migrations: fix forward, never back.
- **Your public IP rotates.** Always `curl https://api.ipify.org` immediately before creating the firewall rule.
- **Verify against Azure ground truth, not transcripts.** `az containerapp show ... --query`, `az acr repository show-tags`, `prisma migrate status` against the live DB.
- **The local `az` CLI crashes with `UnicodeEncodeError: 'charmap' codec` (cp1252)** on emoji glyphs in build streams. The build itself succeeds server-side. Verify ACR tag presence rather than trusting the local exit code.
- **In prod, missing 2 min replicas during scale-down windows means slower rollbacks.** Don't lower `min-replicas` below 2 without a deliberate reason.

---

## 8. When this checklist does not apply

- Pure code change with no schema diff (S0 logging, copy tweaks, env-var-only changes): skip 3.3–3.5; just 3.1, 3.2, 3.6, 3.7, 3.8.
- Migration applied to prod by someone else already: still run `prisma migrate status` in 3.3 to confirm. Don't assume.
