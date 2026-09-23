// backend/src/services/caseFieldMirror.ts
// Propagate checklist-field changes back to the corresponding columns on
// the Case row, so the header / cases list / dashboard reflect what the
// AI extracted (or the CA team manually entered).
//
// The checklist is the source of truth for these values — case columns
// are just cached projections we keep in sync.
//
// Currently mirrored:
//   provider_name → Case.providerId    (fill-when-empty, sticky operator pick)
//   plan_number   → Case.policyRef     (always mirror when called — BUT the
//                                       AI merge caller in aiBffApply skips
//                                       this fieldKey entirely, so only
//                                       manual CA paths propagate. See
//                                       services/aiBffApply.ts and the
//                                       inline comment in the plan_number
//                                       branch below for the reasoning.)
//   start_date    → Case.planStartDate (always overwrite on difference)
//
// Called from:
//   - applyFieldExtraction (AI write-back, both poller + PATCH path)
//   - PATCH /cases/:id/checklist/:fieldId  (manual edit)
//   - POST  /cases/:id/checklist/seed       (seed with value)
//   - POST  /cases/:id/checklist/fill-test-data
//
// Fail-soft: any error here is logged and swallowed — checklist write
// already succeeded, we don't want to fail the caller just because a
// projection couldn't be updated.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// DD/MM/YYYY or ISO → Date. Returns null if unparseable.
function parseDate(raw: string): Date | null {
  const trimmed = raw.trim();
  const ukMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ukMatch) {
    const iso = `${ukMatch[3]}-${ukMatch[2]}-${ukMatch[1]}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Upsert a Provider record by name (case-insensitive). Returns its id.
// If the case is currently linked to a different provider, we don't delete
// the old one — providers are shared across cases.
async function upsertProviderByName(name: string): Promise<string> {
  const trimmed = name.trim();
  const existing = await prisma.provider.findFirst({
    where: { name: { equals: trimmed, mode: "insensitive" } },
  });
  if (existing) return existing.id;
  const created = await prisma.provider.create({
    data: { name: trimmed },
  });
  return created.id;
}

/**
 * Sync the relevant Case column from a single checklist field change.
 * No-op for fields that aren't mirrored. Idempotent — re-running with
 * the same value won't generate spurious writes (we read the current
 * column first and skip if equal).
 */
export async function mirrorChecklistToCase(
  caseId: string,
  fieldKey: string,
  value: string | null,
): Promise<{ changed: boolean; column?: string }> {
  if (!value || !value.trim()) {
    return { changed: false };
  }

  try {
    const caseRow = await prisma.case.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        policyRef: true,
        planStartDate: true,
        providerId: true,
        provider: { select: { name: true } },
      },
    });
    if (!caseRow) return { changed: false };

    switch (fieldKey) {
      case "provider_name": {
        const trimmed = value.trim();
        // Sticky operator pick (Fix 2): the case-level provider link is
        // operator-owned via the Stage 2 picker. The checklist provider_name
        // field still records what the document said, but the case link no
        // longer follows it. First-time population still works because newly
        // created cases without a provider start with providerId === null.
        if (caseRow.providerId !== null) return { changed: false };
        // Already linked to a provider with this name? skip.
        if (
          caseRow.provider?.name?.toLowerCase() === trimmed.toLowerCase()
        ) {
          return { changed: false };
        }
        const providerId = await upsertProviderByName(trimmed);
        if (providerId === caseRow.providerId) return { changed: false };
        await prisma.case.update({
          where: { id: caseId },
          data: { providerId },
        });
        return { changed: true, column: "providerId" };
      }

      // plan_number → Case.policyRef mirror. Restored to its pre-2026-09-23
      // behaviour (always mirror when called) BUT the AI merge caller in
      // services/aiBffApply.ts:applyFieldExtraction now skips calling this
      // function when the fieldKey is "plan_number". That single-line
      // conditional at the caller enforces the team rule from 2026-09-23:
      // the AI never writes to Case.policyRef, but CA-initiated edits
      // (manual checklist PATCH, seed with value, N/A bulk-fill) do
      // propagate as they did before — so a CA who spots a wrong
      // Case.policyRef on the case header can still correct it by typing
      // the right value into the checklist "Plan number" row.
      //
      // Historical context (2026-09-01 → 2026-09-23):
      //   - Until 33b309e (2026-09-23), every extraction where AI's
      //     plan_number differed from Case.policyRef silently overwrote
      //     the case column, bypassing guardLockedFields(). 15 confirmed
      //     prod cases had their CA-sourced Zoho value replaced by an AI
      //     reading; review pack held outside the repo.
      //   - 33b309e removed this branch entirely. That stopped the AI
      //     writes as intended but also broke the CA correction path —
      //     manual checklist edits to plan_number no longer updated the
      //     header. Regression named plainly against post-extraction
      //     cases.
      //   - This restoration reinstates the mirror for all callers and
      //     narrows the block to the single AI call site. Semantics land
      //     where the team rule wanted them: CA can propagate, AI cannot.
      case "plan_number": {
        const trimmed = value.trim();
        if (caseRow.policyRef === trimmed) return { changed: false };
        await prisma.case.update({
          where: { id: caseId },
          data: { policyRef: trimmed },
        });
        return { changed: true, column: "policyRef" };
      }

      case "start_date": {
        const parsed = parseDate(value);
        if (!parsed) return { changed: false };
        if (
          caseRow.planStartDate &&
          caseRow.planStartDate.toISOString().slice(0, 10) ===
            parsed.toISOString().slice(0, 10)
        ) {
          return { changed: false };
        }
        await prisma.case.update({
          where: { id: caseId },
          data: { planStartDate: parsed },
        });
        return { changed: true, column: "planStartDate" };
      }

      default:
        return { changed: false };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[caseFieldMirror] Failed to mirror ${fieldKey}=${value} to case ${caseId}:`,
      (err as Error).message,
    );
    return { changed: false };
  }
}
