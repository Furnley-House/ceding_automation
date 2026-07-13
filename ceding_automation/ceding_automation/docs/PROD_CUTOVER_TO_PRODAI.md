# Prod Cutover Runbook — Connect Live Prod Backend to the `prodai` AI Layer (Option A)

**Status:** Ready to execute. All investigation complete; this is a known, mapped plan.
**Do this fresh, not at the end of a long session.** Every step here touches or supports LIVE production (57 real client cases, 22 users, compliance audit trail).
**Golden rule:** the production database (`pg-cedingai-prod`) is NEVER touched by this cutover. If anything feels wrong, STOP and roll back.

---

## 0. What this achieves (and what it does NOT)

**Goal:** Point the live prod backend (`ca-cedingai-backend-prod` in `rg-ceding-ai-prod`) at the clean, latest-code `prodai` AI layer instead of borrowing staging's — without touching the database, users, cases, or audit trail.

**In scope:**
- Wire the prodai BFF's backend-auth layer (it currently has none).
- Copy the 16 referenced document blobs into prodai storage.
- Flip 2 backend env vars (BFF URL + storage account).
- Smoke test end-to-end.
- Rotate the exposed OpenAI key (security fix, independent but bundled).

**Explicitly NOT in scope (do later, separately):**
- No DB migration (DB stays in `rg-ceding-ai-prod`, untouched).
- No retiring `rg-ceding-ai-prod-v2` (do AFTER cutover is confirmed, and confirm with Srinath first).
- No Phase 2 AI-layer build (separate future work).
- The backend's OWN OpenAI (`AZURE_OPENAI_ENDPOINT` for call-scripts/Whisper) stays on staging — prodai has no Whisper deployment. Do not touch it.

---

## ROLLBACK POINT (capture/confirm BEFORE any change)

Current live backend AI-connection env (this is the "undo" target):

| Env var | Current value (rollback to this) |
|---|---|
| `AI_VIA_BFF` | `true` |
| `BFF_BASE_URL` | `https://ca-cedingai-api-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io` |
| `AZURE_STORAGE_ACCOUNT_NAME` | `stcedingaistaging` |

**Rollback = set those three back on `ca-cedingai-backend-prod`, AND restore the `azure-storage-account-key` secret to the staging storage key** (see Step 3 rollback for the exact command). Staging still holds all data, so rollback is always data-safe.

Subscription (always set first):
```bash
az account set --subscription 1aa0ae2e-b817-4486-bdd2-d417a1aadea2
```

---

## Key facts / reference values

- **Prod backend app:** `ca-cedingai-backend-prod` (RG `rg-ceding-ai-prod`), minReplicas=2, image `ceding-backend:21d019d`.
- **Prodai BFF FQDN (new target):** `https://ca-cedingai-api-prodai.livelyflower-07874036.uksouth.azurecontainerapps.io`
- **Prodai BFF app:** `ca-cedingai-api-prodai` (RG `rg-ceding-ai-prodai`).
- **Prodai storage:** `stcedingaiprodai` (containers `ceding-documents`, `ceding-ocr-cache` already exist).
- **Backend KV:** `kv-cedingai-prod` — has `bff-shared-secret`, `internal-bff-key` (the values the backend uses).
- **Prodai KV:** `kv-cedingai-prodai` — MISSING the two BFF secrets (must add).
- **Staging BFF env pattern (the working reference):** uses `BFF_SHARED_SECRET` (secretRef `bff-shared-secret`) + `COLLEAGUE_BACKEND_API_KEY` (secretRef `internal-bff-key`).
- **BFF env var names verified** (as of 77b0c6d):
  - Inbound: `bff/middleware/auth.py:8-25` reads `X-API-Key` header, compares against `settings.bff_shared_secret` (Pydantic env var **`BFF_SHARED_SECRET`**, `bff/config.py:19`).
  - Outbound: `bff/services/colleague_backend_client.py:20,38,101` reads `self._settings.colleague_backend_api_key` and sends as `X-Internal-Key` header (Pydantic env var **`COLLEAGUE_BACKEND_API_KEY`**, `shared/config.py:73`).
  - **Step 1d names are correct as written.**
