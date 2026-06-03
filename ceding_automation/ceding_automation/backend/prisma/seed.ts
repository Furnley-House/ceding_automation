// backend/prisma/seed.ts
// Seeds: checklist templates (canonical JSON v1.x), demo users, sample providers.
// Checklist source of truth: ../shared-contracts/checklist-fields-v1.json
//   (mirrored to ./canonical/checklist-fields-v1.json so this file works inside
//    the Docker image and CI without path traversal outside the backend dir).
// Both backend and the BFF load the same canonical to eliminate field-key drift.

import { PrismaClient, PlanType, UserRole, Prisma } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");
const CANONICAL_PATH = join(__dirname, "canonical", "checklist-fields-v1.json");

type PlanKey = "ISA" | "GIA" | "PENSION";

interface CanonicalField {
  key: string;
  label: string;
  section: string;
  section_order: number;
  display_order: number;
  type: string;
  required: boolean;
  options?: string[];
  typical_values?: string[];
  note?: string;
  columns?: unknown[];
  normalize_per?: string;
  accepts_non_applicable_markers?: boolean;
  allows_defer_to_source?: boolean;
  defer_examples?: string[];
  auto_extract_hint?: string;
  parent_field?: string;
}

interface Canonical {
  version: string;
  plans: Record<PlanKey, CanonicalField[]>;
}

// Map canonical field type → backend's existing ChecklistTemplate.fieldType vocabulary.
// Decision: keep backend vocabulary so the frontend doesn't need to change this weekend.
function mapType(canonicalType: string): string {
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
  return m[canonicalType] ?? "text";
}

// Pack the v1.1 extras that don't have a dedicated column into the metadata JSONB.
// Returns null when nothing to store so we don't write empty objects.
function buildMetadata(f: CanonicalField): Prisma.InputJsonValue | null {
  const md: Record<string, unknown> = {};
  if (f.typical_values) md.typical_values = f.typical_values;
  if (f.normalize_per) md.normalize_per = f.normalize_per;
  if (f.accepts_non_applicable_markers) md.accepts_non_applicable_markers = true;
  if (f.allows_defer_to_source) md.allows_defer_to_source = true;
  if (f.defer_examples) md.defer_examples = f.defer_examples;
  if (f.auto_extract_hint) md.auto_extract_hint = f.auto_extract_hint;
  if (f.parent_field) md.parent_field = f.parent_field;
  if (f.columns) md.columns = f.columns;
  if (typeof f.section_order === "number") md.section_order = f.section_order;
  return Object.keys(md).length > 0 ? (md as Prisma.InputJsonValue) : null;
}

interface PlanDiff {
  inserts: string[]; // canonical keys absent from DB
  updates: string[]; // canonical keys present in DB
  deactivations: string[]; // active DB keys not in canonical
}

async function computePlanDiff(planType: PlanType, fields: CanonicalField[]): Promise<PlanDiff> {
  const existing = await prisma.checklistTemplate.findMany({
    where: { planType, isActive: true },
    select: { fieldKey: true },
  });
  const existingKeys = new Set(existing.map((e) => e.fieldKey));
  const canonicalKeys = new Set(fields.map((f) => f.key));
  return {
    inserts: fields.filter((f) => !existingKeys.has(f.key)).map((f) => f.key),
    updates: fields.filter((f) => existingKeys.has(f.key)).map((f) => f.key),
    deactivations: [...existingKeys].filter((k) => !canonicalKeys.has(k)),
  };
}

function printSummary(label: string, diff: Record<PlanKey, PlanDiff>): void {
  console.log(`\n[seed] ${label}:`);
  for (const planKey of ["ISA", "GIA", "PENSION"] as PlanKey[]) {
    const d = diff[planKey];
    const preview = d.deactivations.slice(0, 6).join(", ");
    const more = d.deactivations.length > 6 ? `, +${d.deactivations.length - 6} more` : "";
    const deactStr = d.deactivations.length > 0 ? `  (${preview}${more})` : "";
    console.log(
      `  ${planKey.padEnd(8)} inserts=${d.inserts.length}  updates=${d.updates.length}  deactivations=${d.deactivations.length}${deactStr}`,
    );
  }
}

