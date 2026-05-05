// Checklist field templates per plan type — sourced from Furnley House
// Ceding Checklist v5 (Pension / ISA / GIA only). Other plan types are
// out-of-scope and blocked at the case detail page.

export type FieldType = "text" | "number" | "currency" | "percent" | "yesno" | "date" | "select";

export interface ChecklistFieldDef {
  key: string;
  label: string;
  type: FieldType;
  section: string;
  options?: string[];
  required?: boolean;
  /** Optional condition: only show when another field equals one of these values */
  showIf?: { key: string; in: string[] };
  hint?: string;
}

/** Plan types we currently support end-to-end. Anything else is flagged. */
export const SUPPORTED_PLAN_TYPES = ["Personal Pension", "ISA", "GIA"] as const;
export type SupportedPlanType = (typeof SUPPORTED_PLAN_TYPES)[number];

export function isSupportedPlanType(planType: string | null | undefined): planType is SupportedPlanType {
  return !!planType && (SUPPORTED_PLAN_TYPES as readonly string[]).includes(planType);
}

const NOTES_FIELD: ChecklistFieldDef = {
  key: "other_notes",
  label: "Other Notes",
  type: "text",
  section: "Notes",
};

// ────────────────────────────────────────────────────────────
// Pension (Personal Pension / SIPP / Workplace etc.)
// ────────────────────────────────────────────────────────────
const PENSION_FIELDS: ChecklistFieldDef[] = [
  // Basic Details
  { key: "provider_name", label: "Provider Name", type: "text", section: "Basic Details", required: true },
  { key: "provider_contact", label: "Provider Telephone & Email", type: "text", section: "Basic Details" },
  { key: "plan_number", label: "Plan Number", type: "text", section: "Basic Details", required: true },
  { key: "pension_type", label: "Type of Pension (Personal Pension / SIPP / Other)", type: "text", section: "Basic Details", required: true },
  { key: "scheme_name", label: "Name of Policy / Scheme", type: "text", section: "Basic Details" },
  { key: "contract_or_trust", label: "Contract or Trust based?", type: "select", section: "Basic Details", options: ["Contract", "Trust"] },
  { key: "status", label: "Status (Inforce-Active / Paid up)", type: "select", section: "Basic Details", options: ["Inforce - Active", "Paid up"] },
  { key: "start_date", label: "Start Date", type: "date", section: "Basic Details" },
  { key: "nrd_age", label: "Normal Retirement Date / Age (Protected Retirement Age)", type: "text", section: "Basic Details", hint: "What age can client access benefits?" },
  { key: "inherited_pension", label: "Inherited Pension? (If yes, all/part? Taxable?)", type: "text", section: "Basic Details", hint: "If yes — notify PP/ADV immediately" },

  // Transaction History
  { key: "ongoing_personal_contrib", label: "Ongoing Regular Contributions — Personal (GROSS or NET)", type: "text", section: "Transaction History" },
  { key: "ongoing_employee_contrib", label: "Ongoing Regular Contributions — Employee", type: "text", section: "Transaction History" },
  { key: "ongoing_employer_contrib", label: "Ongoing Regular Contributions — Employer", type: "text", section: "Transaction History" },
  { key: "withdrawals", label: "Withdrawals (Regular / Lumpsum / Ongoing amount)", type: "text", section: "Transaction History" },
  { key: "pct_crystallised", label: "% Crystallised", type: "percent", section: "Transaction History" },
  { key: "tfc_taken", label: "Tax-free cash taken (£ and %)", type: "text", section: "Transaction History" },
  { key: "contrib_25_26", label: "Contributions 06/04/2025 – 05/04/2026 (Personal / Employer)", type: "text", section: "Transaction History" },
  { key: "contrib_24_25", label: "Contributions 06/04/2024 – 05/04/2025 (Personal / Employer)", type: "text", section: "Transaction History" },
  { key: "contrib_23_24", label: "Contributions 06/04/2023 – 05/04/2024 (Personal / Employer)", type: "text", section: "Transaction History" },
  { key: "contrib_22_23", label: "Contributions 06/04/2022 – 05/04/2023 (Personal / Employer)", type: "text", section: "Transaction History" },

  // Valuation & Fund Details
  { key: "current_value", label: "Current Value (with date)", type: "currency", section: "Valuation & Fund Details", required: true },
  { key: "transfer_value", label: "Transfer Value (and any bonuses if higher)", type: "currency", section: "Valuation & Fund Details" },
  { key: "loyalty_bonuses", label: "Loyalty / Other bonuses applied?", type: "text", section: "Valuation & Fund Details" },
  { key: "crystallised_uncrystallised", label: "Crystallised & Uncrystallised split", type: "text", section: "Valuation & Fund Details" },
  { key: "fund_details", label: "Fund Details (Name / ISIN / Units / Price / Value / Charge)", type: "text", section: "Valuation & Fund Details" },
  { key: "fund_range_link", label: "Range of funds available (link)", type: "text", section: "Valuation & Fund Details" },
  { key: "restricted_funds", label: "Any funds restricted for trading? Details", type: "text", section: "Valuation & Fund Details" },

  // With-Profit (only if invested in WP)
  { key: "wp_fund_isin", label: "With-Profit Fund Name & ISIN", type: "text", section: "With-Profit Funds" },
  { key: "wp_guaranteed_growth", label: "Guaranteed Growth Rate", type: "percent", section: "With-Profit Funds" },
  { key: "wp_ppfm", label: "PPFM", type: "text", section: "With-Profit Funds" },
  { key: "wp_historical_bonus", label: "Historical Bonus Rate", type: "text", section: "With-Profit Funds" },
  { key: "wp_mvr", label: "Market Value Reduction (MVR)", type: "text", section: "With-Profit Funds" },
  { key: "wp_terminal_bonus", label: "Terminal Bonus", type: "text", section: "With-Profit Funds" },

  // Charges
  { key: "platform_charge", label: "Platform Charge / Plan Charges", type: "percent", section: "Charges" },
  { key: "wrapper_charges", label: "Wrapper Charges", type: "percent", section: "Charges" },
  { key: "fund_charges_avg", label: "Fund Charges (Weighted Average)", type: "percent", section: "Charges" },
  { key: "transactional_fund_charge", label: "Transactional Fund Charge", type: "percent", section: "Charges" },
  { key: "advice_charges", label: "Advice Charges", type: "percent", section: "Charges" },
  { key: "exit_penalty", label: "Exit Charge / Penalty on Transfer", type: "text", section: "Charges" },
  { key: "discount_on_charges", label: "Discount on charges? Details", type: "text", section: "Charges" },
  { key: "other_charges", label: "Other charges (switch, bid/offer spread)", type: "text", section: "Charges" },

  // Guarantees
  { key: "gmp", label: "Guaranteed Minimum Pension (GMP)", type: "text", section: "Guarantees" },
  { key: "gar", label: "Guaranteed Annuity Rate (GAR)", type: "text", section: "Guarantees" },
  { key: "guaranteed_income", label: "Guaranteed Income", type: "text", section: "Guarantees" },
  { key: "guaranteed_capital", label: "Guaranteed Capital Value", type: "text", section: "Guarantees" },
  { key: "other_guarantees", label: "Other Guarantees", type: "text", section: "Guarantees" },
  { key: "protected_tfc", label: "Protected Tax-Free Cash", type: "text", section: "Guarantees" },
  { key: "waiver_of_premium", label: "Waiver of Premiums / Contributions", type: "yesno", section: "Guarantees" },
  { key: "additional_life_cover", label: "Additional Life Cover", type: "yesno", section: "Guarantees" },

  // A-Day (pre-06/04/2006 only)
  { key: "a_day_value", label: "A-Day Value", type: "currency", section: "A-Day (pre 06/04/2006 only)" },
  { key: "a_day_tfc", label: "A-Day Tax-Free Cash", type: "currency", section: "A-Day (pre 06/04/2006 only)" },
  { key: "current_basis_tfc", label: "Tax-Free Cash on Current Basis", type: "currency", section: "A-Day (pre 06/04/2006 only)" },

  // Benefits & Options
  { key: "drawdown_available", label: "Is drawdown facility available?", type: "yesno", section: "Benefits & Options" },
  { key: "drawdown_options", label: "Drawdown Options (FAD / UFPLS / Annuity in-house / Annuity OMO)", type: "text", section: "Benefits & Options" },
  { key: "fad_internal_transfer", label: "If FAD not available — can plan transfer internally to access it?", type: "yesno", section: "Benefits & Options" },
  { key: "origo_or_discharge", label: "Origo Option available OR Discharge forms required?", type: "text", section: "Benefits & Options" },
  { key: "partial_transfer", label: "Partial Transfer available? Min residual?", type: "text", section: "Benefits & Options" },
  { key: "lifestyling", label: "Lifestyling — available & active?", type: "text", section: "Benefits & Options" },
  { key: "death_benefits", label: "Death Benefits (Fund value payout / Beneficiary drawdown)", type: "text", section: "Benefits & Options" },
  { key: "benefits_before_75", label: "Must client take benefits before age 75?", type: "yesno", section: "Benefits & Options" },
  { key: "former_protected_rights", label: "Former Protected Rights? Value if yes", type: "text", section: "Benefits & Options" },
  { key: "pension_orders", label: "Pension sharing order / earmarking / bankruptcy?", type: "text", section: "Benefits & Options", hint: "If yes — notify PP/ADV immediately" },
  { key: "transfers_in", label: "Can external plans be transferred in?", type: "yesno", section: "Benefits & Options" },
  { key: "named_beneficiaries", label: "Named beneficiaries & % split", type: "text", section: "Benefits & Options" },
  { key: "in_specie_transfers", label: "Are in-specie transfers available if transferring away?", type: "yesno", section: "Benefits & Options" },

  NOTES_FIELD,
];