- **16 document blobs to copy:** 15 from `stcedingaistaging`, 1 from `stcedingaiprod` (the ERROR-status one — optional). Exact paths in Appendix A.

---

## STEP 1 — Wire the prodai BFF's backend-auth layer

**Why:** The prodai BFF currently only has `AOAI_API_KEY`. It has NO `BFF_SHARED_SECRET` and NO `COLLEAGUE_BACKEND_API_KEY`. Without these, the backend↔BFF authentication fails on the first call. We copy the backend's EXISTING values so both sides match (backend secrets don't change).

**Reversible?** Yes — this only adds secrets/env to the prodai BFF; it doesn't touch the backend and no traffic flows there yet.

```bash
az account set --subscription 1aa0ae2e-b817-4486-bdd2-d417a1aadea2

# 1a. Read the backend's current BFF secret values (from backend KV) into shell vars. Do NOT echo them.
BSS=$(az keyvault secret show --vault-name kv-cedingai-prod --name bff-shared-secret --query value -o tsv)
IBK=$(az keyvault secret show --vault-name kv-cedingai-prod --name internal-bff-key --query value -o tsv)
echo "bff-shared-secret length: ${#BSS}   internal-bff-key length: ${#IBK}"   # sanity only

# 1b. Put the SAME values into prodai KV.
az keyvault secret set --vault-name kv-cedingai-prodai --name bff-shared-secret --value "$BSS" -o none
az keyvault secret set --vault-name kv-cedingai-prodai --name internal-bff-key  --value "$IBK" -o none
echo "prodai KV secrets set."

# 1c. Register those KV secrets as Container App secrets on the prodai BFF via its managed identity.
MI_ID=$(az containerapp show -n ca-cedingai-api-prodai -g rg-ceding-ai-prodai \
  --query "identity.userAssignedIdentities | keys(@)[0]" -o tsv)
echo "MI: $MI_ID"

az containerapp secret set -n ca-cedingai-api-prodai -g rg-ceding-ai-prodai \
  --secrets \
    bff-shared-secret=keyvaultref:https://kv-cedingai-prodai.vault.azure.net/secrets/bff-shared-secret,identityref:$MI_ID \
    internal-bff-key=keyvaultref:https://kv-cedingai-prodai.vault.azure.net/secrets/internal-bff-key,identityref:$MI_ID \
  -o none

# 1d. Add the env vars the BFF code reads, pointing at those secrets.
#     Names verified against 77b0c6d:
#       BFF_SHARED_SECRET       ← bff/config.py:19 (bff_shared_secret)
#       COLLEAGUE_BACKEND_API_KEY ← shared/config.py:73 (colleague_backend_api_key)
az containerapp update -n ca-cedingai-api-prodai -g rg-ceding-ai-prodai \
  --set-env-vars \
    BFF_SHARED_SECRET=secretref:bff-shared-secret \
    COLLEAGUE_BACKEND_API_KEY=secretref:internal-bff-key \
  -o none
echo "prodai BFF auth env wired."

# 1e. VERIFY.
az containerapp show -n ca-cedingai-api-prodai -g rg-ceding-ai-prodai \
  --query "properties.template.containers[0].env[?name=='BFF_SHARED_SECRET' || name=='COLLEAGUE_BACKEND_API_KEY']" -o table
az containerapp show -n ca-cedingai-api-prodai -g rg-ceding-ai-prodai --query "properties.runningStatus" -o tsv
```

> **Checkpoint:** Confirm both env vars present (secretRef) and app `Running`. Tail logs: `az containerapp logs show -n ca-cedingai-api-prodai -g rg-ceding-ai-prodai --tail 30`.

---

## STEP 2 — Copy the 16 document blobs into prodai storage

**Why:** Backend stores relative paths (`cases/…`); after cutover it + the workers resolve them against `stcedingaiprodai`. The 16 referenced blobs must exist there or the PDF viewer breaks and re-extraction fails.

**Reversible?** Yes — copying is additive.

