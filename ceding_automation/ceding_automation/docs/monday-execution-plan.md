# Monday Execution Plan — BFF Integration

> Created 2026-05-22 (Friday night) after compatibility investigation
> revealed 11 mismatches between ceding_automation backend and
> ceding-ai-pipeline BFF. This file locks in the 9 decisions and
> orders Monday's work.
>
> Branch: feature/ai-bff-integration
> UAT: Tuesday 2026-05-26
> Author: Nishant R

---

## 9 Locked Decisions (verified by both repos)

### D1 — Naming compatibility
**Backend changes aiBffClient.ts to serialize snake_case** when calling
the BFF. BFF stays Pydantic strict, no alias support added.

### D2 — Plan type vocabulary
**BFF adds @field_validator("plan_type", mode="before")** that uppercases
the value before the Literal check. Also confirm BFF Literal includes
FINAL_SALARY and PROTECTION if backend's PlanType enum will send those
(Phase 2 — probably out of scope for v1).

### D3 — field_id resolution (Option B)
**Backend route /ai-extract accepts field_key as the URL param**, looks
up the field via `findFirst({ where: { caseId, template: { fieldKey } } })`.
Existing manual-edit endpoint stays UUID-based. BFF doesn't change its
URL construction beyond adding the /ai-extract suffix.

