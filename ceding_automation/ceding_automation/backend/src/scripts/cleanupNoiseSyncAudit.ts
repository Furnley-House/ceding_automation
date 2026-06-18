// One-shot cleanup: deletes "Synced 0 fields from Zoho" audit rows.
//
// Background: until 17-Jun the sync-from-zoho route wrote a CASE_UPDATED
// audit row on every call, including the (very common) case where the
// diff produced zero real field changes. The case-detail page auto-syncs
// on each load and the "Refresh from Zoho" button is one click away, so
// these noise rows accumulated rapidly — 80%+ of sync audit entries in
// the local DB were the empty variety. They clutter the case timeline
// and obscure the rows that recorded a real CRM change.
//
// The going-forward fix lives in routes/cases.ts (audit write gated on
// `changedRealData`). This script cleans up the historical pollution.
//
// Only deletes rows that match ALL of:
//   action   = CASE_UPDATED
//   source   = SYSTEM
//   newValue starts with "Synced 0 "
// So genuine sync rows ("Synced 3 fields from Zoho") survive untouched.
//
// Run locally:
//   npx tsx src/scripts/cleanupNoiseSyncAudit.ts
// Run against staging (from a workstation with DATABASE_URL=<staging>):
//   DATABASE_URL=<staging-url> npx tsx src/scripts/cleanupNoiseSyncAudit.ts
//
// Idempotent — re-running after the gating fix is in place will report 0.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const where = {
    action: "CASE_UPDATED" as const,
    source: "SYSTEM",
    newValue: { startsWith: "Synced 0 " },
  };

  const candidateCount = await prisma.auditLog.count({ where });
  console.log(`Noise audit rows to delete (Synced 0 fields): ${candidateCount}`);

  if (candidateCount === 0) {
    console.log("Nothing to clean up — exiting.");
    return;
  }

  // Sanity-check: count the "Synced N fields" rows we are KEEPING so the
  // operator can compare before/after if they're curious.
  const keptUsefulCount = await prisma.auditLog.count({
    where: {
      action: "CASE_UPDATED",
      source: "SYSTEM",
      newValue: { startsWith: "Synced " },
      NOT: { newValue: { startsWith: "Synced 0 " } },
    },
  });
  console.log(`Useful sync audit rows being preserved (N≥1): ${keptUsefulCount}`);

  const result = await prisma.auditLog.deleteMany({ where });
  console.log(`Deleted ${result.count} noise rows.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