```bash
az account set --subscription 1aa0ae2e-b817-4486-bdd2-d417a1aadea2

STG_KEY=$(az storage account keys list -g rg-ceding-ai-staging -n stcedingaistaging --query "[0].value" -o tsv)
PROD_KEY=$(az storage account keys list -g rg-ceding-ai-prod   -n stcedingaiprod   --query "[0].value" -o tsv)
PRODAI_KEY=$(az storage account keys list -g rg-ceding-ai-prodai -n stcedingaiprodai --query "[0].value" -o tsv)

EXPIRY=$(date -u -d "+2 hours" '+%Y-%m-%dT%H:%MZ')
STG_SAS=$(az storage container generate-sas --account-name stcedingaistaging --account-key "$STG_KEY" \
  --name ceding-documents --permissions rl --expiry "$EXPIRY" -o tsv)
PROD_SAS=$(az storage container generate-sas --account-name stcedingaiprod --account-key "$PROD_KEY" \
  --name ceding-documents --permissions rl --expiry "$EXPIRY" -o tsv)

# 2a. Save the 15 staging paths (Appendix A) to /tmp/staging_paths.txt (one per line), then:
while IFS= read -r P; do
  [ -z "$P" ] && continue
  echo "copy (staging): $P"
  az storage blob copy start \
    --account-name stcedingaiprodai --account-key "$PRODAI_KEY" \
    --destination-container ceding-documents --destination-blob "$P" \
    --source-uri "https://stcedingaistaging.blob.core.windows.net/ceding-documents/$P?$STG_SAS" \
    -o none
done < /tmp/staging_paths.txt

# 2b. The 1 blob in stcedingaiprod (ERROR status; optional).
P="cases/cmr0byymv000my462ms2t75v4/1782804943940-E18474998_unlocked (1).pdf"
az storage blob copy start \
  --account-name stcedingaiprodai --account-key "$PRODAI_KEY" \
  --destination-container ceding-documents --destination-blob "$P" \
  --source-uri "https://stcedingaiprod.blob.core.windows.net/ceding-documents/$P?$PROD_SAS" \
  -o none

# 2c. VERIFY.
az storage blob list --account-name stcedingaiprodai --account-key "$PRODAI_KEY" \
  --container-name ceding-documents --query "length(@)" -o tsv   # expect 16 (or 15)
```

> **Checkpoint:** count == 16 (or 15 if skipping ERROR one). Copies are async but small — complete in seconds. `ceding-ocr-cache` does NOT need migrating (new extractions re-OCR).

---

## STEP 3 — THE CUTOVER: flip the 2 backend env vars + storage key (atomic)

**Why:** The switch. Env vars + storage-account key change together in ONE update cycle so there's never a mismatched state.
**Reversible?** Yes — this is the rollback point.
**Have the rollback command ready in a second terminal before running.**

```bash
az account set --subscription 1aa0ae2e-b817-4486-bdd2-d417a1aadea2

# 3a. BEFORE the flip: capture the staging storage key so the second-terminal rollback has it.
STG_KEY_ROLLBACK=$(az storage account keys list -g rg-ceding-ai-staging -n stcedingaistaging --query "[0].value" -o tsv)
echo "staging storage key captured for rollback (length: ${#STG_KEY_ROLLBACK})"
# Keep this shell open OR export STG_KEY_ROLLBACK into the second terminal.

# 3b. THE FLIP — env vars.
az containerapp update -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
  --set-env-vars \
    BFF_BASE_URL="https://ca-cedingai-api-prodai.livelyflower-07874036.uksouth.azurecontainerapps.io" \
    AZURE_STORAGE_ACCOUNT_NAME="stcedingaiprodai" \
  -o none

# 3c. Update the backend's storage KEY secret to the prodai storage key.
PRODAI_KEY=$(az storage account keys list -g rg-ceding-ai-prodai -n stcedingaiprodai --query "[0].value" -o tsv)
az containerapp secret set -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
  --secrets azure-storage-account-key="$PRODAI_KEY" -o none

# 3d. VERIFY.
az containerapp show -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
  --query "{rev:properties.latestRevisionName, running:properties.runningStatus}" -o json
az containerapp show -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
  --query "properties.template.containers[0].env[?name=='BFF_BASE_URL' || name=='AZURE_STORAGE_ACCOUNT_NAME']" -o table
```

