// backend/prisma/seed.ts
// Seeds: checklist templates (aligned to "Ceding Checklist - Blank.xlsx"), demo users, sample providers.
// Source of truth for fields: Pension / ISA / GIA tabs of the official ceding checklist workbook.

import { PrismaClient, PlanType, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
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
    acceptedSigType?: string;
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
      acceptedSigType: "Either",
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
      acceptedSigType: "Either",
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
      acceptedSigType: "Either",
      planTypePrefixes: ["SW", "DC", "ISA"],
    },
    {
      name: "Standard Life",
      phoneMain: "0345 272 7272",
      emailMain: "transfers@standardlife.co.uk",
      postalAddress: "Standard Life, 1 George Street, Edinburgh, EH2 2LL",
      isOnOrigo: true,
      loaFormat: "EITHER",
      acceptedSigType: "Either",
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
        acceptedSigType: p.acceptedSigType ?? undefined,
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
        acceptedSigType: p.acceptedSigType,
        planTypePrefixes: p.planTypePrefixes ?? [],
        notes: p.notes,
      },
    });
  }

  // ─────────────────────────────────────────────────────
  // PENSION CHECKLIST TEMPLATE  (matches Pension tab)
  // ─────────────────────────────────────────────────────
  const pensionFields: Array<{
    section: string;
    key: string;
    label: string;
    type: string;
    order: number;
    options?: string[];
    note?: string;
  }> = [
    // ── Basic Details ──
    { section: "Basic Details", key: "Provider_group", label: "Provider Name", type: "text", order: 1 },
    { section: "Basic Details", key: "provider_phone_email", label: "Provider Telephone Number & Email Address", type: "text", order: 2 },
    { section: "Basic Details", key: "plan_number", label: "Plan Number", type: "text", order: 3 },
    { section: "Basic Details", key: "pension_type", label: "Type of Pension (Personal Pension / SIPP / Other)", type: "dropdown", order: 4, options: ["Personal Pension Plan", "SIPP", "IPP", "Group Stakeholder", "Stakeholder", "Occupational DC", "Workplace", "Section 32", "Group Pension Plan", "Other"] },
    { section: "Basic Details", key: "scheme_name", label: "Name of Policy / Scheme", type: "text", order: 5 },
    { section: "Basic Details", key: "contract_or_trust", label: "Is the plan Contract based or Trust based?", type: "dropdown", order: 6, options: ["Contract", "Trust"] },
    { section: "Basic Details", key: "plan_status", label: "Status (Inforce-Active / Paid Up)", type: "dropdown", order: 7, options: ["Inforce Active", "Paid Up"], note: "Inforce-Active if contribution is ongoing; Paid Up if no ongoing contribution." },
    { section: "Basic Details", key: "start_date", label: "Start Date", type: "date", order: 8 },
    { section: "Basic Details", key: "normal_retirement_date", label: "Normal Retirement Date / Age / Protected Retirement Age", type: "text", order: 9, note: "What age can client access benefits?" },
    { section: "Basic Details", key: "is_inherited_pension", label: "Inherited / Beneficiary Pension? (If yes, all or part? Taxable?)", type: "yes_no", order: 10, note: "If yes, continue checklist but notify PP/ADV immediately. Pre-75 death = inherit tax-free; post-75 = beneficiary pays income tax on withdrawals." },

    // ── Transaction History ──
    { section: "Transaction History", key: "contribution_personal", label: "Ongoing Regular Contributions – Personal (GROSS or NET)", type: "currency", order: 11 },
    { section: "Transaction History", key: "contribution_employee", label: "Ongoing Regular Contributions – Employee", type: "currency", order: 12 },
    { section: "Transaction History", key: "contribution_employer", label: "Ongoing Regular Contributions – Employer", type: "currency", order: 13 },
    { section: "Transaction History", key: "withdrawal_details", label: "Withdrawals Details (Regular / Lumpsum / Ongoing amount being paid)", type: "free_text", order: 14 },
    { section: "Transaction History", key: "pct_crystallised", label: "% Crystallised", type: "percentage", order: 15 },
    { section: "Transaction History", key: "tax_free_cash", label: "Tax Free Cash Taken (£ and %)", type: "text", order: 16 },
    { section: "Transaction History", key: "tax_year_2025_2026", label: "Contributions: 06/04/2025 – 05/04/2026", type: "currency", order: 17, note: "Pensions only. Proof of past 4 years' transactions is required." },
    { section: "Transaction History", key: "tax_year_2024_2025", label: "Contributions: 06/04/2024 – 05/04/2025", type: "currency", order: 18 },
    { section: "Transaction History", key: "tax_year_2023_2024", label: "Contributions: 06/04/2023 – 05/04/2024", type: "currency", order: 19 },
    { section: "Transaction History", key: "tax_year_2022_2023", label: "Contributions: 06/04/2022 – 05/04/2023", type: "currency", order: 20 },
    { section: "Transaction History", key: "employer_personal_breakdown", label: "Breakdown of Employer & Personal (per tax year, £)", type: "free_text", order: 21 },

    // ── Valuation & Fund Details ──
    { section: "Valuation & Fund Details", key: "current_value", label: "Current Value (with date)", type: "text", order: 22 },
    { section: "Valuation & Fund Details", key: "transfer_value", label: "Transfer Value (if higher than CV, state any bonuses etc.)", type: "currency", order: 23 },
    { section: "Valuation & Fund Details", key: "loyalty_bonuses", label: "Are there any Loyalty or Other Bonuses applied? (provide details)", type: "yes_no", order: 24 },
    { section: "Valuation & Fund Details", key: "crystallised_split", label: "Crystallised & Uncrystallised Split", type: "free_text", order: 25 },
    // Fund Details is now a structured table — see ChecklistFundLine model.
    { section: "Valuation & Fund Details", key: "fund_range_link", label: "Range of Funds Available for Investment (provide client-specific link)", type: "url", order: 27 },
    { section: "Valuation & Fund Details", key: "restricted_funds", label: "Are any of the funds held restricted for trading? (provide details)", type: "free_text", order: 28 },

    // ── With Profit Funds ──
    { section: "With Profit Funds", key: "wp_fund_names_isin", label: "With-Profits Fund Names & ISIN", type: "free_text", order: 29 },
    { section: "With Profit Funds", key: "wp_guaranteed_growth_rate", label: "Guaranteed Growth Rate (if applicable)", type: "percentage", order: 30 },
    { section: "With Profit Funds", key: "wp_ppfm", label: "PPFM (Principles & Practices of Financial Management)", type: "free_text", order: 31 },
    { section: "With Profit Funds", key: "wp_historical_bonus_rate", label: "Historical Bonus Rate", type: "free_text", order: 32 },
    { section: "With Profit Funds", key: "wp_mvr", label: "Market Value Reduction (MVR)", type: "free_text", order: 33 },
    { section: "With Profit Funds", key: "wp_terminal_bonus", label: "Terminal Bonus", type: "free_text", order: 34 },

    // ── Charges ──
    { section: "Charges", key: "platform_charge", label: "Platform Charge / Plan Charges", type: "percentage", order: 35 },
    { section: "Charges", key: "wrapper_charges", label: "Wrapper Charges", type: "percentage", order: 36 },
    { section: "Charges", key: "fund_charges_weighted", label: "Fund Charges (Weighted Average)", type: "percentage", order: 37 },
    { section: "Charges", key: "transactional_fund_charge", label: "Transactional Fund Charge", type: "percentage", order: 38 },
    { section: "Charges", key: "advice_charges", label: "Advice Charges", type: "currency", order: 39 },
    { section: "Charges", key: "exit_charge", label: "Exit Charge / Penalty on Transfer", type: "text", order: 40 },
    { section: "Charges", key: "discount_on_charges", label: "Does a discount on charges or any other discount apply? (provide details)", type: "yes_no", order: 41 },
    { section: "Charges", key: "other_charges", label: "Any other charges (e.g. switch charge, bid-offer spread)", type: "free_text", order: 42 },

    // ── Guarantees ──
    { section: "Guarantees", key: "gmp", label: "Guaranteed Minimum Pension (GMP)", type: "yes_no", order: 43 },
    { section: "Guarantees", key: "gar", label: "Guaranteed Annuity Rate (GAR)", type: "yes_no", order: 44 },
    { section: "Guarantees", key: "guaranteed_income", label: "Guaranteed Income", type: "yes_no", order: 45 },
    { section: "Guarantees", key: "guaranteed_capital_value", label: "Guaranteed Capital Value", type: "yes_no", order: 46 },
    { section: "Guarantees", key: "other_guarantees", label: "Any Other Guarantees Applicable", type: "free_text", order: 47 },
    { section: "Guarantees", key: "protected_tax_free_cash", label: "Protected Tax-Free Cash", type: "yes_no", order: 48 },
    { section: "Guarantees", key: "waiver_of_premium", label: "Waiver of Premiums / Contributions", type: "yes_no", order: 49 },
    { section: "Guarantees", key: "additional_life_cover", label: "Additional Life Cover", type: "yes_no", order: 50 },

    // ── Pre-A-Day Protected Tax-Free Cash (only if pension started before 06/04/2006) ──
    { section: "Protected Tax-Free Cash (Pre-A-Day)", key: "a_day_value", label: "A-Day Value", type: "currency", order: 51, note: "Only applicable if pension started before 06/04/2006." },
    { section: "Protected Tax-Free Cash (Pre-A-Day)", key: "a_day_tax_free_cash", label: "A-Day Tax-Free Cash", type: "currency", order: 52 },
    { section: "Protected Tax-Free Cash (Pre-A-Day)", key: "current_tax_free_cash", label: "Tax-Free Cash on Current Basis", type: "currency", order: 53 },

    // ── Benefits & Options Available ──
    { section: "Benefits & Options Available", key: "drawdown_available", label: "Is drawdown facility available?", type: "yes_no", order: 54 },
    { section: "Benefits & Options Available", key: "drawdown_options", label: "Drawdown options available (FAD / UFPLS / Annuity in-house / Annuity OMO)", type: "free_text", order: 55 },
    { section: "Benefits & Options Available", key: "transfer_internal_for_fad", label: "If FAD not available, can the plan be transferred internally to another plan that supports it?", type: "yes_no", order: 56 },
    { section: "Benefits & Options Available", key: "origo_or_discharge", label: "Origo Option Available OR Discharge Forms required (if no Origo)?", type: "dropdown", order: 57, options: ["Origo", "Discharge Forms", "Both", "Neither"] },
    { section: "Benefits & Options Available", key: "partial_transfer_facility", label: "Is partial transfer facility available? Minimum balance to keep account open?", type: "free_text", order: 58 },
    { section: "Benefits & Options Available", key: "lifestyling", label: "Lifestyling – is it available for this plan & is it active?", type: "free_text", order: 59 },
    { section: "Benefits & Options Available", key: "death_benefits", label: "Death Benefits (Pay-out of fund value / Beneficiary drawdown)", type: "free_text", order: 60 },
    { section: "Benefits & Options Available", key: "benefits_before_75", label: "Does client have to take benefits from plan prior to age 75?", type: "yes_no", order: 61 },
    { section: "Benefits & Options Available", key: "former_protected_rights", label: "Former Protected Rights? If yes, what is the value?", type: "text", order: 62 },
    { section: "Benefits & Options Available", key: "pension_subject_to_orders", label: "Is the pension subject to a Pension Sharing Order / Earmarking / Bankruptcy?", type: "yes_no", order: 63, note: "If yes, continue checklist but notify PP/ADV immediately." },
    { section: "Benefits & Options Available", key: "external_transfers_in", label: "Can external plans be transferred IN?", type: "yes_no", order: 64 },
    { section: "Benefits & Options Available", key: "named_beneficiaries_split", label: "Are there any named beneficiaries? If so, what is the % split between each?", type: "free_text", order: 65 },
    { section: "Benefits & Options Available", key: "in_specie_transfer_out", label: "Are in-specie transfers available if transferring AWAY?", type: "yes_no", order: 66 },
  ];

  for (const f of pensionFields) {
    await prisma.checklistTemplate.upsert({
      where: { planType_fieldKey: { planType: PlanType.PENSION, fieldKey: f.key } },
      update: {
        sectionName: f.section,
        fieldName: f.label,
        fieldType: f.type,
        dropdownOptions: f.options ?? [],
        displayOrder: f.order,
        conditionalNote: f.note ?? null,
        isActive: true,
      },
      create: {
        planType: PlanType.PENSION,
        sectionName: f.section,
        fieldName: f.label,
        fieldKey: f.key,
        fieldType: f.type,
        dropdownOptions: f.options ?? [],
        displayOrder: f.order,
        conditionalNote: f.note ?? null,
        isRequired: true,
        isActive: true,
      },
    });
  }

  // ─────────────────────────────────────────────────────
  // ISA CHECKLIST TEMPLATE  (matches ISA tab)
  // ─────────────────────────────────────────────────────
  const isaFields: Array<{
    section: string;
    key: string;
    label: string;
    type: string;
    order: number;
    options?: string[];
    note?: string;
  }> = [
    // ── Basic Details ──
    { section: "Basic Details", key: "Provider_group", label: "Provider Name", type: "text", order: 1 },
    { section: "Basic Details", key: "provider_phone_email", label: "Provider Telephone Number & Email Address", type: "text", order: 2 },
    { section: "Basic Details", key: "plan_number", label: "Plan Number", type: "text", order: 3 },
    { section: "Basic Details", key: "isa_type", label: "Type of ISA (Stocks & Shares / Cash / Lifetime)", type: "dropdown", order: 4, options: ["Stocks and Shares ISA", "Cash ISA", "Innovative Finance ISA", "Lifetime ISA"] },
    { section: "Basic Details", key: "start_date", label: "Start Date", type: "date", order: 5 },
    { section: "Basic Details", key: "is_flexible_isa", label: "Is this a 'Flexible ISA'?", type: "yes_no", order: 6 },

    // ── Transaction History ──
    { section: "Transaction History", key: "total_investment", label: "Total Investment", type: "currency", order: 7 },
    { section: "Transaction History", key: "regular_contribution", label: "Amount of Ongoing Regular Contributions", type: "currency", order: 8 },
    { section: "Transaction History", key: "current_tax_year_contribution", label: "Current Year Subscriptions (Allowance used this tax year)", type: "currency", order: 9 },
    { section: "Transaction History", key: "withdrawal_details", label: "Withdrawals Details (Regular / Lumpsum / Ongoing amount being paid)", type: "free_text", order: 10 },

    // ── Valuation & Fund Details ──
    { section: "Valuation & Fund Details", key: "current_value", label: "Current Value (with date)", type: "text", order: 11 },
    { section: "Valuation & Fund Details", key: "transfer_value", label: "Transfer Value (if higher than CV, disclose why)", type: "currency", order: 12 },
    // Fund Details is now a structured table — see ChecklistFundLine model.
    { section: "Valuation & Fund Details", key: "fund_range_link", label: "Range of Funds Available for Investment (provide client-specific link)", type: "url", order: 14 },
    { section: "Valuation & Fund Details", key: "restricted_funds", label: "Are any of the funds held restricted for trading? (provide details)", type: "free_text", order: 15 },

    // ── With Profit Funds ──
    { section: "With Profit Funds", key: "wp_fund_names_isin", label: "With-Profits Fund Names & ISIN", type: "free_text", order: 16 },
    { section: "With Profit Funds", key: "wp_ppfm", label: "PPFM", type: "free_text", order: 17 },
    { section: "With Profit Funds", key: "wp_historical_bonus_rate", label: "Historical Bonus Rate", type: "free_text", order: 18 },
    { section: "With Profit Funds", key: "wp_mvr", label: "Market Value Reduction (MVR)", type: "free_text", order: 19 },

    // ── Charges ──
    { section: "Charges", key: "platform_charge", label: "Platform Charge", type: "percentage", order: 20 },
    { section: "Charges", key: "fund_charges_weighted", label: "Fund Charges (Weighted Average)", type: "percentage", order: 21 },
    { section: "Charges", key: "transactional_fund_charge", label: "Transactional Fund Charge", type: "percentage", order: 22 },
    { section: "Charges", key: "advice_charges", label: "Advice Charges", type: "currency", order: 23 },
    { section: "Charges", key: "exit_charge", label: "Exit Charge / Penalty on Transfer", type: "text", order: 24 },
    { section: "Charges", key: "other_charges", label: "Any other charges (e.g. switch charge, bid-offer spread)", type: "free_text", order: 25 },

    // ── Guarantees ──
    { section: "Guarantees", key: "any_guarantees", label: "Any Guarantees Applicable", type: "free_text", order: 26 },

    // ── Benefits & Options Available ──
    { section: "Benefits & Options Available", key: "origo_option", label: "Origo Option Available", type: "yes_no", order: 27 },
    { section: "Benefits & Options Available", key: "discharge_forms", label: "Discharge Forms", type: "free_text", order: 28 },
    { section: "Benefits & Options Available", key: "transfer_systems", label: "Transfer Systems", type: "free_text", order: 29 },
    { section: "Benefits & Options Available", key: "isa_aps_transfer", label: "Do you allow an ISA APS transfer for the client's spouse beneficiary?", type: "yes_no", order: 30 },
    { section: "Benefits & Options Available", key: "in_specie_transfer_out", label: "Are in-specie transfers available if transferring AWAY?", type: "yes_no", order: 31 },
    { section: "Benefits & Options Available", key: "other_notes", label: "Other Notes", type: "free_text", order: 32 },
  ];

  for (const f of isaFields) {
    await prisma.checklistTemplate.upsert({
      where: { planType_fieldKey: { planType: PlanType.ISA, fieldKey: f.key } },
      update: {
        sectionName: f.section,
        fieldName: f.label,
        fieldType: f.type,
        dropdownOptions: f.options ?? [],
        displayOrder: f.order,
        conditionalNote: f.note ?? null,
        isActive: true,
      },
      create: {
        planType: PlanType.ISA,
        sectionName: f.section,
        fieldName: f.label,
        fieldKey: f.key,
        fieldType: f.type,
        dropdownOptions: f.options ?? [],
        displayOrder: f.order,
        conditionalNote: f.note ?? null,
        isRequired: true,
        isActive: true,
      },
    });
  }

  // ─────────────────────────────────────────────────────
  // GIA CHECKLIST TEMPLATE  (matches GIA tab)
  // ─────────────────────────────────────────────────────
  const giaFields: Array<{
    section: string;
    key: string;
    label: string;
    type: string;
    order: number;
    options?: string[];
    note?: string;
  }> = [
    // ── Basic Details ──
    { section: "Basic Details", key: "single_or_joint", label: "Single or Joint client", type: "dropdown", order: 1, options: ["Single", "Joint"] },
    { section: "Basic Details", key: "Provider_group", label: "Provider Name", type: "text", order: 2 },
    { section: "Basic Details", key: "provider_phone_email", label: "Provider Telephone Number & Email Address", type: "text", order: 3 },
    { section: "Basic Details", key: "plan_number", label: "Plan Number", type: "text", order: 4 },
    { section: "Basic Details", key: "start_date", label: "Start Date", type: "date", order: 5 },

    // ── Transaction History ──
    { section: "Transaction History", key: "total_contributions", label: "Total Contributions", type: "currency", order: 6 },
    { section: "Transaction History", key: "regular_contribution", label: "Amount of Ongoing Regular Contributions", type: "currency", order: 7 },
    { section: "Transaction History", key: "withdrawal_details", label: "Withdrawals Details", type: "free_text", order: 8 },
    { section: "Transaction History", key: "current_tax_year_contribution", label: "Contributions Made This Tax Year", type: "currency", order: 9 },
    { section: "Transaction History", key: "gain_loss_pct", label: "Gain / Loss % currently on plan", type: "percentage", order: 10 },

    // ── Valuation & Fund Details ──
    { section: "Valuation & Fund Details", key: "current_value", label: "Current Value (with date)", type: "text", order: 11 },
    { section: "Valuation & Fund Details", key: "transfer_value", label: "Transfer Value", type: "currency", order: 12 },
    { section: "Valuation & Fund Details", key: "transfer_value_difference_reason", label: "If transfer value is different from current value – mention the reason", type: "free_text", order: 13 },
    // Fund Details is now a structured table — see ChecklistFundLine model.
    { section: "Valuation & Fund Details", key: "fund_range_link", label: "Range of Funds Available for Investment (provide client-specific link)", type: "url", order: 15 },
    { section: "Valuation & Fund Details", key: "restricted_funds", label: "Are any of the funds held restricted for trading? (provide details)", type: "free_text", order: 16 },

    // ── With Profit Funds ──
    { section: "With Profit Funds", key: "wp_fund_names_isin", label: "With-Profits Fund Names & ISIN", type: "free_text", order: 17 },
    { section: "With Profit Funds", key: "wp_ppfm", label: "PPFM", type: "free_text", order: 18 },
    { section: "With Profit Funds", key: "wp_historical_bonus_rate", label: "Historical Bonus Rate", type: "free_text", order: 19 },
    { section: "With Profit Funds", key: "wp_mvr", label: "Market Value Reduction (MVR)", type: "free_text", order: 20 },

    // ── Charges ──
    { section: "Charges", key: "platform_charge", label: "Platform Charge / Wrapper Charge", type: "percentage", order: 21 },
    { section: "Charges", key: "fund_charges_weighted", label: "Fund Charges (Weighted Average) + Base Cost of Funds", type: "percentage", order: 22 },
    { section: "Charges", key: "transactional_fund_charge", label: "Transactional Fund Charge", type: "percentage", order: 23 },
    { section: "Charges", key: "advice_charges", label: "Advice Charges", type: "currency", order: 24 },
    { section: "Charges", key: "exit_charge", label: "Exit Charge / Penalty on Transfer", type: "text", order: 25 },
    { section: "Charges", key: "setup_fees_to_adviser", label: "Setup Fees Paid to Adviser (required – can offset against CGT)", type: "currency", order: 26 },
    { section: "Charges", key: "other_charges", label: "Any other charges (e.g. switch charge, bid-offer spread)", type: "free_text", order: 27 },

    // ── Guarantees ──
    { section: "Guarantees", key: "any_guarantees", label: "Any Guarantees Applicable", type: "free_text", order: 28 },

    // ── Benefits & Options Available ──
    { section: "Benefits & Options Available", key: "origo_option", label: "Origo Option Available", type: "yes_no", order: 29 },
    { section: "Benefits & Options Available", key: "discharge_forms", label: "Discharge Forms", type: "free_text", order: 30 },
    { section: "Benefits & Options Available", key: "realised_unrealised_gain_report", label: "Provide unrealised and realised gain report for wrapper (CGT calculation)", type: "free_text", order: 31 },
    { section: "Benefits & Options Available", key: "in_specie_transfer_out", label: "Are in-specie transfers available if transferring AWAY?", type: "yes_no", order: 32 },
    { section: "Benefits & Options Available", key: "other_notes", label: "Other Notes", type: "free_text", order: 33 },
  ];

  for (const f of giaFields) {
    await prisma.checklistTemplate.upsert({
      where: { planType_fieldKey: { planType: PlanType.GIA, fieldKey: f.key } },
      update: {
        sectionName: f.section,
        fieldName: f.label,
        fieldType: f.type,
        dropdownOptions: f.options ?? [],
        displayOrder: f.order,
        conditionalNote: f.note ?? null,
        isActive: true,
      },
      create: {
        planType: PlanType.GIA,
        sectionName: f.section,
        fieldName: f.label,
        fieldKey: f.key,
        fieldType: f.type,
        dropdownOptions: f.options ?? [],
        displayOrder: f.order,
        conditionalNote: f.note ?? null,
        isRequired: true,
        isActive: true,
      },
    });
  }

  // ── Deactivate legacy free-text fund_details fields (now superseded by ChecklistFundLine) ──
  const deactivated = await prisma.checklistTemplate.updateMany({
    where: { fieldKey: "fund_details" },
    data: { isActive: false },
  });
  if (deactivated.count > 0) {
    console.log(`ℹ️  Deactivated ${deactivated.count} legacy 'fund_details' template field(s).`);
  }

  console.log(
    `✅ Seeding complete — Pension: ${pensionFields.length} fields | ISA: ${isaFields.length} fields | GIA: ${giaFields.length} fields`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
