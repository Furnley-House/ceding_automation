#!/usr/bin/env bash
# scripts/provision-prod.sh
#
# Idempotent Azure provisioning for the ceding-automation production
# environment (rg-ceding-ai-prod). Backend + frontend only — the BFF / AI
# pipeline surface stays in rg-ceding-ai-staging for v1 and the prod backend
# talks to staging BFF until Nishant cuts it over.
#
# Scope (mirrors staging via DEPLOY_HANDOFF_TO_NISHANT.md, hardened where
# noted; see C:\Users\RevathyS\.claude\plans\keen-soaring-wren.md):
#   1. Resource Group           rg-ceding-ai-prod
#   2. Log Analytics            law-cedingai-prod          (90d retention)
#   3. App Insights             appi-cedingai-prod         (workspace-based)
#   4. User-assigned Identity   id-cedingai-prod
#   5. Key Vault                kv-cedingai-prod           (RBAC, purge-protect)
#   6. Container Registry       crcedingaiprod             (Standard)
#   7. Storage Account          stcedingaiprod             ($web + private container)
#   8. PostgreSQL Flex          pg-cedingai-prod           (GP D2s_v3, HA, 35d)
#   9. Container Apps Env       cae-cedingai-prod          (wired to LAW)
#  10. Backend Container App    ca-cedingai-backend-prod   (2-5 replicas)
#
# Idempotency: every `create` is preceded by an existence check. Re-runs are
# safe and surface "already exists" lines without erroring out. We intentionally
# do NOT use `set -e` so a single partial failure leaves the rest reachable.
#
# Style: mirrors scripts/predeploy-check.sh — ASCII-only output (cp1252-safe),
# `set -u`, bash idioms over PowerShell so the same script works from Git Bash
# or any *nix shell.
#
# Usage:
#   # 1. confirm subscription
#   az account show --query name -o tsv          # expect: fh-ceding-ai
#
#   # 2. set the Postgres admin password BEFORE running:
#   export PG_ADMIN_PASSWORD='<32+ random chars>'
#   #    (or you'll be prompted)
#
#   # 3. run
#   ./scripts/provision-prod.sh
#
# After this script: populate kv-cedingai-prod secrets (see PROD_DEPLOY.md
# section "Phase 2 — Secrets"), apply Prisma migrations, build + push the
# backend image, then deploy the frontend static site.

set -u

# ────────────────────────────────────────────────────────────────────────────
# Constants — change here, nowhere else.
# ────────────────────────────────────────────────────────────────────────────
SUBSCRIPTION_NAME="fh-ceding-ai"
LOCATION="uksouth"

RG="rg-ceding-ai-prod"
LAW="law-cedingai-prod"
APPI="appi-cedingai-prod"
MI="id-cedingai-prod"
KV="kv-cedingai-prod"
ACR="crcedingaiprod"
STORAGE="stcedingaiprod"
PG="pg-cedingai-prod"
PG_ADMIN_USER="ceding_admin"
PG_DB_NAME="ceding"
PG_SKU="Standard_D2s_v3"
PG_TIER="GeneralPurpose"
PG_VERSION="16"
PG_STORAGE_GB=64
PG_BACKUP_RETENTION_DAYS=35
CAE="cae-cedingai-prod"
BACKEND_APP="ca-cedingai-backend-prod"
LAW_RETENTION_DAYS=90

STORAGE_BLOB_CONTAINER="ceding-documents"

# Placeholder image used at Container App create time. Replaced by the real
# backend image (crcedingaiprod.azurecr.io/ceding-backend:<sha>) in the
# subsequent `az containerapp update` step of the deploy sequence.
PLACEHOLDER_IMAGE="mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"

# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────
log()      { echo "  $*"; }
heading()  { echo ""; echo "================================================================"; echo " $*"; echo "================================================================"; }
# exists() returns 0 if the resource lookup succeeds AND emits a non-empty,
# non-"null" string. Prior version trusted "any stdout output" which was fooled
# by az CLI extension-install prompts that print to stdout before failing.
exists() {
  local out rc
  out=$("$@" 2>/dev/null)
  rc=$?
  [ $rc -eq 0 ] && [ -n "$out" ] && [ "$out" != "null" ]
}

# ────────────────────────────────────────────────────────────────────────────
# 0. Sanity checks
# ────────────────────────────────────────────────────────────────────────────
heading "0. Pre-flight"

