// backend/prisma/seed.ts
// Seeds: checklist templates (aligned to "Ceding Checklist - Blank.xlsx"), demo users, sample providers.
// Source of truth for fields: Pension / ISA / GIA tabs of the official ceding checklist workbook.

import { PrismaClient, PlanType, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // ── DEMO USERS (one per role) ───────────────────────
  const demoUsers = [
    { email: "admin@furnleyhouse.co.uk", name: "Nicki Foster", role: UserRole.ADMIN },
    { email: "ca@furnleyhouse.co.uk", name: "Priya Ramesh", role: UserRole.CA_TEAM },
    { email: "paraplanner@furnleyhouse.co.uk", name: "Emma Clarke", role: UserRole.PARAPLANNER },
    { email: "adviser@furnleyhouse.co.uk", name: "James Whitfield", role: UserRole.ADVISER },
  ];
  for (const u of demoUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name },
      create: { email: u.email, name: u.name, role: u.role },
    });
  }

  // ── SAMPLE PROVIDERS ────────────────────────────────
  const providers = [
    {
      name: "Aviva",
      phoneMain: "0800 285 1088",
      phoneCedingDept: "0800 285 1099",
      emailMain: "ceding@aviva.co.uk",
      isOnOrigo: true,
      loaFormat: "EITHER" as const,
      acceptedSigType: "Electronic",
      planTypePrefixes: ["AV", "PP", "ISA"],
    },
    {
      name: "Scottish Widows",
      phoneMain: "0345 716 6777",
      phoneCedingDept: "0345 716 6788",
      emailMain: "ceding@scottishwidows.co.uk",
      isOnOrigo: true,
      loaFormat: "EITHER" as const,
      acceptedSigType: "Either",
      planTypePrefixes: ["SW", "DC", "ISA"],
    },
    {
      name: "Standard Life",
      phoneMain: "0345 272 7272",
      phoneCedingDept: "0345 272 7273",
      emailMain: "transfers@standardlife.co.uk",
      isOnOrigo: false,
      loaFormat: "WET_SIGNATURE" as const,
      acceptedSigType: "Wet",
      postalAddress: "Standard Life, 1 George Street, Edinburgh, EH2 2LL",
      planTypePrefixes: ["SL", "SIPP"],
    },
  ];

  for (const p of providers) {
    await prisma.provider.upsert({
      where: { name: p.name },
      update: {},
      create: p,
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
    { section: "Basic Details", key: "provider_name", label: "Provider Name", type: "text", order: 1 },
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
    { section: "Valuation & Fund Details", key: "fund_details", label: "Fund Details (Fund Name | ISIN/Sedol/Citi code | Units | Price/unit | Value | Fund Charge)", type: "free_text", order: 26 },
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
    { section: "Basic Details", key: "provider_name", label: "Provider Name", type: "text", order: 1 },
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
    { section: "Valuation & Fund Details", key: "fund_details", label: "Fund Details (Fund Name | ISIN/Sedol/Citi code | Units | Price/unit | Value | Fund Charge)", type: "free_text", order: 13 },
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
    { section: "Basic Details", key: "provider_name", label: "Provider Name", type: "text", order: 2 },
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
    { section: "Valuation & Fund Details", key: "fund_details", label: "Fund Details (Fund Name | ISIN/Sedol/Citi code | Units | Price/unit | Value | Fund Charge)", type: "free_text", order: 14 },
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