> **ROLLBACK (keep ready in a second terminal — with `STG_KEY_ROLLBACK` from Step 3a exported to that shell):**
> ```bash
> # 1. Env vars back to staging.
> az containerapp update -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
>   --set-env-vars \
>     BFF_BASE_URL="https://ca-cedingai-api-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io" \
>     AZURE_STORAGE_ACCOUNT_NAME="stcedingaistaging" -o none
>
> # 2. Storage key back to staging (uses STG_KEY_ROLLBACK captured in Step 3a).
> az containerapp secret set -n ca-cedingai-backend-prod -g rg-ceding-ai-prod \
>   --secrets azure-storage-account-key="$STG_KEY_ROLLBACK" -o none
> ```
> Both must run — env vars point at staging but the storage key must also match, or blob reads/writes fail.

---

## STEP 4 — Smoke test end-to-end (on the live app, gently)

1. **Health:** `curl -s https://ca-cedingai-backend-prod.ambitioushill-a2e27dbd.uksouth.azurecontainerapps.io/health` → 200.
2. **Login round-trip:** log into the prod UI, confirm SSO works (auth unchanged).
3. **Existing case PDF:** open one of the 10 copied cases (e.g. Glenn Hammonds, 5 docs) → PDF viewer loads (proves storage repoint + copy).
4. **New extraction:** upload a doc to a NEW test case → watch prodai pipeline:
   - `az containerapp logs show -n ca-cedingai-stage1-prodai -g rg-ceding-ai-prodai --tail 40`
   - Confirm a `case-extractions` doc lands in prodai Cosmos.
   - Confirm result returns to the UI.
5. **Confirm nothing hits staging** from the backend.

> If any step fails: roll back (Step 3), then diagnose in isolation. DB untouched + staging intact = always a safe fallback.

---

## STEP 5 — Rotate the exposed OpenAI key (security fix)

`AOAI_API_KEY` was found as PLAINTEXT (`ff40445…`) on prod/staging apps. Rotate + move to secretRef.

**First: verify which Azure OpenAI account the exposed key belongs to.** Based on the plaintext value's context (found referencing endpoints for both staging and prod OpenAI resources), the most likely owner is **`oai-cedingai-staging`** in **`rg-ceding-ai-staging`** — but confirm by matching the first 8 characters of the exposed key against the actual account keys:

```bash
az account set --subscription 1aa0ae2e-b817-4486-bdd2-d417a1aadea2

# Compare against each candidate account to find which one owns the exposed key.
for pair in "oai-cedingai-staging:rg-ceding-ai-staging" "oai-cedingai-prod:rg-ceding-ai-prod"; do
  ACCT="${pair%%:*}"; RG="${pair##*:}"
  KEY_PREFIX=$(az cognitiveservices account keys list -n "$ACCT" -g "$RG" --query "key1" -o tsv 2>/dev/null | head -c 8)
  echo "$ACCT: $KEY_PREFIX"
done
# Whichever account's KEY_PREFIX matches the exposed 'ff40445…' is the one to rotate.
```

Then rotate + update consumers:

```bash
# Replace <oai-account> / <its-rg> with the confirmed pair from above.
az cognitiveservices account keys regenerate -n <oai-account> -g <its-rg> --key-name Key1
# Read the new key.
NEW_KEY=$(az cognitiveservices account keys list -n <oai-account> -g <its-rg> --query "key1" -o tsv)

# Store it in KV, then repoint each consumer to a secretRef (not plaintext).
# The exact consumers depend on which account was rotated — check both:
#   • backend Container App env AZURE_OPENAI_API_KEY (if account is oai-cedingai-*)
#   • BFF/pipeline Container Apps env AOAI_API_KEY (if account is oai-cedingai-*)
az keyvault secret set --vault-name <right-kv> --name azure-openai-api-key --value "$NEW_KEY" -o none
# Then update every containerapp consumer via `az containerapp secret set` + `--set-env-vars … =secretref:…`.
```