CUR_SUB=$(az account show --query name -o tsv 2>/dev/null || true)
if [ "$CUR_SUB" != "$SUBSCRIPTION_NAME" ]; then
  log "[error] az subscription is '$CUR_SUB', expected '$SUBSCRIPTION_NAME'"
  log "        run: az account set --subscription $SUBSCRIPTION_NAME"
  exit 1
fi
log "subscription      $CUR_SUB"
log "location          $LOCATION"
log "resource group    $RG"

if [ -z "${PG_ADMIN_PASSWORD:-}" ]; then
  log ""
  log "PG_ADMIN_PASSWORD is not set. Either export it or you will be"
  log "prompted now (32+ chars recommended, must include upper, lower,"
  log "digit, special; no '@' in password — pgbouncer quirks)."
  read -rsp "Postgres admin password: " PG_ADMIN_PASSWORD
  echo ""
  if [ -z "$PG_ADMIN_PASSWORD" ]; then
    log "[error] empty password — aborting"
    exit 1
  fi
fi

# The az 'application-insights' extension is required by App Insights commands.
# In non-interactive runs the dynamic-install prompt fails with EOFError —
# install it eagerly so step 3 doesn't break.
if ! az extension list --query "[?name=='application-insights'].name" -o tsv | grep -q application-insights; then
  log "installing  az extension application-insights"
  az extension add --name application-insights -y -o none 2>/dev/null || \
    az config set extension.use_dynamic_install=yes_without_prompt -o none
fi

# ────────────────────────────────────────────────────────────────────────────
# 1. Resource group
# ────────────────────────────────────────────────────────────────────────────
heading "1. Resource group"

if exists az group show -n "$RG" --query id -o tsv; then
  log "[exists]    $RG"
else
  log "[creating]  $RG"
  az group create -n "$RG" -l "$LOCATION" -o none
  log "[ok]        $RG"
fi

# ────────────────────────────────────────────────────────────────────────────
# 2. Log Analytics Workspace
# ────────────────────────────────────────────────────────────────────────────
heading "2. Log Analytics Workspace"

if exists az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query id -o tsv; then
  log "[exists]    $LAW"
else
  log "[creating]  $LAW (retention ${LAW_RETENTION_DAYS}d)"
  az monitor log-analytics workspace create \
    -g "$RG" -n "$LAW" -l "$LOCATION" \
    --retention-time "$LAW_RETENTION_DAYS" \
    -o none
  log "[ok]        $LAW"
fi

LAW_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query id -o tsv)
LAW_CUSTOMER_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query customerId -o tsv)
LAW_SHARED_KEY=$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LAW" --query primarySharedKey -o tsv)

# ────────────────────────────────────────────────────────────────────────────
# 3. Application Insights (workspace-based)
# ────────────────────────────────────────────────────────────────────────────
heading "3. Application Insights"

if exists az monitor app-insights component show -g "$RG" --app "$APPI" --query id -o tsv; then
  log "[exists]    $APPI"
else
  log "[creating]  $APPI (workspace-based, wired to $LAW)"
  # MSYS_NO_PATHCONV=1 — Git Bash otherwise mangles the LAW resource id arg
  MSYS_NO_PATHCONV=1 az monitor app-insights component create \
    -g "$RG" --app "$APPI" -l "$LOCATION" \
    --workspace "$LAW_ID" \
    --kind web --application-type web \
    -o none
  log "[ok]        $APPI"
fi

APPI_CONNSTR=$(az monitor app-insights component show -g "$RG" --app "$APPI" --query connectionString -o tsv)

# ────────────────────────────────────────────────────────────────────────────
# 4. User-assigned Managed Identity
# ────────────────────────────────────────────────────────────────────────────
heading "4. User-assigned Managed Identity"

if exists az identity show -g "$RG" -n "$MI" --query id -o tsv; then
  log "[exists]    $MI"
else
  log "[creating]  $MI"
  az identity create -g "$RG" -n "$MI" -l "$LOCATION" -o none
  log "[ok]        $MI"
fi

MI_ID=$(az identity show -g "$RG" -n "$MI" --query id -o tsv)
MI_PRINCIPAL=$(az identity show -g "$RG" -n "$MI" --query principalId -o tsv)
MI_CLIENT_ID=$(az identity show -g "$RG" -n "$MI" --query clientId -o tsv)
log "principalId       $MI_PRINCIPAL"
log "clientId          $MI_CLIENT_ID"

