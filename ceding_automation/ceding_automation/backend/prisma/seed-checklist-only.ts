// One-off: re-seeds ONLY the checklist templates from the canonical JSON.
// Used when the full seed.ts times out partway through the providers loop
// (Azure PG closing the long-running session). Logic mirrors
// seedChecklistFromCanonical() in seed.ts but skips users + providers.
// Idempotent — safe to re-run.

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();
const CANONICAL_PATH = join(__dirname, "canonical", "checklist-fields-v1.json");

async function run() {
  const startMs = Date.now();
  console.log("[checklist-only-seed] Starting…");
  console.log(
    "[checklist-only-seed] DB host:",
    process.env.DATABASE_URL?.match(/@([^:/]+)/)?.[1],
  );

  const canonical = JSON.parse(readFileSync(CANONICAL_PATH, "utf8"));
  console.log("[checklist-only-seed] Canonical version:", canonical.version);

  const mapType = (t: string): string => {
    const m: Record<string, string> = {
      text: "text",
      text_long: "free_text",
      date: "date",
      currency: "currency",
      percent: "percentage",
      boolean: "yes_no",
      dropdown: "dropdown",
      url: "url",
      table: "table",
    };
    return m[t] ?? "text";
  };

  for (const planKey of ["ISA", "GIA", "PENSION"] as const) {
    const planType = planKey;
    const fields = canonical.plans[planKey];

    const existing = await prisma.checklistTemplate.findMany({
      where: { planType, isActive: true },
      select: { fieldKey: true },
    });
    const existingKeys = new Set(
      existing.map((e: { fieldKey: string }) => e.fieldKey),
    );
    const canonicalKeys = new Set(fields.map((f: any) => f.key));

    const inserts = fields.filter((f: any) => !existingKeys.has(f.key)).length;
    const updates = fields.filter((f: any) => existingKeys.has(f.key)).length;
    const deactivations = [...existingKeys].filter(
      (k) => !canonicalKeys.has(k),
    );

    await prisma.$transaction(
      async (tx: any) => {
        for (const f of fields) {
          const meta: any = {};
          if (f.typical_values) meta.typical_values = f.typical_values;
          if (f.normalize_per) meta.normalize_per = f.normalize_per;
          if (f.allows_defer_to_source)
            meta.allows_defer_to_source = f.allows_defer_to_source;
          if (f.defer_examples) meta.defer_examples = f.defer_examples;
          if (f.auto_extract_hint) meta.auto_extract_hint = f.auto_extract_hint;
          if (f.parent_field) meta.parent_field = f.parent_field;
          if (f.columns) meta.columns = f.columns;
          if (f.accepts_non_applicable_markers)
            meta.accepts_non_applicable_markers =
              f.accepts_non_applicable_markers;
          if (f.section_order) meta.section_order = f.section_order;
          const hasMeta = Object.keys(meta).length > 0;

          const data: any = {
            sectionName: f.section,
            fieldName: f.label,
            fieldType: mapType(f.type),
            dropdownOptions: f.options ?? [],
            displayOrder: f.display_order,
            conditionalNote: f.note ?? null,
            isRequired: f.required,
            isActive: true,
          };
          if (hasMeta) data.metadata = meta;

          await tx.checklistTemplate.upsert({
            where: {
              planType_fieldKey: { planType: planType as any, fieldKey: f.key },
            },
            update: data,
            create: { planType: planType as any, fieldKey: f.key, ...data },
          });
        }
        if (deactivations.length > 0) {
          await tx.checklistTemplate.updateMany({
            where: {
              planType: planType as any,
              fieldKey: { in: deactivations },
              isActive: true,
            },
            data: { isActive: false },
          });
        }
      },
      { timeout: 60000 },
    );

    console.log(
      `  ${planKey}: inserts=${inserts} updates=${updates} deactivations=${deactivations.length}`,
    );
  }

  const legacy = await prisma.checklistTemplate.updateMany({
    where: { fieldKey: "fund_details", isActive: true },
    data: { isActive: false },
  });
  if (legacy.count > 0) {
    console.log(`  Legacy fund_details deactivated: ${legacy.count}`);
  }

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[checklist-only-seed] Complete in ${elapsedSec}s`);

  await prisma.$disconnect();
}

run().catch((e: any) => {
  console.error(e);
  process.exit(1);
});
