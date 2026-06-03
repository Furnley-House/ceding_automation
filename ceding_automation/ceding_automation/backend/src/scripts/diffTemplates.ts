// One-shot diff: ChecklistTemplate (DB) vs canonical JSON.
// Run with:  npx tsx src/scripts/diffTemplates.ts
import { PrismaClient, PlanType } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();

interface CanonicalField {
  key: string;
  type: string;
  label: string;
}
interface Canonical {
  version: string;
  plans: Record<"ISA" | "GIA" | "PENSION", CanonicalField[]>;
}

async function main() {
  const canonical: Canonical = JSON.parse(
    readFileSync(join(__dirname, "../../prisma/canonical/checklist-fields-v1.json"), "utf8"),
  );

  console.log(`Canonical version: ${canonical.version}\n`);

  for (const planKey of ["ISA", "GIA", "PENSION"] as const) {
    const canonicalKeys = new Set(canonical.plans[planKey].map((f) => f.key));
    const allTemplates = await prisma.checklistTemplate.findMany({
      where: { planType: PlanType[planKey] },
      select: { fieldKey: true, fieldName: true, isActive: true, displayOrder: true },
      orderBy: { displayOrder: "asc" },
    });
    const active = allTemplates.filter((t) => t.isActive);
    const inactive = allTemplates.filter((t) => !t.isActive);
    const orphansActive = active.filter((t) => !canonicalKeys.has(t.fieldKey));
    const dupKeys = new Map<string, number>();
    allTemplates.forEach((t) => dupKeys.set(t.fieldKey, (dupKeys.get(t.fieldKey) ?? 0) + 1));
    const duplicates = [...dupKeys.entries()].filter(([, n]) => n > 1);

    console.log(`──── ${planKey} ────`);
    console.log(`  DB rows total:   ${allTemplates.length}`);
    console.log(`  DB rows active:  ${active.length}`);
    console.log(`  DB rows inactive:${inactive.length}`);
    console.log(`  Canonical count: ${canonical.plans[planKey].length}`);
    console.log(`  Active orphans (not in canonical): ${orphansActive.length}`);
    if (orphansActive.length > 0) {
      orphansActive.slice(0, 30).forEach((o) =>
        console.log(`    • ${o.fieldKey.padEnd(40)} "${o.fieldName}"`),
      );
    }
    if (duplicates.length > 0) {
      console.log(`  Duplicate fieldKeys in DB: ${duplicates.length}`);
      duplicates.forEach(([k, n]) => console.log(`    • ${k} ×${n}`));
    }
    console.log("");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