### D4 — job_id length
**Backend regex widens to /^bff-[0-9a-f]{8,16}$/**. BFF's current
12-char generation stays as-is. Existing Cosmos data preserved.

### D5 — Stage 4 output naming
**write_back_service maps Stage 4 fields to backend schema**:
- `key` → `field_key` (URL param AND body field)
- `evidence_quote` → `source_quote`
- Other fields pass through unchanged. Stage 4 output stays as the
source of truth in Cosmos.

### D6 — Storage container (verify, not decide)
**Task #1 Monday morning**: verify backend's storage.ts uploads to
`stcedingaistaging / ceding-documents` (where BFF can read via
managed identity). If different, alignment work blocks everything
else.

### D7 — raw_value and document_id
**BFF write-back includes both**: document_id from extraction context
(already known), raw_value as null for now (Phase 2 enhancement to
capture pre-normalisation).

### D8 — Document write-back vocabulary
**BFF sends BFF job vocab to backend**: status="completed" (not
"EXTRACTED"). Includes rich payload: job_id, stage="done",
progress_pct=100, completed_at, page_count, detected_provider,
detected_plan_type, llm_call_meta (for cost/tokens tracking from
Friday's design Decision 4).

### D9 — Bug fix (not a design decision)
**Fix write_back_service.py:39**: field.get("field_key") → field.get("key").
Stage 4 outputs "key" not "field_key". Has been broken since Slot 2
was written; never caught because never tested end-to-end.

---

## Monday Execution Order

Total estimate: 10-11 hours. Start 7am if possible.

### Phase 1: Gate check (15 min)
- [ ] **T1**: Verify storage container alignment. Read backend's storage.ts.
  Confirm uploads target `stcedingaistaging / ceding-documents`. If
  different — STOP and align before any other work.

### Phase 2: Backend changes (~2.5 hours)
- [ ] **T2**: Backend aiBffClient.ts → serialize snake_case for outbound BFF calls (1h)
- [ ] **T3**: Backend route /ai-extract → accept field_key as URL param,
  findFirst by (caseId, template.fieldKey) (1h)
- [ ] **T4**: Backend Zod regex for job_id → /^bff-[0-9a-f]{8,16}$/ (15m)
- [ ] **T5**: Backend tsc clean, commit, push (15m)

### Phase 3: BFF changes (~2 hours)
- [ ] **T6**: BFF @field_validator for plan_type uppercase (15m)
- [ ] **T7**: BFF write_back_service.py bug fix: field.get("key") (5m)
- [ ] **T8**: BFF colleague_backend_client.py rewrite — URL with /ai-extract,
  9 snake_case body fields, X-Internal-Key header (45m)
- [ ] **T9**: BFF write_back_service.py — map Stage 4 key→field_key,
  evidence_quote→source_quote; add rich doc write-back with all metadata (30m)
- [ ] **T10**: BFF tests updated (~8 tests), pytest passes (15m)
- [ ] **T11**: BFF commit + push (5m)

### Phase 4: Deploy BFF (~30 min)
- [ ] **T12**: docker build + push to crcedingaistaging.azurecr.io with new
  commit hash (15m)
- [ ] **T13**: az containerapp update ca-cedingai-api-staging to new image (10m)
- [ ] **T14**: Verify BFF logs clean on startup (5m)

### Phase 5: Deploy backend (~1.5 hours)
- [ ] **T15**: Create Azure Database for PostgreSQL Flexible Server
  (Burstable B1ms) in rg-ceding-ai-staging (20m)
- [ ] **T16**: Build backend Docker image, push to ACR (20m)
- [ ] **T17**: Create backend Container App in rg-ceding-ai-staging (15m)
- [ ] **T18**: Configure backend env vars: DB connection, BFF_BASE_URL,
  BFF_SHARED_SECRET, INTERNAL_BFF_KEY from Key Vault, AI_VIA_BFF=false
  initially (20m)
- [ ] **T19**: Run prisma migrate deploy against staging DB (10m)
- [ ] **T20**: Smoke test backend boot + health check (5m)

### Phase 6: Wire secrets (~15 min)
- [ ] **T21**: Generate one shared secret: `openssl rand -hex 32` (1m)
- [ ] **T22**: Store in kv-cedingai-staging as `ai-internal-key` (2m)
- [ ] **T23**: Configure backend to read it as INTERNAL_BFF_KEY env var (5m)
- [ ] **T24**: Configure BFF to read it as COLLEAGUE_BACKEND_API_KEY env var (5m)
- [ ] **T25**: Set COLLEAGUE_BACKEND_URL on BFF to deployed backend URL (2m)

### Phase 7: First end-to-end test (~1 hour)
- [ ] **T26**: Flip AI_VIA_BFF=true on backend, restart (5m)
- [ ] **T27**: Upload one Aviva PDF via API (skip frontend for now) (5m)
- [ ] **T28**: Watch BFF submit, Stage 4 complete, write-backs land (50m for
  the full chain plus debugging)

### Phase 8: Fix what breaks (1-2 hours buffer)
- [ ] **T29**: Whatever the test reveals

### Phase 9: Frontend deploy (~45 min)
- [ ] **T30**: Deploy frontend to Static Web Apps in rg-ceding-ai-staging
- [ ] **T31**: Configure auth, point at backend URL
- [ ] **T32**: Smoke test through UI

### Phase 10: UAT prep (~30 min)
- [ ] **T33**: Run the 6 smoke tests from docs/ai-integration-design.md §9.5
- [ ] **T34**: Brief Stuart, Nat, Dale on what to test
- [ ] **T35**: Document any known issues for them

---

## Risks to UAT Tuesday

1. **Storage container mismatch (T1)** — gates everything. 5 min to check,
   could be 2 hours to fix if mismatched.
2. **First-time Azure deploy of backend** — usually slower than estimated.
   Padding to 1.5h is generous but realistic.
3. **End-to-end test will reveal something** — always does. The 1-2 hour
   buffer is for that.

If running short on time Monday, defer in this order:
- Frontend deploy → Tuesday morning before UAT (can demo with curl)
- Rich document write-back metadata → cost tracking, not user-facing
- Phase 2 stuff (raw_value, FINAL_SALARY/PROTECTION) → after UAT

If running CRITICALLY short, communicate with team Sunday/Monday morning:
"UAT shifts from Tuesday morning to Tuesday afternoon" — better than
firefighting at 9am Tuesday.

---

## Status

- Backend code: ✅ committed (5 commits on feature/ai-bff-integration)
- Backend code review: ✅ tsc clean, type-checked, push'd
- BFF code: ⏳ Monday changes needed per D5-D9
- BFF deployed: ⏳ Monday redeploy after changes
- Backend deployed: ⏳ Monday first deploy
- Frontend deployed: ⏳ Monday or Tuesday morning
- Database: ⏳ Monday creation + migration
- End-to-end tested: ⏳ Monday afternoon
- UAT ready: ⏳ Tuesday morning (or afternoon if Monday runs long)

End of plan.
