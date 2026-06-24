// backend/src/routes/export.ts
// Stage 9 "Complete export" — one-shot endpoint that:
//   1. Receives the XLSX workbook the CA generated client-side.
//   2. Uploads it to Zoho WorkDrive (same folder as RC recordings unless
//      ZOHO_WORKDRIVE_FOLDER_ID is overridden).
//   3. PATCHes the linked Plans-module record in Zoho CRM with the field
//      values that should now be authoritative.
//   4. Returns combined metadata so the frontend can show one toast and
//      stamp the audit trail.
import { Router, Request, Response } from "express";
import multer from "multer";
import { PrismaClient, Prisma } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/auth";
import { uploadToWorkDrive, resolveCaseFolderId, WorkDriveFolderResolutionError } from "../services/workdrive";
import {
  updatePlanRecord,
  findPlanRecordByPolicyRef,
  findProviderRecordByName,
  mapPlanTypeToZoho,
  planProviderField,
} from "../services/zohoCrm";

const router = Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage() });

// ── Mapping helpers ─────────────────────────────────────────
// Verified against the live Plans custom module — field API names and
// data types are taken from `CustomModule46` in the Zoho CRM admin UI.

// Yes/No / true/false / 1/0 → boolean. Returns undefined if unparseable
// so we don't accidentally PATCH a Boolean field with "Test Yes" garbage.
function parseBool(s: string | null | undefined): boolean | undefined {
  if (!s) return undefined;
  const v = String(s).trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["no", "n", "false", "0"].includes(v)) return false;
  return undefined;
}

// "£127,450.32" / "127,450.32" / "127450.32" → 127450.32. Strips currency
// symbols, commas, percent signs, and anything else non-numeric.
function parseNumeric(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const cleaned = String(s).replace(/[^0-9.\-]/g, "");
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

// Accept "01/01/2025", "2025-01-01", "1 Jan 2025" → "2025-01-01" (ISO).
// Zoho Date fields want YYYY-MM-DD; Date-Time wants full ISO.
function parseDateISO(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const trimmed = String(s).trim();
  // DD/MM/YYYY → swap to ISO
  const ukMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ukMatch) return `${ukMatch[3]}-${ukMatch[2]}-${ukMatch[1]}`;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

// Shared helper for PlanType → Zoho pick-list mapping lives in
// services/zohoCrm.ts as mapPlanTypeToZoho (also consumed by the
// D4 "Create new in Zoho" flow). Re-exported alias kept local-only.
const mapPlanTypePicklist = mapPlanTypeToZoho;

// Build the Zoho Plans-module payload. Anything we don't have a usable
// value for is omitted so we don't overwrite real CRM data with blanks.
// Field types and API names verified against CustomModule46.
function buildPlanFields(
  caseRecord: {
    planType: string;
    policyRef: string | null;
    planStartDate: Date | null;
    // Cached at sync time; consumed verbatim here.
    zohoOwnerId: string | null;
    zohoClientOwnerIds: string[];
    zohoParaplannerId: string | null;
    zohoProviderRecordId: string | null;
  },
  fieldsByKey: Map<string, { value: string | null }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const setIf = (key: string, value: unknown) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" && value.trim() === "") return;
    out[key] = value;
  };

  // ─ User lookups: use the IDs we cached at sync time ─
  // Plans.Client_Owners is intentionally NOT sent. The Multi-Select
  // Lookup keeps rejecting our cached IDs ("the id given seems to be
  // invalid"), and the field is managed on the Contact record anyway —
  // CRM workflows can copy it down to Plans on their side. Re-enable
  // here once we know what module the field actually points at.
  if (caseRecord.zohoOwnerId) {
    setIf("Owner", { id: caseRecord.zohoOwnerId });
  }

  // ─ Provider lookup (custom Providers module) ─
  // Field API name is configurable (ZOHO_PLAN_PROVIDER_FIELD) — if Provider
  // keeps not landing despite a populated id, the field name is the suspect.
  if (caseRecord.zohoProviderRecordId) {
    setIf(planProviderField(), { id: caseRecord.zohoProviderRecordId });
  }

  // ─ Simple scalars ─
  setIf("Plan_Type", mapPlanTypePicklist(caseRecord.planType));    // Pick list
  setIf("Policy_Ref", caseRecord.policyRef);                       // Single Line
  if (caseRecord.planStartDate) {
    setIf("Plan_Start_Date", caseRecord.planStartDate.toISOString().slice(0, 10));
  }

  // ─ Hard-coded business-rule defaults (D6) ─
  // Both fields are fixed values per Furnley House process — they are no
  // longer surfaced on the checklist for new cases (canonical JSON has no
  // entry for either key), and the export must always push these regardless
  // of any stale checklist value left on legacy cases.
  out["Non_Advised"] = true;
  out["Plan_Status"] = "In Force";

  // ─ Checklist-derived ─ keys match field_keys used elsewhere in the app
  setIf("Crystallisation_Status", fieldsByKey.get("crystallisation_status")?.value); // Pick list
  setIf("Valuation", parseNumeric(fieldsByKey.get("current_value")?.value));  // Currency
  setIf("Valuation_Date", parseDateISO(fieldsByKey.get("valuation_date")?.value)); // Date
  setIf("Normal_Retirement_Age", parseNumeric(fieldsByKey.get("normal_retirement_age")?.value)); // Number

  return out;
}

