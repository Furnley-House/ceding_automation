// backend/src/services/caseFieldMirror.ts
// Propagate checklist-field changes back to the corresponding columns on
// the Case row, so the header / cases list / dashboard reflect what the
// AI extracted (or the CA team manually entered).
//
// The checklist is the source of truth for these values — case columns
// are just cached projections we keep in sync.
//
// Currently mirrored:
//   provider_name → Case.providerId  (creates a Provider record if needed)
//   plan_number   → Case.policyRef
//   start_date    → Case.planStartDate
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