// ────────────────────────────────────────────────────────────
// ISA
// ────────────────────────────────────────────────────────────
const ISA_FIELDS: ChecklistFieldDef[] = [
  { key: "provider_name", label: "Provider Name", type: "text", section: "Basic Details", required: true },
  { key: "provider_contact", label: "Provider Telephone & Email", type: "text", section: "Basic Details" },
  { key: "plan_number", label: "Plan Number", type: "text", section: "Basic Details", required: true },
  { key: "isa_type", label: "Type of ISA", type: "select", section: "Basic Details", options: ["Stocks & Shares", "Cash", "Lifetime"], required: true },
  { key: "start_date", label: "Start Date", type: "date", section: "Basic Details" },
  { key: "flexible_isa", label: "Is this a 'Flexible ISA'?", type: "yesno", section: "Basic Details" },

  { key: "total_investment", label: "Total Investment", type: "currency", section: "Transaction History" },
  { key: "ongoing_contributions", label: "Ongoing Regular Contributions", type: "text", section: "Transaction History" },
  { key: "current_year_subs", label: "Current Year Subscriptions (Allowance used this tax year)", type: "currency", section: "Transaction History" },
  { key: "withdrawals", label: "Withdrawals (Regular / Lumpsum / Ongoing amount)", type: "text", section: "Transaction History" },

  { key: "current_value", label: "Current Value (with date)", type: "currency", section: "Valuation & Fund Details", required: true },
  { key: "transfer_value", label: "Transfer Value (if higher than CV, disclose why)", type: "currency", section: "Valuation & Fund Details" },
  { key: "fund_details", label: "Fund Details (Name / ISIN / Units / Price / Value / Charge)", type: "text", section: "Valuation & Fund Details" },
  { key: "fund_range_link", label: "Range of funds available (link)", type: "text", section: "Valuation & Fund Details" },
  { key: "restricted_funds", label: "Any funds restricted for trading? Details", type: "text", section: "Valuation & Fund Details" },

  { key: "wp_fund_isin", label: "With-Profit Fund Name & ISIN", type: "text", section: "With-Profit Funds" },
  { key: "wp_ppfm", label: "PPFM", type: "text", section: "With-Profit Funds" },
  { key: "wp_historical_bonus", label: "Historical Bonus Rate", type: "text", section: "With-Profit Funds" },
  { key: "wp_mvr", label: "Market Value Reduction (MVR)", type: "text", section: "With-Profit Funds" },

  { key: "platform_charge", label: "Platform Charge", type: "percent", section: "Charges" },
  { key: "fund_charges_avg", label: "Fund Charges (Weighted Average)", type: "percent", section: "Charges" },
  { key: "transactional_fund_charge", label: "Transactional Fund Charge", type: "percent", section: "Charges" },
  { key: "advice_charges", label: "Advice Charges", type: "percent", section: "Charges" },
  { key: "exit_penalty", label: "Exit Charge / Penalty on Transfer", type: "text", section: "Charges" },
  { key: "other_charges", label: "Other charges (switch, bid/offer spread)", type: "text", section: "Charges" },

  { key: "guarantees", label: "Any Guarantees applicable", type: "text", section: "Guarantees" },

  { key: "origo_available", label: "Origo Option available", type: "yesno", section: "Benefits & Options" },
  { key: "discharge_forms", label: "Discharge forms required", type: "text", section: "Benefits & Options" },
  { key: "transfer_systems", label: "Transfer systems used", type: "text", section: "Benefits & Options" },
  { key: "isa_aps_transfer", label: "ISA APS transfer for spouse beneficiary allowed?", type: "yesno", section: "Benefits & Options" },
  { key: "in_specie_transfers", label: "Are in-specie transfers available if transferring away?", type: "yesno", section: "Benefits & Options" },

  NOTES_FIELD,
];