async function seedChecklistFromCanonical(): Promise<void> {
  const canonical: Canonical = JSON.parse(readFileSync(CANONICAL_PATH, "utf8"));
  console.log(`[seed] Canonical version: ${canonical.version}`);

  const planKeys: PlanKey[] = ["ISA", "GIA", "PENSION"];
  const diff = {} as Record<PlanKey, PlanDiff>;

  for (const planKey of planKeys) {
    const planType = PlanType[planKey];
    const fields = canonical.plans[planKey];
    diff[planKey] = await computePlanDiff(planType, fields);

    if (DRY_RUN) continue;

    await prisma.$transaction(async (tx) => {
      for (const f of fields) {
        const meta = buildMetadata(f);
        const data = {
          sectionName: f.section,
          fieldName: f.label,
          fieldType: mapType(f.type),
          dropdownOptions: f.options ?? [],
          displayOrder: f.display_order,
          conditionalNote: f.note ?? null,
          metadata: meta ?? Prisma.JsonNull,
          isRequired: f.required,
          isActive: true,
        };
        await tx.checklistTemplate.upsert({
          where: { planType_fieldKey: { planType, fieldKey: f.key } },
          update: data,
          create: { planType, fieldKey: f.key, ...data },
        });
      }

      if (diff[planKey].deactivations.length > 0) {
        await tx.checklistTemplate.updateMany({
          where: { planType, fieldKey: { in: diff[planKey].deactivations }, isActive: true },
          data: { isActive: false },
        });
      }
    });
  }

  // Legacy: deactivate the free-text fund_details rows (now superseded by ChecklistFundLine
  // + canonical fund_lines table). Kept for idempotency; per-plan pass above also handles it.
  if (!DRY_RUN) {
    const legacy = await prisma.checklistTemplate.updateMany({
      where: { fieldKey: "fund_details", isActive: true },
      data: { isActive: false },
    });
    if (legacy.count > 0) {
      console.log(`[seed] Deactivated ${legacy.count} legacy fund_details template(s)`);
    }
  }

  printSummary(DRY_RUN ? "DRY RUN summary (no DB writes)" : "Checklist seed complete", diff);
}