# ────────────────────────────────────────────────────────────────────────────
# 5. Key Vault
# ────────────────────────────────────────────────────────────────────────────
heading "5. Key Vault"

if exists az keyvault show -g "$RG" -n "$KV" --query id -o tsv; then
  log "[exists]    $KV"
else
  log "[creating]  $KV (RBAC, purge-protect ON)"
  az keyvault create \
    -g "$RG" -n "$KV" -l "$LOCATION" \
    --enable-rbac-authorization true \
    --enable-purge-protection true \
    --retention-days 90 \
    -o none
  log "[ok]        $KV"
fi

KV_ID=$(az keyvault show -g "$RG" -n "$KV" --query id -o tsv)

# Grant the managed identity read access on secrets.
# (Role: Key Vault Secrets User — built-in, scope KV)
log "assigning   Key Vault Secrets User on $KV -> $MI"
MSYS_NO_PATHCONV=1 az role assignment create \
  --assignee-object-id "$MI_PRINCIPAL" \
  --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" \
  --scope "$KV_ID" \
  -o none 2>/dev/null || log "            (already assigned)"

# Also grant the CURRENT user "Key Vault Secrets Officer" so the
# secret-write step in Phase 2 works.
CURRENT_USER_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
if [ -n "$CURRENT_USER_OID" ]; then
  log "assigning   Key Vault Secrets Officer on $KV -> current user ($CURRENT_USER_OID)"
  az role assignment create \
    --assignee-object-id "$CURRENT_USER_OID" \
    --assignee-principal-type User \
    --role "Key Vault Secrets Officer" \
    --scope "$KV_ID" \
    -o none 2>/dev/null || log "            (already assigned)"
fi

# ────────────────────────────────────────────────────────────────────────────
# 6. Container Registry
# ────────────────────────────────────────────────────────────────────────────
heading "6. Container Registry"

if exists az acr show -g "$RG" -n "$ACR" --query id -o tsv; then
  log "[exists]    $ACR"
else
  log "[creating]  $ACR (Standard)"
  az acr create -g "$RG" -n "$ACR" -l "$LOCATION" --sku Standard -o none
  log "[ok]        $ACR"
fi

ACR_ID=$(az acr show -g "$RG" -n "$ACR" --query id -o tsv)
ACR_LOGIN_SERVER=$(az acr show -g "$RG" -n "$ACR" --query loginServer -o tsv)

log "assigning   AcrPull on $ACR -> $MI"
MSYS_NO_PATHCONV=1 az role assignment create \
  --assignee-object-id "$MI_PRINCIPAL" \
  --assignee-principal-type ServicePrincipal \
  --role "AcrPull" \
  --scope "$ACR_ID" \
  -o none 2>/dev/null || log "            (already assigned)"

# ────────────────────────────────────────────────────────────────────────────
# 7. Storage Account
# ────────────────────────────────────────────────────────────────────────────
heading "7. Storage Account"

if exists az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv; then
  log "[exists]    $STORAGE"
else
  log "[creating]  $STORAGE (Standard_LRS, StorageV2)"
  az storage account create \
    -g "$RG" -n "$STORAGE" -l "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 \
    --allow-blob-public-access false \
    -o none
  log "[ok]        $STORAGE"
fi

STORAGE_ID=$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)
STORAGE_KEY=$(az storage account keys list -g "$RG" -n "$STORAGE" --query "[0].value" -o tsv)
WEB_ENDPOINT=$(az storage account show -g "$RG" -n "$STORAGE" --query "primaryEndpoints.web" -o tsv)

log "enabling    static-website hosting"
az storage blob service-properties update \
  --account-name "$STORAGE" --account-key "$STORAGE_KEY" \
  --static-website --index-document index.html --404-document index.html \
  -o none

# Per Nishant's prod plan §2: prefer Standard_ZRS. Try an in-place upgrade.
# Only does anything if the account is currently LRS. Safe to re-run.
CUR_SKU=$(az storage account show -g "$RG" -n "$STORAGE" --query "sku.name" -o tsv)
if [ "$CUR_SKU" = "Standard_LRS" ]; then
  log "upgrading   $STORAGE SKU $CUR_SKU -> Standard_ZRS (in-place)"
  az storage account update -g "$RG" -n "$STORAGE" --sku Standard_ZRS -o none \
    && log "[ok]        $STORAGE now Standard_ZRS" \
    || log "[skip]      in-place LRS->ZRS not supported; do via portal Customer-Initiated Conversion"
