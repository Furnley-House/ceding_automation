# Staging Deploy Checklist

**Migrations ALWAYS apply BEFORE the image rolls. Never roll an image whose code expects a schema the DB doesn't have.**

## Why this exists

Three production-style incidents in two days, all the same root cause:

- **2026-06-15** — Srinath's `376f119` added 7 `rc*` columns to the `User` model in `schema.prisma` but no migration file. New image expected the columns; staging DB didn't have them. Every `prisma.user.findUnique()` crashed with `P2022`, killing the Node process in a restart loop. UAT down.
- **2026-06-16 (morning)** — Reva's `ab323ca` + `4d44ab4` added new `LOAStatus` enum values and split LOA fields into per-method columns. Migrations existed in the repo but were never applied to staging. We rebuilt the image (for the unrelated S0 observability change); the new image's Prisma client referenced `cases.loaOrigoRef`; staging DB didn't have it; UAT down again.
- **2026-06-16 (rollback window)** — Rolled back to a pre-Reva image to recover UAT. That worked for 21 minutes, until the migration that *was* eventually applied to fix the forward path *dropped* the old `loaNotes` and `loaTrackingRef` columns — at which point the rolled-back image started crashing with `P2022` on `cases.loaNotes`. UAT down a third time.

All three were preventable. The fix is procedural, not technical: apply pending migrations before rolling the image.

## The sequence (every staging deploy, no exceptions)

### 1. Sync the repo

```powershell
git fetch origin
git pull --ff-only origin develop   # or pull --rebase if you have local commits
```

Confirm `git status` shows up-to-date with `origin/develop` and a clean working tree (untracked-only items in `.claude/`, `*.local-bak`, `dist*` are fine).

### 2. Run the pre-deploy migration scan

```bash
./scripts/predeploy-check.sh
```

Lists every migration directory under `prisma/migrations/` and flags each as either **additive (safe)** or **DESTRUCTIVE (audit before applying)**. This is offline — no DB connection, no firewall changes. It tells you what's in the repo, not what's been applied to staging.

### 3. Compare repo migrations vs staging's applied set

Open the firewall (see step 5 for the ceremony) just long enough to run:

```powershell
cd backend
$env:DATABASE_URL = (az keyvault secret show --vault-name kv-cedingai-staging --name DATABASE-URL --query value -o tsv)
npx prisma migrate status
Remove-Item Env:DATABASE_URL
```

Look for the `Following migrations have not yet been applied` block. Cross-reference with step 2's destructive-vs-additive labels.

### 4. Read every pending migration's SQL

For each migration listed by `migrate status` but not yet applied:

- **Purely additive** (`ALTER TABLE ... ADD COLUMN <nullable>`, `ALTER TYPE ... ADD VALUE`): safe to apply immediately. Existing rows are unaffected; no backfill needed.
- **Destructive** (`DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN`, `RENAME`, `DELETE FROM`, `UPDATE ... SET`, `TRUNCATE`): **AUDIT FIRST.** Construct a row-count query proving no data loss before applying. The 2026-06-16 LOA migration audit is the reference template:

  ```sql
  SELECT
    COUNT(*)                                                                  AS total_rows,
    COUNT("loaNotes")                                                         AS rows_with_notes,
    COUNT("loaTrackingRef")                                                   AS rows_with_ref,
    COUNT(*) FILTER (WHERE "loaMethod" NOT IN ('origo','email','courier')
                     AND "loaMethod" IS NOT NULL)                             AS unexpected_method_rows,
    COUNT(*) FILTER (WHERE "loaMethod" IS NULL AND "loaTrackingRef" IS NOT NULL) AS null_method_with_ref_rows
  FROM "cases";
  ```

  Adapt the columns and predicates to match the destructive migration's WHERE clauses. If the audit shows zero rows at risk → safe to apply. If non-zero → STOP and clarify with the migration's author what should happen to those rows.

### 5. Apply migrations via the firewall ceremony

Pattern that has been used repeatedly without incident:

```bash
# Capture pre-migrate UTC for PITR target (if rollback is ever needed)
PRE_MIGRATE_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "PRE_MIGRATE_UTC=$PRE_MIGRATE_UTC"

# Verify your public IP — it rotates on most consumer connections
MY_IP=$(curl -s https://api.ipify.org)
echo "MY_IP=$MY_IP"

# Open scope to your current IP only
az postgres flexible-server firewall-rule create \
  -n pg-cedingai-staging -g rg-ceding-ai-staging \
  --rule-name "$(whoami)-migrate-temp-$(date +%Y%m%d-%H%M)" \
  --start-ip-address "$MY_IP" --end-ip-address "$MY_IP"

# Wait ~15-20s for propagation
sleep 20

# Apply
cd backend
DATABASE_URL=$(az keyvault secret show --vault-name kv-cedingai-staging --name DATABASE-URL --query value -o tsv) \
  npx prisma migrate deploy

# Verify "Database schema is up to date!" + spot-check the new columns
DATABASE_URL=$(az keyvault secret show --vault-name kv-cedingai-staging --name DATABASE-URL --query value -o tsv) \
  npx prisma migrate status

# DELETE the firewall rule, ALWAYS, success or failure
az postgres flexible-server firewall-rule delete \
  -n pg-cedingai-staging -g rg-ceding-ai-staging \
  --rule-name "$(whoami)-migrate-temp-..."   # use the exact name from create
```

### 6. THEN build + roll the image

Only after step 5 confirms the staging DB schema matches what the new image expects:

```bash
NEW_SHA=$(git rev-parse --short HEAD)
az acr build -t "ceding-backend:$NEW_SHA" -t "ceding-backend:latest" \
  -r crcedingaistaging backend
# (cp1252 crash in the local az CLI is expected on the build's prisma generate
#  step — verify success by querying the ACR tag, not the local exit code)

az acr repository show-tags -n crcedingaistaging --repository ceding-backend \
  --query "[?@=='$NEW_SHA']" -o tsv   # confirm tag landed

az containerapp update -n ca-cedingai-backend-staging -g rg-ceding-ai-staging \
  --image "crcedingaistaging.azurecr.io/ceding-backend:$NEW_SHA"
```

### 7. Verify the deploy

- Poll revision health until `Healthy` + `traffic: 100`:
  ```bash
  az containerapp revision list -n ca-cedingai-backend-staging -g rg-ceding-ai-staging \
    --query "[?properties.active].{name:name, health:properties.healthState, traffic:properties.trafficWeight}" -o table
  ```
- `curl /health` returns HTTP 200.
- Scan Log Analytics for `P2022`, `PrismaClient`, `error` patterns on the new revision in a ~5 minute window. Zero is the only acceptable count.
- Behaviour check: if the deploy changed user-facing behaviour, exercise it end-to-end on staging.

## Lessons baked in (the why behind the rules)

- **Rollback to an old image is only safe across an ADDITIVE migration.** A destructive migration (column drop, type change, rename) breaks the OLD image's compiled Prisma client too, because that client still expects the dropped/renamed column. For destructive migrations, do not roll back; fix forward — the forward-compatible new image heals automatically once the columns exist.
- **Your public IP rotates** (mobile broadband, ISP NAT, VPN rolls). Always re-check with `curl https://api.ipify.org` immediately before creating the firewall rule. The IP you used yesterday is probably not the IP you have now.
- **Verify against Azure ground truth, not transcripts or assumptions.** `az containerapp show ... --query ".../image"`, `az acr repository show-tags`, `prisma migrate status` against staging — these are sources of truth. Conversation history and design docs are not.
- **The local `az` CLI crashes with `UnicodeEncodeError: 'charmap' codec` (cp1252)** on emoji glyphs in build streams (`✔` checkmark, `\U0001f680` rocket). The build itself succeeds server-side. Always verify ACR tag presence rather than trusting the local exit code.
- **Container Apps single-revision mode auto-deactivates the previous revision** as soon as the new one is Healthy. Instant traffic-shift rollback is NOT available after that — your only rollback is to deploy the old image as a NEW revision, which takes ~30-60s and still depends on the schema being compatible (see first lesson).

## When the checklist does not apply

- Pure code change with no schema diff (e.g. S0 logging-only, copy tweaks, env-var-only changes): skip steps 3-5; just steps 1, 2, 6, 7. The pre-deploy scanner at step 2 will confirm there are no pending migrations to worry about.
- Migration applied to staging by someone else already: still run `prisma migrate status` (step 3) to confirm. Don't assume.
