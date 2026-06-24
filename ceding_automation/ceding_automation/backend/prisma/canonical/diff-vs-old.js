// One-off helper: compute canonical-vs-old-seed diff WITHOUT a DB.
// Old key lists are transcribed from the inline literal arrays that lived
// in seed.ts before the refactor (now replaced by JSON loader).
// This emulates what `npx tsx prisma/seed.ts --dry-run` would print
// when run against a DB that's been seeded by the OLD code path.

const fs = require("fs");
const path = require("path");

const canonical = JSON.parse(
  fs.readFileSync(path.join(__dirname, "checklist-fields-v1.json"), "utf8"),
);

const old = {
  ISA: [
    "Provider_group", "provider_phone_email", "plan_number", "isa_type",
    "start_date", "is_flexible_isa", "total_investment", "regular_contribution",
    "current_tax_year_contribution", "withdrawal_details", "current_value",
    "transfer_value", "fund_range_link", "restricted_funds", "wp_fund_names_isin",
    "wp_ppfm", "wp_historical_bonus_rate", "wp_mvr", "platform_charge",
    "fund_charges_weighted", "transactional_fund_charge", "advice_charges",
    "exit_charge", "other_charges", "any_guarantees", "origo_option",
    "discharge_forms", "transfer_systems", "isa_aps_transfer",
    "in_specie_transfer_out", "other_notes",
  ],
  GIA: [
    "single_or_joint", "Provider_group", "provider_phone_email", "plan_number",
    "start_date", "total_contributions", "regular_contribution",
    "withdrawal_details", "current_tax_year_contribution", "gain_loss_pct",
    "current_value", "transfer_value", "transfer_value_difference_reason",
    "fund_range_link", "restricted_funds", "wp_fund_names_isin", "wp_ppfm",
    "wp_historical_bonus_rate", "wp_mvr", "platform_charge",
    "fund_charges_weighted", "transactional_fund_charge", "advice_charges",
    "exit_charge", "setup_fees_to_adviser", "other_charges", "any_guarantees",
    "origo_option", "discharge_forms", "realised_unrealised_gain_report",
    "in_specie_transfer_out", "other_notes",
  ],
  PENSION: [
    "Provider_group", "provider_phone_email", "plan_number", "pension_type",
    "scheme_name", "contract_or_trust", "plan_status", "start_date",
    "normal_retirement_date", "is_inherited_pension", "contribution_personal",
    "contribution_employee", "contribution_employer", "withdrawal_details",
    "pct_crystallised", "tax_free_cash", "tax_year_2025_2026",
    "tax_year_2024_2025", "tax_year_2023_2024", "tax_year_2022_2023",
    "employer_personal_breakdown", "current_value", "transfer_value",
    "loyalty_bonuses", "crystallised_split", "fund_range_link",
    "restricted_funds", "wp_fund_names_isin", "wp_guaranteed_growth_rate",
    "wp_ppfm", "wp_historical_bonus_rate", "wp_mvr", "wp_terminal_bonus",
    "platform_charge", "wrapper_charges", "fund_charges_weighted",
    "transactional_fund_charge", "advice_charges", "exit_charge",
    "discount_on_charges", "other_charges", "gmp", "gar", "guaranteed_income",
    "guaranteed_capital_value", "other_guarantees", "protected_tax_free_cash",
    "waiver_of_premium", "additional_life_cover", "a_day_value",
    "a_day_tax_free_cash", "current_tax_free_cash", "drawdown_available",
    "drawdown_options", "transfer_internal_for_fad", "origo_or_discharge",
    "partial_transfer_facility", "lifestyling", "death_benefits",
    "benefits_before_75", "former_protected_rights",
    "pension_subject_to_orders", "external_transfers_in",
    "named_beneficiaries_split", "in_specie_transfer_out",
  ],
};

console.log(`[offline-diff] canonical v${canonical.version}`);
console.log(`[offline-diff] Comparing canonical vs OLD inline seed (what staging currently has)\n`);

for (const planKey of ["ISA", "GIA", "PENSION"]) {
  const canonicalKeys = canonical.plans[planKey].map((f) => f.key);
  const oldKeys = old[planKey];
  const canonicalSet = new Set(canonicalKeys);
  const oldSet = new Set(oldKeys);

  const inserts = canonicalKeys.filter((k) => !oldSet.has(k));
  const updates = canonicalKeys.filter((k) => oldSet.has(k));
  const deactivations = oldKeys.filter((k) => !canonicalSet.has(k));

  const preview = deactivations.slice(0, 6).join(", ");
  const more = deactivations.length > 6 ? `, +${deactivations.length - 6} more` : "";

  console.log(
    `  ${planKey.padEnd(8)} inserts=${inserts.length}  updates=${updates.length}  deactivations=${deactivations.length}` +
      (deactivations.length > 0 ? `  (${preview}${more})` : ""),
  );
  if (inserts.length > 0) {
    console.log(`    NEW KEYS: ${inserts.join(", ")}`);
  }
  if (deactivations.length > 0) {
    console.log(`    DEACTIVATE: ${deactivations.join(", ")}`);
  }
  console.log("");
}