> Treat the old key as compromised. Do regardless of the cutover; can be a separate small task, but don't leave it indefinitely. Do NOT leave the plaintext `AOAI_API_KEY=ff40445…` in any container app env after this step.

---

## STEP 6 — AFTER cutover is confirmed stable (separate, later)

- **Retire `rg-ceding-ai-prod-v2`** (Srinath's dead stack, no active revision). **Confirm with Srinath first.** Then `az group delete -n rg-ceding-ai-prod-v2`. Only after Option A is proven stable.
- **Clean up** the 8 orphaned blobs in `stcedingaiprod`; ~250 staging test blobs stay in staging.
- **Decide Phase 2 AI-layer home** — build a fresh dedicated layer for redesign (you know how; ~an afternoon).
- **Provider registry note:** 149 hand-curated providers live only in prod Postgres (no seed file). Preserved (DB untouched) — consider exporting a backup/seed for future recoverability.

---

## Appendix A — the 15 staging blob paths to copy (Step 2a)

Save to `/tmp/staging_paths.txt`, one per line (exact, including spaces):

```
cases/cmquok2yd004ldxoloc78msf7/1782823097134-Asset Charges.pdf
cases/cmquok2yd004ldxoloc78msf7/1782823097854-Cover Letter.pdf
cases/cmquok2yd004ldxoloc78msf7/1782823098221-Valuation.pdf
cases/cmqyvxsob004stmgngq0c8xr7/1782828886068-Job_942_314079925_7749379 2.pdf
cases/cmqz0yfgp0091tmgnf9hy0qws/1783581153435-Policy info people pension d wallace.pdf
cases/cmqz1fsdc009jdxolvgg77p8z/1782886682446-Diligenta Ltd Secure Messaging Glenn Hammond.pdf
cases/cmqz1fsdc009jdxolvgg77p8z/1782886683158-Investment Report January 2026 (1) Z0100292 Glenn Hammonds.pdf
cases/cmqz1fsdc009jdxolvgg77p8z/1782886683738-Policy Information Scottish Widows Pension Z0100292 Glenn Hammonds.pdf
cases/cmqz1fsdc009jdxolvgg77p8z/1782887170886-Post A Day Group Pensionbuilder Factsheet (1).pdf
cases/cmqz1fsdc009jdxolvgg77p8z/1783927230457-Z0100292 protected tax free cash confirmation Glenn Hammonds.pdf
cases/cmqzh9c160001l4rozexpcr7f/1783601364010-Policy Information Cover Letter_Nicholas.pdf
cases/cmr0hx7tc002xl4roku756nng/1782828977272-Job_942_314079925_7749379 2.pdf
cases/cmr1znucp00dmxetl48e59jou/1782992744625-Cedinf Policyinfo Pension 8571846UN AVIVA Suzanne.pdf
cases/cmrejqb0f01jdmjhivnjtoxrm/1783664639916-2659394001 - Lorenson - Letter Of Authority (Loa) Pack - 09062026.pdf
cases/cmritrj9901sxmjhi8k4ibqki/1783923181077-7468352 - C Lorenson Info.pdf
```

The 1 from `stcedingaiprod` (Step 2b, optional — ERROR status):
```
cases/cmr0byymv000my462ms2t75v4/1782804943940-E18474998_unlocked (1).pdf
```

---

## Pre-flight checklist

- [ ] Fresh session, calm, unhurried.
- [ ] Rollback values confirmed still current (`az containerapp show` backend env first).
- [ ] Second terminal open with Step 3 rollback command ready, `STG_KEY_ROLLBACK` exported to it.
- [ ] BFF env var names verified against the 77b0c6d image source (Step 1d — confirmed at time of writing as `BFF_SHARED_SECRET` + `COLLEAGUE_BACKEND_API_KEY`; re-verify if the BFF image tag changes).
- [ ] Low-traffic window (backend has real users; the flip cycles a revision).
- [ ] Optionally: Rev aware you're doing the live cutover.

---

## Safety model (one line)

The **database is never touched**; the **cutover is 2 env vars + a secret** (instantly reversible); **staging stays fully intact** as fallback. Worst case at any step = flip the env vars back + restore the staging storage key, zero data loss.
