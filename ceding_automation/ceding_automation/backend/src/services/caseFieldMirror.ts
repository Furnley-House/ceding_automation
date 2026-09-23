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
//   start_date    → Case.planStartDate (always overwrite on difference)
//
// NOT mirrored (deliberately, as of 2026-09-23):
//   plan_number   → Case.policyRef — REMOVED. The case's policy ref is
//     source-of-truth from Zoho, owned by the CA. See the explanatory
//     comment inline in the switch below (search for "REMOVED 2026-09-23").
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

      // plan_number → Case.policyRef mirror REMOVED 2026-09-23.
      //
      // Prior behaviour (until 2026-09-23): AI-extracted plan_number
      // silently overwrote Case.policyRef whenever they differed.
      // This bypassed the locked-field guard in cases.ts, which lives
      // on the Express route middleware and does not intercept
      // service-level prisma calls. 15 confirmed prod cases had their
      // CA-sourced Zoho value silently replaced by the AI's reading
      // via this path; separate review pack tracks the review of
      // those cases (held outside the repo — contains client PII).
      //
      // Team rule (2026-09-23): the case's policyRef comes from the
      // Zoho task; the CA owns getting it right. The AI never writes
      // back to Case.policyRef. On mismatch, extraction still records
      // the disagreement on the checklist_field row for plan_number
      // (existing hasConflict + conflictValues path in aiBffApply),
      // and checklist_fields.value continues to record "what the doc
      // said" so a reviewer can compare against Case.policyRef by
      // hand. A prominent case-level mismatch banner is a separate
      // future change; not part of this deploy.
      //
      // The switch falls through to default ({changed: false}) when
      // fieldKey === "plan_number" — the correct outcome under the
      // new rule.
      //
      // NOTE: the Ship #1 locked-field guard in routes/cases.ts still
      // includes policyRef in its LOCKED_FIELDS set. That decision is
      // independent of this mirror change and is being tracked
      // separately. This change on its own STOPS new silent overwrites
      // going forward without altering the guard's current behaviour
      // on Zoho re-sync or manual PATCH.

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