// ── Endpoint ────────────────────────────────────────────────
router.post(
  "/:id/complete-export",
  requireAuth,
  requireRole(["CA_TEAM", "ADMIN", "PARAPLANNER", "ADVISER"]),
  upload.single("file"),
  async (req: Request, res: Response) => {
    const caseId = req.params.id;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected multipart 'file')" });
    }

    const caseRecord = await prisma.case.findUnique({
      where: { id: caseId },
      include: {
        provider: { select: { name: true } },
        checklistFields: {
          include: { template: { select: { fieldKey: true } } },
        },
      },
    });
    if (!caseRecord) return res.status(404).json({ error: "Case not found" });

    const fieldsByKey = new Map<string, { value: string | null }>();
    for (const f of caseRecord.checklistFields) {
      fieldsByKey.set(f.template.fieldKey, { value: f.value });
    }

    // Production model: all Zoho IDs were already cached on the case at
    // last sync. The export does NOT re-fetch from CRM. If the cache is
    // empty, the CA should click "Refresh from Zoho" first — that's the
    // single integration point with CRM-side reads.
    const cacheEmpty =
      !caseRecord.zohoOwnerId &&
      caseRecord.zohoClientOwnerIds.length === 0 &&
      !caseRecord.zohoParaplannerId &&
      !caseRecord.zohoProviderRecordId;
    const cacheWarning = cacheEmpty
      ? "Zoho ID cache is empty — click 'Refresh from Zoho' on the case header to sync before export."
      : null;

    // ── 1. WorkDrive upload ──────────────────────────────
    // Folder is resolved per-client from Contact.Client_Record_Folder_ID
    // (each client has their own WorkDrive folder, populated on the CRM
    // Contact by Zoho workflows). Hard-fail with 422 if the field is empty
    // so the CA fixes the data in Zoho rather than dumping the export into
    // a shared folder.
    const fileName =
      (req.body?.fileName as string | undefined) ??
      req.file.originalname ??
      `${caseRecord.caseRef}_ceding.xlsx`;

    let workdrive: {
      id: string;
      permalink?: string;
      name: string;
      folderId: string;
    } | null = null;
    let workdriveError: string | null = null;

    let resolvedFolderId: string | null = null;
    try {
      const resolved = await resolveCaseFolderId(caseRecord.clientZohoId);
      resolvedFolderId = resolved.folderId;
    } catch (err) {
      if (err instanceof WorkDriveFolderResolutionError) {
        return res.status(422).json({
          error: "WorkDrive folder not resolvable",
          code: err.code,
          contactZohoId: err.contactZohoId,
          message: err.message,
        });
      }
      throw err;
    }

    try {
      const result = await uploadToWorkDrive(
        req.file.buffer,
        fileName,
        resolvedFolderId,
        req.file.mimetype || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      workdrive = {
        id: result.id,
        permalink: result.permalink,
        name: result.name,
        folderId: resolvedFolderId,
      };
    } catch (err) {
      workdriveError = err instanceof Error ? err.message : String(err);
    }

    // ── 2. Zoho Plans-module update ───────────────────────
    let zohoUpdate: {
      ok: boolean;
      fieldsUpdated: number;
      recordId?: string;
      planName?: string;
      resolvedVia?: "stored" | "policy_ref_search";
      // Captured for the receipt panel so testers can verify what landed
      // in Zoho field-by-field, not just the count. Same shape as the
      // payload passed to updatePlanRecord — Lookup fields appear as
      // { id: "..." }.
      fields?: Record<string, unknown>;
    } = { ok: false, fieldsUpdated: 0 };
    let zohoError: string | null = null;

    // 2a. Resolve which Plans record to update.
    //   Fast path: case.zohoCaseId (captured from Zoho Task.What_Id at import).
    //   Fallback: search the Plans module by Policy_Ref. Cache the result
    //   back to the case so we don't search on every export.
    let planRecordId = caseRecord.zohoCaseId;
    // Plan.Name from the resolved Zoho record — surfaced on the receipt
    // panel + header so testers can verify which record we touched without
    // opening Zoho. Only populated when the export route itself resolved
    // the record (the search hit returned the record); for cases where
    // zohoCaseId was already cached, we leave it undefined and the
    // receipt falls back to "Plan <id>".
    let planRecordName: string | undefined;
    let resolvedVia: "stored" | "policy_ref_search" | null = planRecordId ? "stored" : null;
    if (!planRecordId && caseRecord.policyRef) {
      try {
        const hit = await findPlanRecordByPolicyRef(caseRecord.policyRef);
        if (hit) {
          planRecordId = hit.id;
          resolvedVia = "policy_ref_search";
          // Capture Plan Name from the record body — used purely for display.
          const recName = (hit.record as Record<string, unknown>).Name;
          if (typeof recName === "string" && recName.trim()) planRecordName = recName.trim();
          // Persist so subsequent exports skip the search. Also cache the
          // Plan Name on the case row so the header / receipt panel can
          // show "<Plan Name> (<Policy Ref>)" without another Zoho hit.
          await prisma.case.update({
            where: { id: caseId },
            data: {
              zohoCaseId: hit.id,
              ...(planRecordName ? { zohoPlanName: planRecordName } : {}),
            },
          });
        }
      } catch (err) {
        zohoError = `Plans search by Policy_Ref failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 2b. PATCH the record if we have an id.
    if (!planRecordId && !zohoError) {
      zohoError = caseRecord.policyRef
        ? `No Plans record found with Policy_Ref="${caseRecord.policyRef}". Either create the record in CRM first or set zohoCaseId on the case manually.`
        : "Case has no policyRef and no zohoCaseId — nothing to match against.";
    } else if (planRecordId) {
      // Provider fallback (L3.1 fix). The sync caches zohoProviderRecordId, but
      // findProviderRecordByName returns null on any name mismatch / missing
      // Providers record, so the cache is frequently empty and Provider then
      // silently never lands on the Plans record. Resolve live here as a
      // fallback and persist it, so Provider gets sent even when sync couldn't
      // cache it (and future exports skip the search).
      if (!caseRecord.zohoProviderRecordId && caseRecord.provider?.name) {
        try {
          const hit = await findProviderRecordByName(caseRecord.provider.name);
          if (hit) {
            caseRecord.zohoProviderRecordId = hit.id;
            await prisma.case.update({
              where: { id: caseId },
              data: { zohoProviderRecordId: hit.id },
            });
            console.log(
              "[plan-provider] export resolved provider live case=%s name=%s -> %s",
              caseId, caseRecord.provider.name, hit.id,
            );
          } else {
            console.warn(
              "[plan-provider] export could NOT resolve provider case=%s name=%s (no unique Providers record)",
              caseId, caseRecord.provider.name,
            );
          }
        } catch (err) {
          console.warn(
            "[plan-provider] export provider resolution failed case=%s: %s",
            caseId, err instanceof Error ? err.message : String(err),
          );
        }
      }

      const fields = buildPlanFields(caseRecord, fieldsByKey);
      // Diagnostic logging (survives — this bug class recurs). Shows whether
      // Provider made it into the payload at all.
      console.log(
        "[plan-provider] case=%s policyRef=%s cachedProviderId=%s payloadSent=%s",
        caseId,
        caseRecord.policyRef,
        caseRecord.zohoProviderRecordId,
        JSON.stringify(fields[planProviderField()] ?? null),
      );
      if (Object.keys(fields).length === 0) {
        zohoError = "No fields to update — checklist values are empty.";
      } else {
        try {
          const resp = await updatePlanRecord(planRecordId, fields);
          // Log the post-write response shape so we can see whether Zoho
          // accepted Provider (vs silently ignoring an unknown field name).
          console.log(
            "[plan-provider] updatePlanRecord ok case=%s record=%s respKeys=%s",
            caseId,
            planRecordId,
            JSON.stringify(Object.keys((resp as { data?: unknown[] })?.data?.[0] ?? resp ?? {})),
          );
          zohoUpdate = {
            ok: true,
            fieldsUpdated: Object.keys(fields).length,
            recordId: planRecordId,
            planName: planRecordName,
            resolvedVia: resolvedVia ?? undefined,
            fields,
          };
        } catch (err) {
          zohoError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // ── 3. Audit log ──────────────────────────────────────
    await prisma.auditLog.create({
      data: {
        caseId,
        userId: req.user!.id,
        action: "CHECKLIST_EXPORTED",
        source: "MANUAL",
        newValue: `Complete export: workdrive=${workdrive ? "ok" : "fail"}, zoho=${zohoUpdate.ok ? "ok" : "fail"}`,
        metadata: {
          fileName,
          workdrive,
          workdriveError,
          zohoUpdate,
          zohoError,
          cacheWarning,
          cachedZohoIds: {
            zohoOwnerId: caseRecord.zohoOwnerId,
            zohoClientOwnerIds: caseRecord.zohoClientOwnerIds,
            zohoParaplannerId: caseRecord.zohoParaplannerId,
            zohoProviderRecordId: caseRecord.zohoProviderRecordId,
            zohoSyncedAt: caseRecord.zohoSyncedAt,
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });

    res.json({
      fileName,
      workdrive,
      workdriveError,
      zohoUpdate,
      zohoError,
      cacheWarning,
      cachedZohoIds: {
        zohoOwnerId: caseRecord.zohoOwnerId,
        zohoClientOwnerIds: caseRecord.zohoClientOwnerIds,
        zohoParaplannerId: caseRecord.zohoParaplannerId,
        zohoProviderRecordId: caseRecord.zohoProviderRecordId,
        zohoSyncedAt: caseRecord.zohoSyncedAt,
      },
      exportedAt: new Date().toISOString(),
    });
  },
);

export { router as exportRoutes };