async function main() {
  // ── SAFETY: refuse to seed prod DB without explicit override ──
  const env = process.env.NODE_ENV ?? "development";
  const dbHost = process.env.DATABASE_URL?.match(/@([^:/]+)/)?.[1] ?? "unknown";
  console.log(`[seed] Running against: NODE_ENV=${env}, DB host=${dbHost}`);
  if (dbHost.includes("prod") && process.env.FORCE_PROD_SEED !== "true") {
    throw new Error("Refusing to seed prod DB without FORCE_PROD_SEED=true");
  }

  if (DRY_RUN) {
    console.log("[seed] DRY RUN — read-only diff vs canonical, no DB writes");
    await seedChecklistFromCanonical();
    return;
  }

  console.log("🌱 Seeding database...");

  // ── SYSTEM USER (BFF write-back attribution) ────────
  // Audit-log rows written by the BFF integration cite this synthetic user.
  // Fixed ID so middleware/internalKey.ts can reference it without a lookup.
  // Role=ADMIN is the narrowest role that passes any requireRole check; the
  // user is never authenticated as a human (no email login, no SSO match).
  await prisma.user.upsert({
    where: { id: "system-ai-bff" },
    update: {},
    create: {
      id: "system-ai-bff",
      email: "ai-system@furnleyhouse.internal",
      name: "AI Extraction (system)",
      role: "ADMIN",
      status: "ACTIVE",
    },
  });

  // ── DEMO USERS (one per role) ───────────────────────
  const demoUsers = [
    { email: "admin@furnleyhouse.co.uk", name: "Nicki Foster", role: UserRole.ADMIN },
    // Default CA Team user (used by the role picker). Aligns with the real CRM user
    // so Zoho-task imports map cleanly to this app account.
    { email: "revathy.s@furnleyhouse.co.uk", name: "Revathy S", role: UserRole.CA_TEAM },
    // Secondary CA Team user kept for multi-CA testing.
    { email: "ca@furnleyhouse.co.uk", name: "Priya Ramesh", role: UserRole.CA_TEAM },
    { email: "paraplanner@furnleyhouse.co.uk", name: "Emma Clarke", role: UserRole.PARAPLANNER },
    { email: "adviser@furnleyhouse.co.uk", name: "James Whitfield", role: UserRole.ADVISER },
    { email: "srinath.k@furnleyhouse.co.uk", name: "Srinath K", role: UserRole.CA_TEAM },
  ];
  for (const u of demoUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name },
      create: { email: u.email, name: u.name, role: u.role },
    });
  }

  // ── PROVIDER DIRECTORY ──────────────────────────────
  // Source: "Provider Contact details test.xlsx" (contact info)
  //         "Origo Provider list test.xlsx"       (isOnOrigo flag)
  // De-duplicated and merged. Re-running seed updates contact fields.
  type ProviderInput = {
    name: string;
    phoneMain?: string;
    phoneCedingDept?: string;
    emailMain?: string;
    emailCedingDept?: string;
    postalAddress?: string;
    loaFormat?: "EITHER" | "ELECTRONIC" | "WET_SIGNATURE";
    isOnOrigo?: boolean;
    planTypePrefixes?: string[];
    notes?: string;
  };

  const providers: ProviderInput[] = [
    // ── ORIGO-ONLY (on Origo network, no contact details on file) ────────────
    { name: "Test -Sri",                          isOnOrigo: true },
    { name: "7IM",                                isOnOrigo: true },
    { name: "Aberdeen",                           isOnOrigo: true },
    { name: "AIG Life",                           isOnOrigo: true },
    { name: "AJ Bell Investcenter",               isOnOrigo: true },
    { name: "Albion Capital Group LLP",           isOnOrigo: true },
    { name: "Alliance Witan",                     isOnOrigo: true },
    { name: "Aptia",                              isOnOrigo: true },
    { name: "Barnett Waddingham",                 isOnOrigo: true },
    { name: "Benchmark",                          isOnOrigo: true },
    { name: "BestInvest",                         isOnOrigo: true },
    { name: "Blackfinch",                         isOnOrigo: true },
    { name: "British Friendly",                   isOnOrigo: true },
    { name: "Brooks Macdonald",                   isOnOrigo: true },
    { name: "Bupa - PMI",                         isOnOrigo: true },
    { name: "Canada Life",                        isOnOrigo: true },
    { name: "Cazenove Capital",                   isOnOrigo: true },
    { name: "Cirencester Friendly",               isOnOrigo: true },
    { name: "Clerical Medical",                   isOnOrigo: true },
    { name: "Columbia Threadneedle",              isOnOrigo: true },
    { name: "Curtis Banks",                       isOnOrigo: true },
    { name: "Day Cooper Day",                     isOnOrigo: true },
    { name: "Dentists Provident",                 isOnOrigo: true },
    { name: "Dentons Pension Management",         isOnOrigo: true },
    { name: "DP Pensions",                        isOnOrigo: true },
    { name: "Embark Pensions",                    isOnOrigo: true },
    { name: "Evelyn Partners",                    isOnOrigo: true },
    { name: "Foresight Group",                    isOnOrigo: true },
    { name: "Freetrade",                          isOnOrigo: true },
    { name: "Fundment Pension",                   isOnOrigo: true },
    { name: "Fundsmith",                          isOnOrigo: true },
    { name: "Guardian 1821",                      isOnOrigo: true },
    { name: "Halifax",                            isOnOrigo: true },
    { name: "Hartley Pensions",                   isOnOrigo: true },
    { name: "Holloway Friendly",                  isOnOrigo: true },
    { name: "HS Administrative Services",         isOnOrigo: true },
    { name: "Ingenious",                          isOnOrigo: true },
    { name: "InvestAcc",                          isOnOrigo: true },
    { name: "Investec Wealth & Investment",       isOnOrigo: true },
    { name: "iPensions Group Ltd",                isOnOrigo: true },
    { name: "J.P. Morgan Personal Investing",    isOnOrigo: true },
    { name: "James Hay",                          isOnOrigo: true },
    { name: "Janus Henderson",                   isOnOrigo: true },
    { name: "Jupiter Asset Management",          isOnOrigo: true },
    { name: "Just Group",                        isOnOrigo: true },
    { name: "LGT Wealth Management",             isOnOrigo: true },
    { name: "Liontrust",                         isOnOrigo: true },
    { name: "London & Colonial",                 isOnOrigo: true },
    { name: "Marlborough Group",                 isOnOrigo: true },
    { name: "Moneybox",                          isOnOrigo: true },
    { name: "Moneyfarm",                         isOnOrigo: true },
    { name: "Morgan Lloyd",                      isOnOrigo: true },
    { name: "Morningstar Wealth Platform",       isOnOrigo: true },
    { name: "National Friendly",                 isOnOrigo: true },
    { name: "NFU Mutual",                        isOnOrigo: true },
    { name: "NHS Pensions Scheme",               isOnOrigo: true },
    { name: "Options Workplace Trust",           isOnOrigo: true },
    { name: "Parmenion",                         isOnOrigo: true },
    { name: "PensionBee",                        isOnOrigo: true },
    { name: "Rathbones",                         isOnOrigo: true },
    { name: "RL360",                             isOnOrigo: true },
    { name: "Ruffer LLP",                        isOnOrigo: true },
    { name: "Sanlam",                            isOnOrigo: true },
    { name: "Scottish Widows Platform",          isOnOrigo: true, notes: "Formerly Embark" },
    { name: "SEI Master Trust",                  isOnOrigo: true },
    { name: "Smart Pension",                     isOnOrigo: true },
    { name: "Sovereign Pension Services",        isOnOrigo: true },
    { name: "Sun Life",                          isOnOrigo: true },
    { name: "Talbot and Muir",                   isOnOrigo: true },
    { name: "The People's Pension",              isOnOrigo: true },
    { name: "Transact",                          isOnOrigo: true },
    { name: "Trinity Bridge",                    isOnOrigo: true },
    { name: "Unum",                              isOnOrigo: true },
    { name: "Utmost International",              isOnOrigo: true },
    { name: "Utmost Life and Pensions",          isOnOrigo: true },
    { name: "Vitality",                          isOnOrigo: true },
    { name: "Wealthtime Select",                 isOnOrigo: true },
    { name: "Wesleyan Assurance",                isOnOrigo: true },
    { name: "Xafinity",                          isOnOrigo: true },
    { name: "Yorsipp",                           isOnOrigo: true },

    // ── ORIGO + CONTACT DETAILS ──────────────────────────────────────────────
    {
      name: "Test -Sri",
      phoneMain: "01162185867",
      emailMain: "sri@test.com",
      postalAddress: "abrdn Elevate, PO Box 6891, Basingstoke, RG24 4SN",
      isOnOrigo: true,
      notes: "Previously Standard Life Elevate; now under abrdn brand",
    },
    {
      name: "Aberdeen (Elevate)",
      phoneMain: "0345 300 4177",
      emailMain: "Elevate_enquiries@abrdn.com",
      postalAddress: "abrdn Elevate, PO Box 6891, Basingstoke, RG24 4SN",
      isOnOrigo: true,
      notes: "Previously Standard Life Elevate; now under abrdn brand",
    },
    {
      name: "Aon",
      phoneMain: "01252 768000",
      emailMain: "theaonmt.admin@aon.co.uk",
      emailCedingDept: "admin@theaonmt.co.uk",
      isOnOrigo: true,
      notes: "Also: aa.pensions@aon.com",
    },
    {
      name: "Aviva",
      phoneMain: "0345 366 1647",
      phoneCedingDept: "0800 285 1098",
      emailMain: "enquiries@aviva.co.uk",
      emailCedingDept: "NGP.questions@dgaviva.com",
      postalAddress: "Aviva, PO Box 520, Norwich, NR1 3WG",
      isOnOrigo: true,
      loaFormat: "EITHER",
      planTypePrefixes: ["AV", "PP", "ISA", "GS", "TK", "DD", "PW", "B"],
      notes: "Multiple numbers: GPP 0345 602 9221, Personal 0800 953 1777, Advised Platform 0800 068 2170, Protection 0800 285 1098. Ceding email for GPP: NGP.questions@dgaviva.com; Aviva Protection: bpamail@aviva.com",
    },
    {
      name: "Capita",
      phoneMain: "0370 1234 701",
      emailMain: "axa-pensions@capita.com",
      postalAddress: "PO Box 555, Stead House, Darlington, DL1 9YT",
      isOnOrigo: true,
      notes: "Administers AXA UK Group Pension Scheme, Michelin Pensions (0344 3912 422 / michelin@pensionsoffice.com), Pfizer and others",
    },
    {
      name: "Creative Pension Trust",
      phoneMain: "0845 606 0424",
      emailMain: "admin@creativepensiontrust.co.uk",
      isOnOrigo: true,
    },
    {
      name: "Forester Life",
      phoneMain: "0333 600 0333",
      emailMain: "service@foresters.co.uk",
      postalAddress: "Foresters House, 2 Cromwell Avenue, Bromley, BR2 9BF",
      isOnOrigo: true,
      notes: "Also known as Foresters Financial. Plan prefix: CT (Child Trust Fund)",
    },
    {
      name: "Friends Provident",
      phoneMain: "+44 (0)1624 821212",
      emailMain: "GM-fpicustomerservices@fpinternational.com",
      isOnOrigo: true,
      notes: "International arm (Friends Provident International). Plan prefix: e.g. 787014",
    },
    {
      name: "Hargreaves Lansdown",
      phoneMain: "0117 900 9000",
      emailMain: "operations.queryteam@hl.co.uk",
      isOnOrigo: true,
      planTypePrefixes: ["ISA"],
    },
    {
      name: "Intelligent Money",
      phoneMain: "0115 94 84 200",
      isOnOrigo: true,
      notes: "Online at www.intelligentmoney.com. Plan prefix: P0126-",
    },
    {
      name: "Legal & General",
      phoneMain: "0345 070 8686",
      emailMain: "DCthirdparty.response@landg.com",
      emailCedingDept: "employerdedicatedteam@landg.com",
      postalAddress: "Legal & General Investment Management, Workplace DC Pensions Operations, 2 Fitzalan Road, Cardiff CF24 0EB",
      isOnOrigo: true,
      planTypePrefixes: ["LG"],
      notes: "Listed on Origo as 'L&G'. DB/Final Salary: 03450 778 778 / dbretirements@landg.com. Protection: 03700 10 4080 / Protection.customerenquiries@landg.com. Address for DB: City Park, The Droveway, Hove, BN3 7PY",
    },
    {
      name: "Lloyds Banking Group",
      phoneMain: "01737 227522",
      emailMain: "Lloyds1and2@willistowerswatson.com",
      postalAddress: "Willis Towers Watson, PO Box 545, Redhill, RH1 1YX",
      isOnOrigo: true,
      notes: "DB/Final Salary scheme administered by Willis Towers Watson",
    },
    {
      name: "LV=",
      phoneMain: "0800 681 6291",
      emailMain: "Heritage.Pensions@LV.com",
      emailCedingDept: "bondservicing@lv.com",
      isOnOrigo: true,
      notes: "Also known as Liverpool Victoria. FSAVC/Pensions: Heritage.Pensions@LV.com. Investment Bonds: bondservicing@lv.com / 0800 681 6292",
    },
    {
      name: "MetLife",
      phoneMain: "0800 022 4443",
      emailMain: "Customerservice@metlife.co.uk",
      postalAddress: "Beacon House, 27 Clarendon Road, Belfast, BT1 3BG",
      isOnOrigo: true,
      notes: "Listed as both 'Metlife' and 'Met Life' on Origo; canonical name MetLife",
    },
    {
      name: "NEST",
      phoneMain: "0300 020 0090",
      emailMain: "support@nestpensions.org.uk",
      postalAddress: "NEST, Nene Hall, Lynch Wood Business Park, Peterborough, PE2 6FY",
      isOnOrigo: true,
    },
    {
      name: "Nucleus",
      phoneMain: "0131 226 9535",
      emailMain: "client.relations@nucleusfinancial.com",
      postalAddress: "Nucleus HQ, Greenside, 12 Blenheim Place, Edinburgh EH7 5JH",
      isOnOrigo: true,
      notes: "Also known as Nucleus Pension / Nucleus Financial. Plan prefix: N",
    },
    {
      name: "Octopus",
      phoneMain: "0345 528 8888",
      emailMain: "support@octopusmoney.com",
      postalAddress: "Octopus Money Direct, PO Box 24204, Edinburgh EH3 1JP",
      isOnOrigo: true,
      planTypePrefixes: ["VM", "ISA"],
    },
    {
      name: "OneFamily",
      phoneMain: "0344 892 0920",
      emailMain: "customerservices@onefamily.com",
      postalAddress: "OneFamily, 16-17 West Street, Brighton, BN1 2RL",
      isOnOrigo: true,
      planTypePrefixes: ["PP"],
    },
    {
      name: "Peoples Partnership",
      phoneMain: "0300 2000 555",
      emailMain: "adminmip@peoplespartnership.co.uk",
      emailCedingDept: "memberinfo@bandce.co.uk",
      postalAddress: "Manor Royal, Crawley, West Sussex, RH10 9QP",
      isOnOrigo: true,
      notes: "Previously B&CE. Also listed on Origo as 'The People's Pension'. Plan prefix: PP",
    },
    {
      name: "Phoenix Wealth",
      phoneMain: "0345 129 9993",
      postalAddress: "Phoenix Wealth, PO Box 1393, Peterborough PE2 2TP",
      isOnOrigo: true,
      notes: "Listed on Origo as 'Phoenix Wealth (Axa Wealth)'. Plan prefix: e.g. 5715018",
    },
    {
      name: "Prudential",
      phoneMain: "0800 640 9200",
      emailMain: "GeneralServicing.PruWealth@Prudential.co.uk",
      postalAddress: "Prudential, Lancing BN15 8GB",
      isOnOrigo: true,
      notes: "GPP: 0345 075 2244 / gpp@prudential-pensions.co.uk. ISA/Investments via Link Group: 0344 335 8936 / Prudential@linkgroup.co.uk, LFI Investor Services, PO Box 385, Darlington DL1 9UA. Also trading as Pru (M&G): 0808 234 0808",
    },
    {
      name: "Quilter",
      phoneMain: "0808 171 2626",
      emailMain: "ask@quilter.com",
      isOnOrigo: true,
    },
    {
      name: "ReAssure",
      phoneMain: "0800 073 1777",
      isOnOrigo: true,
      notes: "Plan prefix: PP",
    },
    {
      name: "Royal London",
      phoneMain: "0345 605 0050",
      emailMain: "PP.policyinfo@royallondon.com",
      emailCedingDept: "pensiontransfers@royallondon.com",
      postalAddress: "Royal London House, Alderley Park, Congleton Road, Nether Alderley, Macclesfield, SK10 4EL",
      isOnOrigo: true,
      loaFormat: "EITHER",
      planTypePrefixes: ["RL"],
      notes: "Transfers: pensiontransfers@royallondon.com / 0345 605 7777, 5th floor Churchgate House, 56 Oxford Street, Manchester M1 6EU. Protection: 0345 6094 500 / protectionhelp@royallondon.com",
    },
    {
      name: "Scottish Friendly",
      phoneMain: "01733 353 405",
      emailMain: "enquiries@scottishfriendlypensions.co.uk",
      postalAddress: "Scottish Friendly, Sunderland, SR43 4DB",
      isOnOrigo: true,
    },
    {
      name: "Scottish Widows",
      phoneMain: "0345 7556 557",
      phoneCedingDept: "0345 716 6777",
      emailMain: "WorkplacePensionsAdviser@scottishwidows.co.uk",
      postalAddress: "Scottish Widows Ltd, 69 Morrison Street, Edinburgh, EH3 1HL",
      isOnOrigo: true,
      loaFormat: "EITHER",
      planTypePrefixes: ["SW", "DC", "ISA"],
    },
    {
      name: "Standard Life",
      phoneMain: "0345 272 7272",
      emailMain: "transfers@standardlife.co.uk",
      postalAddress: "Standard Life, 1 George Street, Edinburgh, EH2 2LL",
      isOnOrigo: true,
      loaFormat: "EITHER",
      planTypePrefixes: ["SL", "SIPP", "EL"],
      notes: "Elevate platform now under abrdn brand (see Aberdeen (Elevate)). Elevate contact: 0345 300 4177 / Elevate_enquiries@abrdn.com / abrdn Elevate, PO Box 6891, Basingstoke, RG24 4SN",
    },
    {
      name: "St James's Place",
      phoneMain: "0800 027 1031",
      emailMain: "SJPemail@sjpadmin.co.uk",
      postalAddress: "St James's Place, PO Box 9034, Chelmsford, Essex, CM99 2XA",
      isOnOrigo: true,
      planTypePrefixes: ["ISA"],
      notes: "ISA: 0800 072 0229. Listed on Origo as 'St James's Place wealth management'",
    },
    {
      name: "Sun Life Financial of Canada",
      phoneMain: "0345 072 0223",
      emailMain: "CustomerService@uksloc-co.uk",
      postalAddress: "Sun Life Financial of Canada, PO Box 7019, Basingstoke, RG24 4LY",
      isOnOrigo: true,
      notes: "Personal Pension plans. Separate entry from 'Sun Life' (also on Origo)",
    },
    {
      name: "True Potential",
      phoneMain: "0191 242 4866",
      emailMain: "LOA@tpllp.com",
      emailCedingDept: "Platform@tpllp.com",
      postalAddress: "Gateway West, Newburn Riverside, Newcastle upon Tyne, NE15 8NX",
      isOnOrigo: true,
      planTypePrefixes: ["P0126"],
      notes: "Listed on Origo as 'True Potential Investments'",
    },
    {
      name: "Wealthtime",
      phoneMain: "0345 680 8000",
      emailMain: "CSServicing@wealthtime.com",
      isOnOrigo: true,
      notes: "Also known as Novia Financial plc. See also Wealthtime Select (separate Origo entry)",
    },
    {
      name: "Willis Towers Watson",
      phoneMain: "01737 788157",
      emailMain: "bnp.paribas@willistowerswatson.com",
      postalAddress: "Willis Towers Watson, PO Box 545, Redhill, RH1 1YX",
      isOnOrigo: true,
      notes: "Administers multiple pension schemes including BNP Paribas (01737 788157), Natwest Group Pension (01737 227549 / GPFPensions@Willistowerswatson.com), Lloyds Bank (01737 227522), Akzo Nobel CPS (0113 394 9305 / CPS.Pacontact@willistowerswatson.com)",
    },
    {
      name: "Zurich Assurance Ltd",
      phoneMain: "0370 909 6010",
      emailMain: "life.servicing@uk.zurich.com",
      postalAddress: "Sterling Centre, PO Box 461, Bishops Cleeve, Cheltenham, GL52 8ZN",
      isOnOrigo: true,
      notes: "Also traded as Sterling. Investment Bonds.",
    },

    // ── CONTACT DETAILS ONLY (not on Origo network) ──────────────────────────
    {
      name: "Aegon",
      phoneMain: "01733 353 417",
      emailMain: "my.pension@aegon.co.uk",
      emailCedingDept: "Clientsupport@arc.aegon.co.uk",
      postalAddress: "Aegon Workplace Investing, Sunderland, SR43 4DH",
      isOnOrigo: false,
      planTypePrefixes: ["A/"],
      notes: "Platform (ARC): 03456 10 00 10 / Clientsupport@arc.aegon.co.uk / Aegon, Sunderland, SR43 4DS. Retiready: 0330 123 0211 / referrals@aegon.co.uk / Platform Client Services, Aegon, Sunderland, SR43 4DL",
    },
    {
      name: "Atlas Master Trust",
      phoneMain: "0345 121 3389",
      emailMain: "atlas@capita.co.uk",
      emailCedingDept: "memberenquiries@atlasmastertrust.co.uk",
      postalAddress: "Atlas Master Trust, PO Box 555, Stead House, Darlington, DL1 9YT",
      isOnOrigo: false,
      notes: "Administered by Capita",
    },
    {
      name: "Babcock",
      phoneMain: "0121 210 4382",
      emailMain: "babcock@hymans.co.uk",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Final Salary scheme administered by Hymans Robertson",
    },
    {
      name: "Balfour Beatty",
      phoneMain: "0151 482 4664",
      emailMain: "BBPensionsHelpDesk@balfourbeatty.com",
      postalAddress: "Balfour Beatty Pensions Centre, Kings Business Park, Kings Drive, Prescot, Merseyside, L34 1PJ",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Final Salary scheme. Standard Section ref e.g. 3036",
    },
    {
      name: "British Steel Pension Scheme",
      phoneMain: "0330 440 0844",
      emailMain: "Pension.enquiries@bspspensions.com",
      postalAddress: "British Steel Pension Scheme, FREEPOST RUCT-GLGS-HLRU, Glasgow, G2 5RU",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Final Salary",
    },
    {
      name: "Buck",
      phoneMain: "0330 123 0647",
      emailMain: "BASF@buck.com",
      postalAddress: "Buck (Bristol), PO Box 319, Mitcheldean, GL14 9BF",
      isOnOrigo: false,
      notes: "Administers multiple schemes. Sky Benefits: 0330 678 1504 / SPP@buck.com / Buck (Manchester), PO Box 324, Mitcheldean, GL14 9BJ",
    },
    {
      name: "DHL Pensions",
      phoneMain: "0161 425 7370",
      emailMain: "dhl.uk.pensions@dhl.com",
      postalAddress: "DHL Pensions, Howard House, 40-64 St Johns Street, Bedford, MK42 0DJ",
      isOnOrigo: false,
    },
    {
      name: "Equiniti",
      phoneMain: "0333 207 6553",
      emailMain: "digital@equiniti.com",
      postalAddress: "Sutherland House, Russell Way, Crawley, West Sussex, RH10 1UH",
      isOnOrigo: false,
      notes: "Administers HP/Hewlett-Packard Ltd Retirement Benefits Plan and HSBC Bank (UK) Pension Scheme among others. HSBC contact: HSBCDBPensions@equiniti.com",
    },
    {
      name: "Fidelity",
      phoneMain: "0800 414181",
      postalAddress: "Fidelity, PO Box 391, Tadworth, Surrey, KT20 9FU",
      isOnOrigo: false,
      notes: "Handles all plan types. Also 0800 414161",
    },
    {
      name: "Friends Provident International",
      phoneMain: "+44 (0)1624 821212",
      emailMain: "GM-fpicustomerservices@fpinternational.com",
      isOnOrigo: false,
      notes: "Offshore/international pensions. Separate from Friends Provident (UK/Origo)",
    },
    {
      name: "Hawthorn Life",
      phoneMain: "0800 028 7272",
      emailMain: "hll@ifdspercana.com",
      postalAddress: "Hawthorn Life Customer Service Team, PO Box 12135, Chelmsford, CM99 2DX",
      isOnOrigo: false,
    },
    {
      name: "HSBC Bank Pension Scheme",
      phoneMain: "0371 384 2620",
      emailMain: "HSBCDBPensions@equiniti.com",
      postalAddress: "HSBC Bank (UK) Pension Scheme, PO Box 5227, Lancing, BN99 9FN",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Final Salary scheme administered by Equiniti",
    },
    {
      name: "Invesco",
      phoneMain: "0800 085 8677",
      emailMain: "enquiry@invesco.com",
      postalAddress: "Invesco Administration Centre, PO Box 586, Darlington DL1 9BE",
      isOnOrigo: false,
      notes: "Also: enquiry@clientservices.invesco.com",
    },
    {
      name: "LGPS Warwickshire",
      phoneMain: "01926 412167",
      emailMain: "membership.pensions@warwickshire.gov.uk",
      postalAddress: "Treasury Management & Pensions, Shire Hall, Warwick, CV34 4RL",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Local Government Pension Scheme (Warwickshire County Council)",
    },
    {
      name: "Mercer",
      phoneMain: "01689 887500",
      emailMain: "SPU@mercer.com",
      postalAddress: "Post Handling Centre, St James's Tower, 7 Charlotte Street, Manchester, M1 4DZ",
      isOnOrigo: false,
      notes: "Administers multiple Final Salary schemes including Santander (JLT29325254). TNT Group Pension: 0330 100 3190 / TNTpensions@mercer.com / Mercer, Maclaren House, Talbot Road, Stretford, Manchester M32 0FP",
    },
    {
      name: "Natwest Group Pension Fund",
      phoneMain: "01737 227549",
      emailMain: "GPFPensions@Willistowerswatson.com",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Final Salary, administered by Willis Towers Watson",
    },
    {
      name: "Now Pensions",
      phoneMain: "0330 100 3334",
      emailMain: "membersupport@nowpensions.com",
      postalAddress: "Maclaren House, Talbot Road, Stretford, Manchester, M32 0FP",
      isOnOrigo: false,
    },
    {
      name: "Pfizer Pensions (Capita)",
      phoneMain: "0800 328 4233",
      emailMain: "Pfizerpensions@capita.co.uk",
      postalAddress: "Capita, PO Box 555, Stead House, Darlington, DL1 9YT",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Final Salary scheme administered by Capita",
    },
    {
      name: "Phoenix Life",
      phoneMain: "0345 305 5552",
      emailMain: "Pensions@phoenixlife.co.uk",
      postalAddress: "Phoenix Life, 301 St Vincent Street, Glasgow, G2 5AB",
      isOnOrigo: false,
      notes: "Also: 0345 9600 900 / Phoenix Life, 100 Holdenhurst Road, Bournemouth, BH8 8AL. Plan prefix: R (e.g. R49595)",
    },
    {
      name: "Plumbing Pensions",
      phoneMain: "03457 656565",
      emailMain: "info@plumbingpensions.co.uk",
      postalAddress: "Bellevue House, 22 Hopetoun Street, Edinburgh, EH7 4GH",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Final Salary",
    },
    {
      name: "Premier Companies",
      phoneMain: "0800 122 3200",
      emailMain: "admin@premiercompanies.co.uk",
      postalAddress: "Premier, PO Box 108, Blyth, NE24 9DY",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Administers SIG pension scheme (SIG0001673). Also SIG contact: 0800 488 0791 / sig@premiercompanies.co.uk",
    },
    {
      name: "Railpen",
      phoneMain: "02476 472589",
      emailMain: "enquiries@railpen.com",
      postalAddress: "2 Rye Hill Office Park, Birmingham Road, Allesley, Coventry CV5 9AB",
      isOnOrigo: false,
      notes: "Administers railway industry pension schemes including EON scheme",
    },
    {
      name: "TPT Retirement Solutions",
      phoneMain: "0113 394 2551",
      emailMain: "enquiries@tpt.org.uk",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Final Salary. Administers Riverside DB Scheme (M7029317/SHPS2)",
    },
    {
      name: "Universities Superannuation Scheme",
      phoneMain: "0333 300 1043",
      emailMain: "Correspondence-team@uss.co.uk",
      postalAddress: "Royal Liver Building, Liverpool L3 1PY",
      isOnOrigo: false,
      notes: "Investment Builder / USS. Plan prefix: e.g. 48644529",
    },
    {
      name: "Westerby",
      phoneMain: "0116 326 0183",
      emailMain: "johnplatt@westerby.co.uk",
      postalAddress: "Westerby, The Crescent, King Street, Leicester, LE1 6RX",
      isOnOrigo: false,
      notes: "Private pension. Plan prefix: CPP",
    },
    {
      name: "XPS Administration",
      phoneMain: "0131 370 2888",
      emailMain: "individual.edinburgh@xpsplc.com",
      postalAddress: "3rd Floor, East Wing, 40 Torphichen Street, Edinburgh, EH3 8JB",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE",
      notes: "Final Salary scheme administration",
    },
  ];

  for (const p of providers) {
    await prisma.provider.upsert({
      where: { name: p.name },
      update: {
        phoneMain: p.phoneMain ?? undefined,
        phoneCedingDept: p.phoneCedingDept ?? undefined,
        emailMain: p.emailMain ?? undefined,
        emailCedingDept: p.emailCedingDept ?? undefined,
        postalAddress: p.postalAddress ?? undefined,
        isOnOrigo: p.isOnOrigo ?? false,
        loaFormat: p.loaFormat ?? undefined,
        planTypePrefixes: p.planTypePrefixes ?? undefined,
        notes: p.notes ?? undefined,
      },
      create: {
        name: p.name,
        phoneMain: p.phoneMain,
        phoneCedingDept: p.phoneCedingDept,
        emailMain: p.emailMain,
        emailCedingDept: p.emailCedingDept,
        postalAddress: p.postalAddress,
        isOnOrigo: p.isOnOrigo ?? false,
        loaFormat: p.loaFormat ?? "EITHER",
        planTypePrefixes: p.planTypePrefixes ?? [],
        notes: p.notes,
      },
    });
  }

  // ─────────────────────────────────────────────────────
  // CHECKLIST TEMPLATES — loaded from canonical JSON
  // ─────────────────────────────────────────────────────
  await seedChecklistFromCanonical();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