else
  log "[ok]        $STORAGE SKU = $CUR_SKU (already non-LRS)"
fi

if exists az storage container show \
    --account-name "$STORAGE" --account-key "$STORAGE_KEY" \
    --name "$STORAGE_BLOB_CONTAINER" --query name -o tsv; then
  log "[exists]    blob container $STORAGE_BLOB_CONTAINER"
else
  log "[creating]  blob container $STORAGE_BLOB_CONTAINER (private)"
  az storage container create \
    --account-name "$STORAGE" --account-key "$STORAGE_KEY" \
    --name "$STORAGE_BLOB_CONTAINER" \
    --public-access off \
    -o none
  log "[ok]        blob container $STORAGE_BLOB_CONTAINER"
fi

log "assigning   Storage Blob Data Contributor on $STORAGE -> $MI"
MSYS_NO_PATHCONV=1 az role assignment create \
  --assignee-object-id "$MI_PRINCIPAL" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "$STORAGE_ID" \
  -o none 2>/dev/null || log "            (already assigned)"

log "web endpoint      $WEB_ENDPOINT"

# ────────────────────────────────────────────────────────────────────────────
# 8. PostgreSQL Flexible Server
# ────────────────────────────────────────────────────────────────────────────
heading "8. PostgreSQL Flexible Server"

if exists az postgres flexible-server show -g "$RG" -n "$PG" --query id -o tsv; then
  log "[exists]    $PG"
else
  log "[creating]  $PG ($PG_TIER $PG_SKU, PG $PG_VERSION, ${PG_STORAGE_GB}GB,"
  log "             backup ${PG_BACKUP_RETENTION_DAYS}d GZRS, HA on)"
  log "             this takes ~10 minutes ..."
  # az CLI 2.87+ uses --zonal-resiliency Enabled (NOT --high-availability).
  # --allow-same-zone lets the standby co-locate when cross-zone capacity is
  # constrained, which UK South frequently is.
  az postgres flexible-server create \
    -g "$RG" -n "$PG" -l "$LOCATION" \
    --tier "$PG_TIER" --sku-name "$PG_SKU" \
    --version "$PG_VERSION" \
    --storage-size "$PG_STORAGE_GB" \
    --backup-retention "$PG_BACKUP_RETENTION_DAYS" \
    --geo-redundant-backup Enabled \
    --zonal-resiliency Enabled \
    --allow-same-zone \
    --public-access None \
    --admin-user "$PG_ADMIN_USER" \
    --admin-password "$PG_ADMIN_PASSWORD" \
    --yes \
    -o none
  rc=$?
  if [ $rc -ne 0 ]; then
    log "[error]     Postgres flex create failed (exit $rc) — skipping dependent steps"
  else
    log "[ok]        $PG"
    # Allow Azure services + Container Apps to reach it without IP listing.
    # (Same pattern staging uses; switch to private endpoint in a follow-up TR.)
    # NOTE: this CLI requires -s/--server-name not -n.
    log "[creating]  firewall rule AllowAllAzureServices (0.0.0.0)"
    # az postgres flexible-server firewall-rule expects --name (NOT --rule-name)
    az postgres flexible-server firewall-rule create \
      -g "$RG" -s "$PG" \
      --name AllowAllAzureServices \
      --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 \
      -o none
  fi
fi

# Create the database (idempotent — the CLI is happy with 'already exists').
# Skip if the flex server itself doesn't exist yet (e.g. failed create above).
if exists az postgres flexible-server show -g "$RG" -n "$PG" --query id -o tsv; then
  log "[ensuring]  database $PG_DB_NAME"
  az postgres flexible-server db create \
    -g "$RG" -s "$PG" -d "$PG_DB_NAME" \
    -o none 2>/dev/null || log "            (already exists)"

  PG_FQDN=$(az postgres flexible-server show -g "$RG" -n "$PG" --query fullyQualifiedDomainName -o tsv)
  log "PG FQDN           $PG_FQDN"
else
  log "[skip]      flex server not present — fix Postgres step and re-run"
  PG_FQDN=""
fi

# ────────────────────────────────────────────────────────────────────────────
# 9. Container Apps Environment
# ────────────────────────────────────────────────────────────────────────────
heading "9. Container Apps Environment"

