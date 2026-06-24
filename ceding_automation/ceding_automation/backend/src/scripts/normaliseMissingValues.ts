// One-shot: clean up checklist fields where the AI persisted the literal
// string "MISSING" as the value. Treats them as truly missing — sets
// value=null and confidence=MISSING so the UI counters agree.
//
// Run with: npx tsx src/scripts/normaliseMissingValues.ts
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // Case-insensitive match — covers "MISSING", "Missing", "missing", etc.
  const candidates = await prisma.checklistField.findMany({
    where: { value: { mode: "insensitive", equals: "MISSING" } },
    select: { id: true, caseId: true, value: true, confidence: true, status: true },
  });
  console.log(`Found ${candidates.length} fields with value === "MISSING".`);
  if (candidates.length === 0) return;

  // Don't stomp adviser/CA decisions: preserve approved + manually-overridden rows.
  const safe = await prisma.checklistField.findMany({
    where: {
      id: { in: candidates.map((c) => c.id) },
      isApproved: false,
      isManuallyOverridden: false,
    },
    select: { id: true },
  });
  const safeIds = safe.map((s) => s.id);
  console.log(`Of those, ${safeIds.length} are safe to normalise (not approved / not manually overridden).`);

  if (safeIds.length === 0) return;

  const result = await prisma.checklistField.updateMany({
    where: { id: { in: safeIds } },
    data: { value: null, confidence: "MISSING" },
  });
  console.log(`Normalised ${result.count} rows → value=null, confidence=MISSING.`);
}

main().then(() => prisma.$disconnect()).catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