// ────────────────────────────────────────────────────────────
// GIA
// ────────────────────────────────────────────────────────────
const GIA_FIELDS: ChecklistFieldDef[] = [
  { key: "single_or_joint", label: "Single or Joint client", type: "select", section: "Basic Details", options: ["Single", "Joint"], required: true },
  { key: "provider_name", label: "Provider Name", type: "text", section: "Basic Details", required: true },
  { key: "provider_contact", label: "Provider Telephone & Email", type: "text", section: "Basic Details" },
  { key: "plan_number", label: "Plan Number", type: "text", section: "Basic Details", required: true },
  { key: "start_date", label: "Start Date", type: "date", section: "Basic Details" },

  { key: "total_contributions", label: "Total Contributions", type: "currency", section: "Transaction History" },
  { key: "ongoing_contributions", label: "Ongoing Regular Contributions", type: "text", section: "Transaction History" },
  { key: "withdrawals", label: "Withdrawals", type: "text", section: "Transaction History" },
  { key: "contributions_this_tax_year", label: "Contributions made this tax year", type: "currency", section: "Transaction History" },
  { key: "gain_loss_pct", label: "Gain / Loss % currently on plan", type: "percent", section: "Transaction History" },

  { key: "current_value", label: "Current Value (with date)", type: "currency", section: "Valuation & Fund Details", required: true },
  { key: "transfer_value", label: "Transfer Value", type: "currency", section: "Valuation & Fund Details" },
  { key: "transfer_value_reason", label: "Reason if transfer value differs from current value", type: "text", section: "Valuation & Fund Details" },
  { key: "fund_details", label: "Fund Details (Name / ISIN / Units / Price / Value / Charge)", type: "text", section: "Valuation & Fund Details" },
  { key: "fund_range_link", label: "Range of funds available (link)", type: "text", section: "Valuation & Fund Details" },
  { key: "restricted_funds", label: "Any funds restricted for trading? Details", type: "text", section: "Valuation & Fund Details" },

  { key: "wp_fund_isin", label: "With-Profit Fund Name & ISIN", type: "text", section: "With-Profit Funds" },
  { key: "wp_ppfm", label: "PPFM", type: "text", section: "With-Profit Funds" },
  { key: "wp_historical_bonus", label: "Historical Bonus Rate", type: "text", section: "With-Profit Funds" },
  { key: "wp_mvr", label: "Market Value Reduction (MVR)", type: "text", section: "With-Profit Funds" },

  { key: "platform_wrapper_charge", label: "Platform Charge / Wrapper Charge", type: "percent", section: "Charges" },
  { key: "fund_charges_avg", label: "Fund Charges (Weighted Average) + Base cost of funds", type: "percent", section: "Charges" },
  { key: "transactional_fund_charge", label: "Transactional Fund Charge", type: "percent", section: "Charges" },
  { key: "advice_charges", label: "Advice Charges", type: "percent", section: "Charges" },
  { key: "exit_penalty", label: "Exit Charge / Penalty on Transfer", type: "text", section: "Charges" },
  { key: "setup_fees_adviser", label: "Setup fees paid to adviser (offset against CGT)", type: "currency", section: "Charges" },
  { key: "other_charges", label: "Other charges (switch, bid/offer spread)", type: "text", section: "Charges" },

  { key: "guarantees", label: "Any Guarantees applicable", type: "text", section: "Guarantees" },

  { key: "origo_available", label: "Origo Option available", type: "yesno", section: "Benefits & Options" },
  { key: "discharge_forms", label: "Discharge forms required", type: "text", section: "Benefits & Options" },
  { key: "cgt_gain_report", label: "Unrealised & Realised gain report provided (for CGT)", type: "yesno", section: "Benefits & Options" },
  { key: "in_specie_transfers", label: "Are in-specie transfers available if transferring away?", type: "yesno", section: "Benefits & Options" },

  NOTES_FIELD,
];

export const CHECKLIST_TEMPLATES: Record<string, ChecklistFieldDef[]> = {
  "Personal Pension": PENSION_FIELDS,
  ISA: ISA_FIELDS,
  GIA: GIA_FIELDS,
};

export function getTemplate(planType: string): ChecklistFieldDef[] {
  return CHECKLIST_TEMPLATES[planType] ?? [];
}

/** Section ordering preserved as encountered in the template */
export function groupBySection(fields: ChecklistFieldDef[]): { section: string; fields: ChecklistFieldDef[] }[] {
  const order: string[] = [];
  const map: Record<string, ChecklistFieldDef[]> = {};
  for (const f of fields) {
    if (!map[f.section]) {
      map[f.section] = [];
      order.push(f.section);
    }
    map[f.section].push(f);
  }
  return order.map((s) => ({ section: s, fields: map[s] }));
}