if exists az containerapp env show -g "$RG" -n "$CAE" --query id -o tsv; then
  log "[exists]    $CAE"
else
  log "[creating]  $CAE (wired to $LAW)"
  az containerapp env create \
    -g "$RG" -n "$CAE" -l "$LOCATION" \
    --logs-workspace-id "$LAW_CUSTOMER_ID" \
    --logs-workspace-key "$LAW_SHARED_KEY" \
    -o none
  log "[ok]        $CAE"
fi

CAE_DOMAIN=$(az containerapp env show -g "$RG" -n "$CAE" --query "properties.defaultDomain" -o tsv)
log "ACA env domain    $CAE_DOMAIN"

# ────────────────────────────────────────────────────────────────────────────
# 10. Backend Container App (placeholder image)
# ────────────────────────────────────────────────────────────────────────────
heading "10. Backend Container App"

if exists az containerapp show -g "$RG" -n "$BACKEND_APP" --query id -o tsv; then
  log "[exists]    $BACKEND_APP"
else
  log "[creating]  $BACKEND_APP with placeholder image"
  log "            (real image rolls in via 'az containerapp update' after"
  log "             'az acr build' in the deploy sequence)"
  # MSYS_NO_PATHCONV=1 prevents Git Bash from rewriting the Azure resource
  # path (which starts with '/') to a Windows path under "c:/program files/git".
  # Without this, --user-assigned "$MI_ID" gets mangled into an invalid id.
  MSYS_NO_PATHCONV=1 az containerapp create \
    -g "$RG" -n "$BACKEND_APP" \
    --environment "$CAE" \
    --image "$PLACEHOLDER_IMAGE" \
    --target-port 3001 --ingress external \
    --min-replicas 2 --max-replicas 5 \
    --cpu 0.5 --memory 1.0Gi \
    --user-assigned "$MI_ID" \
    -o none
  rc=$?
  if [ $rc -ne 0 ]; then
    log "[error]     containerapp create failed (exit $rc) — skipping CORS + scale"
  else
    log "[ok]        $BACKEND_APP"

    # CORS — allow only the prod static site origin (strip trailing /).
    WEB_ORIGIN="${WEB_ENDPOINT%/}"
    log "configuring CORS allowed-origins = $WEB_ORIGIN"
    az containerapp ingress cors enable \
      -g "$RG" -n "$BACKEND_APP" \
      --allowed-origins "$WEB_ORIGIN" \
      --allowed-methods GET POST PUT PATCH DELETE OPTIONS \
      --allowed-headers "*" \
      --allow-credentials true \
      --max-age 86400 \
      -o none

    # HTTP scale rule: 50 concurrent requests per replica (staging is fixed 1/1
    # so this is a prod-only hardening choice).
    log "adding      HTTP scale rule (50 concurrent / replica)"
    az containerapp update \
      -g "$RG" -n "$BACKEND_APP" \
      --scale-rule-name http-scale \
      --scale-rule-type http \
      --scale-rule-http-concurrency 50 \
      -o none
  fi
fi

BACKEND_FQDN=$(az containerapp show -g "$RG" -n "$BACKEND_APP" --query "properties.configuration.ingress.fqdn" -o tsv)
log "backend FQDN      https://$BACKEND_FQDN"

# ────────────────────────────────────────────────────────────────────────────
# Done
# ────────────────────────────────────────────────────────────────────────────
heading "Done"
log "next steps:"
log "  1. populate $KV secrets — see docs/PROD_DEPLOY.md Phase 2"
log "  2. open temporary firewall rule on $PG (your current public IP)"
log "  3. cd backend && npx prisma migrate deploy"
log "  4. close firewall rule"
log "  5. update frontend/.env.production with: https://$BACKEND_FQDN/api"
log "  6. az acr build -t ceding-backend:\$SHA -r $ACR backend"
log "  7. az containerapp update -n $BACKEND_APP -g $RG --image $ACR_LOGIN_SERVER/ceding-backend:\$SHA"
log "  8. (cd frontend && npm ci && npm run build) && \\"
log "        az storage blob upload-batch --account-name $STORAGE -s frontend/dist -d '\$web' --overwrite"
log ""
log "  AI extraction in prod is served by STAGING BFF until Nishant cuts over:"
log "      BFF_BASE_URL=https://ca-cedingai-api-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io"
log "      BFF_SHARED_SECRET / INTERNAL_BFF_KEY = staging values"
log ""

exit 0
