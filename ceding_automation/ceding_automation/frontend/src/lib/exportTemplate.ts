// frontend/src/lib/exportTemplate.ts
// Stage 9 export builder — loads the Furnley House "Ceding Checklist" template
// (public/templates/ceding-checklist-template.xlsx), populates the sheet that
// matches the case's plan type, and returns a styled .xlsx blob.
//
// Uses ExcelJS (not SheetJS) because SheetJS Community Edition strips styles
// on load/save; ExcelJS preserves the template's merges, column widths, fonts,
// bold section headers, and multi-line labels.
//
// The template has three sheets (Pension / ISA / GIA). At export time we keep
// only the sheet for the case's plan type and drop the other two, so the
// downloaded workbook is single-sheet-per-case (matching Furnley's convention).

import ExcelJS from "exceljs";

// ── Cell mappings per plan type ────────────────────────────────────────────
//
// For each row in the template that carries an answerable question in column
// A, we point the canonical checklist field key at the row number. At build
// time we write the value into cell B{row} — which in the template is merged
// across B..G — so the value flows the full answer-cell width.
//
// Rows that DON'T map (section headers, sub-headers, or template-only prose
// like the 4-column tax-year contributions grid) are intentionally omitted;
// the template's styling stays visible with an empty answer cell.

export interface FieldRowMapping {
  /** Canonical checklist field key (matches shared-contracts/checklist-fields-v1.json). */
  fieldKey: string;
  /** 1-based row number in the template sheet. */
  row: number;
}

const PENSION_ROWS: FieldRowMapping[] = [
  // Basic Details
  { fieldKey: "provider_name", row: 2 },
  { fieldKey: "provider_contact", row: 3 },
  { fieldKey: "plan_number", row: 4 },
  { fieldKey: "pension_type", row: 5 },
  { fieldKey: "scheme_name", row: 6 },
  { fieldKey: "contract_or_trust_based", row: 7 },
  { fieldKey: "status", row: 8 },
  { fieldKey: "start_date", row: 9 },
  { fieldKey: "normal_retirement_date", row: 10 },
  { fieldKey: "inherited_pension", row: 11 },
  // Transaction History
  { fieldKey: "regular_contribution_personal", row: 14 },
  { fieldKey: "regular_contribution_employee", row: 15 },
  { fieldKey: "regular_contribution_employer", row: 16 },
  { fieldKey: "withdrawal_details", row: 17 },
  { fieldKey: "percent_crystallised", row: 18 },
  { fieldKey: "tax_free_cash_taken", row: 19 },
  { fieldKey: "contributions_4yr_history", row: 20 },
  // Valuation & Fund Details
  { fieldKey: "current_value", row: 24 },
  { fieldKey: "transfer_value", row: 25 },
  { fieldKey: "loyalty_bonuses", row: 26 },
  { fieldKey: "crystallised_uncrystallised", row: 27 },
  // Fund Details block occupies rows 28–32 (handled by writeFundLines)
  { fieldKey: "fund_range_link", row: 33 },
  { fieldKey: "restricted_funds", row: 34 },
  // With-profits
  { fieldKey: "wp_fund_names_isin", row: 37 },
  { fieldKey: "wp_guaranteed_growth_rate", row: 38 },
  { fieldKey: "wp_ppfm", row: 39 },
  { fieldKey: "wp_historical_bonus_rate", row: 40 },
  { fieldKey: "wp_market_value_reduction", row: 41 },
  { fieldKey: "wp_terminal_bonus", row: 42 },
  // Charges
  { fieldKey: "platform_charge", row: 45 },
  { fieldKey: "wrapper_charge", row: 46 },
  { fieldKey: "fund_charges_weighted", row: 47 },
  { fieldKey: "transactional_fund_charge", row: 48 },
  { fieldKey: "advice_charges", row: 49 },
  { fieldKey: "exit_charge", row: 50 },
  { fieldKey: "charge_discount", row: 51 },
  { fieldKey: "other_charges", row: 52 },
  // Guarantees
  { fieldKey: "guaranteed_minimum_pension", row: 55 },
  { fieldKey: "guaranteed_annuity_rate", row: 56 },
  { fieldKey: "guaranteed_income", row: 57 },
  { fieldKey: "guaranteed_capital_value", row: 58 },
  { fieldKey: "any_guarantees", row: 59 },
  { fieldKey: "protected_tax_free_cash", row: 60 },
  { fieldKey: "waiver_of_premiums", row: 61 },
  { fieldKey: "additional_life_cover", row: 62 },
  // Protected tax free cash (A-Day)
  { fieldKey: "a_day_value", row: 65 },
  { fieldKey: "a_day_tax_free_cash", row: 66 },
  { fieldKey: "current_tax_free_cash", row: 67 },
  // Benefits & Options
  { fieldKey: "drawdown_facility_available", row: 70 },
  { fieldKey: "drawdown_options", row: 71 },
  { fieldKey: "internal_transfer_for_fad", row: 72 },
  { fieldKey: "origo_option_available", row: 73 },
  { fieldKey: "partial_transfer_available", row: 74 },
  { fieldKey: "lifestyling", row: 75 },
  { fieldKey: "death_benefits", row: 76 },
  { fieldKey: "benefits_before_75", row: 77 },
  { fieldKey: "former_protected_rights", row: 78 },
  { fieldKey: "pension_sharing_order", row: 79 },
  { fieldKey: "external_transfer_in_allowed", row: 80 },
  { fieldKey: "named_beneficiaries", row: 81 },
  { fieldKey: "in_specie_transfer_out", row: 82 },
];

const ISA_ROWS: FieldRowMapping[] = [
  // Basic Details
  { fieldKey: "provider_name", row: 2 },
  { fieldKey: "provider_contact", row: 3 },
  { fieldKey: "plan_number", row: 4 },
  { fieldKey: "isa_type", row: 5 },
  { fieldKey: "start_date", row: 6 },
  { fieldKey: "is_flexible_isa", row: 7 },
  // Transaction History
  { fieldKey: "total_investment", row: 10 },
  { fieldKey: "ongoing_regular_contributions", row: 11 },
  { fieldKey: "current_year_subscriptions", row: 12 },
  { fieldKey: "withdrawal_details", row: 13 },
  // Valuation & Fund Details
  { fieldKey: "current_value", row: 16 },
  { fieldKey: "transfer_value", row: 17 },
  // Fund Details block occupies rows 18–22
  { fieldKey: "fund_range_link", row: 23 },
  { fieldKey: "restricted_funds", row: 24 },
  // With-profits
  { fieldKey: "wp_fund_names_isin", row: 27 },
  { fieldKey: "wp_ppfm", row: 28 },
  { fieldKey: "wp_historical_bonus_rate", row: 29 },
  { fieldKey: "wp_market_value_reduction", row: 30 },
  // Charges
  { fieldKey: "platform_charge", row: 33 },
  { fieldKey: "fund_charges_weighted", row: 34 },
  { fieldKey: "transactional_fund_charge", row: 35 },
  { fieldKey: "advice_charges", row: 36 },
  { fieldKey: "exit_charge", row: 37 },
  { fieldKey: "other_charges", row: 38 },
  // Guarantees
  { fieldKey: "any_guarantees", row: 41 },
  // Benefits & Options
  { fieldKey: "origo_option_available", row: 44 },
  { fieldKey: "discharge_forms", row: 45 },
  { fieldKey: "transfer_systems", row: 46 },
  { fieldKey: "isa_aps_transfer", row: 47 },
  { fieldKey: "in_specie_transfer_out", row: 48 },
  { fieldKey: "other_notes", row: 49 },
];

const GIA_ROWS: FieldRowMapping[] = [
  // Basic Details
  { fieldKey: "single_or_joint", row: 2 },
  { fieldKey: "provider_name", row: 3 },
  { fieldKey: "provider_contact", row: 4 },
  { fieldKey: "plan_number", row: 5 },
  { fieldKey: "start_date", row: 6 },
  // Transaction History
  { fieldKey: "total_contributions", row: 9 },
  { fieldKey: "ongoing_regular_contributions", row: 10 },
  { fieldKey: "withdrawal_details", row: 11 },
  { fieldKey: "current_year_contributions", row: 12 },
  { fieldKey: "gain_loss_percent", row: 13 },
  // Valuation & Fund Details
  { fieldKey: "current_value", row: 16 },
  { fieldKey: "transfer_value", row: 17 },
  { fieldKey: "transfer_value_variance_reason", row: 18 },
  // Fund Details block occupies rows 19–23
  { fieldKey: "fund_range_link", row: 24 },
  { fieldKey: "restricted_funds", row: 25 },
  // With-profits
  { fieldKey: "wp_fund_names_isin", row: 28 },
  { fieldKey: "wp_ppfm", row: 29 },
  { fieldKey: "wp_historical_bonus_rate", row: 30 },
  { fieldKey: "wp_market_value_reduction", row: 31 },
  // Charges
  { fieldKey: "platform_charge", row: 34 },
  { fieldKey: "fund_charges_weighted", row: 35 },
  { fieldKey: "transactional_fund_charge", row: 36 },
  { fieldKey: "advice_charges", row: 37 },
  { fieldKey: "exit_charge", row: 38 },
  { fieldKey: "adviser_setup_fees", row: 39 },
  { fieldKey: "other_charges", row: 40 },
  // Guarantees
  { fieldKey: "any_guarantees", row: 43 },
  // Benefits & Options
  { fieldKey: "origo_option_available", row: 46 },
  { fieldKey: "discharge_forms", row: 47 },
  { fieldKey: "cgt_gain_loss_report", row: 48 },
  { fieldKey: "in_specie_transfer_out", row: 49 },
  { fieldKey: "other_notes", row: 50 },
];

// ── Fund-details row ranges per plan type ──────────────────────────────────
// The template reserves a fixed block of rows for the per-fund table (label
// merged in column A, headers in row N in columns B–G, then data rows). If
// the case has more fund lines than the block, the overflow is appended
// after the block in plain unstyled rows.

interface FundBlock {
  labelRow: number;     // "Fund Details" label anchor (merged in col A)
  headerRow: number;    // where the column headers live (B..G)
  firstDataRow: number; // first row that gets fund-line data
  reservedRows: number; // how many data rows the template pre-styles
}

const FUND_BLOCKS: Record<string, FundBlock> = {
  PENSION: { labelRow: 28, headerRow: 28, firstDataRow: 29, reservedRows: 4 },
  ISA:     { labelRow: 18, headerRow: 18, firstDataRow: 19, reservedRows: 4 },
  GIA:     { labelRow: 19, headerRow: 19, firstDataRow: 20, reservedRows: 4 },
};

const ROWS_BY_PLAN: Record<string, FieldRowMapping[]> = {
  PENSION: PENSION_ROWS,
  ISA: ISA_ROWS,
  GIA: GIA_ROWS,
};

// ── Public interface ───────────────────────────────────────────────────────

export interface ExportChecklistRow {
  field_key: string;
  value: string | null;
  confidence?: string | null;
  status?: string | null;
}

export interface ExportFundLine {
  fundName: string;
  isinSedolCiti: string | null;
  numberOfUnits: string | null;
  pricePerUnit: string | null;
  value: string | null;
  ocf: string | null;
  transactionCosts: string | null;
  isWithProfits: boolean;
}

export interface ExportAuditRow {
  timestamp: string;
  field: string;
  action: string;
  actor: string;
  old_value: string;
  new_value: string;
}

export interface ExportInput {
  planType: "PENSION" | "ISA" | "GIA";
  caseRef: string;
  clientName: string;
  fields: ExportChecklistRow[];
  fundLines: ExportFundLine[];
  auditRows: ExportAuditRow[];
}

// ── Builder ────────────────────────────────────────────────────────────────

/**
 * Load the template, populate the case's plan-type sheet, and return the
 * workbook as a Uint8Array ready to be wrapped in a Blob or downloaded.
 *
 * The Fund Details block is populated per FUND_BLOCKS above; if more fund
 * lines exist than the template has reserved rows, the overflow is written
 * to plain rows after the reserved block (unstyled but present).
 *
 * A separate "Audit Trail" sheet is appended at the end for compliance —
 * the reference template doesn't have one but the app has always shipped it.
 */
export async function buildStyledExport(input: ExportInput): Promise<Uint8Array> {
  const resp = await fetch("/templates/ceding-checklist-template.xlsx", {
    cache: "no-cache",
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to load export template (${resp.status} ${resp.statusText}). ` +
      `Check /templates/ceding-checklist-template.xlsx is deployed.`,
    );
  }
  const buf = await resp.arrayBuffer();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  // Find the sheet matching the case's plan type (case-insensitive), and
  // drop the other two so the user gets a single-sheet workbook.
  const targetSheetName = capitalise(input.planType); // "Pension" / "Isa" / "Gia"
  const keep = wb.worksheets.find(
    (ws) => ws.name.toUpperCase() === input.planType.toUpperCase(),
  );
  if (!keep) {
    throw new Error(
      `Template is missing a "${targetSheetName}" sheet. ` +
      `Check the template file — expected sheets: Pension, ISA, GIA.`,
    );
  }
  // Remove the other plan-type sheets first (must be done after we've captured
  // `keep`, since removeWorksheet mutates the collection).
  for (const ws of [...wb.worksheets]) {
    if (ws.id === keep.id) continue;
    wb.removeWorksheet(ws.id);
  }

  // ── Populate scalar fields ───────────────────────────────────────────────
  const byKey = new Map(input.fields.map((f) => [f.field_key, f]));
  const mapping = ROWS_BY_PLAN[input.planType] ?? [];
  for (const m of mapping) {
    const row = byKey.get(m.fieldKey);
    const value = row ? formatFieldValue(row) : "";
    // Anchor cell is B{row}. The template merges B..G on that row, so we
    // only need to write the top-left; ExcelJS writes into merged cells by
    // targeting the anchor.
    keep.getCell(`B${m.row}`).value = value;
  }

  // ── Populate Fund Details ───────────────────────────────────────────────
  const block = FUND_BLOCKS[input.planType];
  if (block) writeFundLines(keep, block, input.fundLines);

  // ── Append Audit Trail sheet ─────────────────────────────────────────────
  const auditWs = wb.addWorksheet("Audit Trail");
  auditWs.columns = [
    { header: "Timestamp", key: "timestamp", width: 22 },
    { header: "Field", key: "field", width: 40 },
    { header: "Action", key: "action", width: 18 },
    { header: "Actor", key: "actor", width: 22 },
    { header: "Old value", key: "old_value", width: 30 },
    { header: "New value", key: "new_value", width: 30 },
  ];
  auditWs.getRow(1).font = { bold: true };
  input.auditRows.forEach((r) => auditWs.addRow(r));

  // Set case metadata as workbook properties — visible in Excel's File → Info
  // → Properties. Not strictly required but useful for CAs verifying which
  // case a downloaded file belongs to without opening it.
  wb.title = `Ceding Checklist — ${input.clientName} (${input.caseRef})`;
  wb.subject = `Plan type: ${targetSheetName}`;
  wb.company = "Furnley House Financial Planning Partners";

  return (await wb.xlsx.writeBuffer()) as Uint8Array;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function capitalise(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Turn a checklist row into a display string suitable for the answer cell.
 * "Missing" and empty values render as "—" so the sheet looks polished
 * rather than showing raw NULLs / empty strings.
 */
function formatFieldValue(row: ExportChecklistRow): string {
  const v = row.value;
  if (v === null || v === undefined) return "—";
  const trimmed = String(v).trim();
  if (!trimmed) return "—";
  if (trimmed.toUpperCase() === "MISSING") return "—";
  return trimmed;
}

/** Format a numeric-looking string as £X,XXX.XX or pass through as-is. */
function gbp(s: string | null): string {
  if (s === null || s === undefined || s === "") return "";
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 2,
  }).format(n);
}

function numeric(s: string | null): string {
  if (s === null || s === undefined || s === "") return "";
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 }).format(n);
}

/**
 * Format the "Fund charge" column as `OCF% (+TC%)` when both are present,
 * or a single value if only one exists. The reference template has a single
 * "Fund charge" column (G), so combining is the least invasive way to carry
 * both bits of data without extending the sheet layout.
 */
function fundCharge(ocf: string | null, tc: string | null): string {
  const ocfNum = ocf && Number.isFinite(Number(ocf)) ? Number(ocf) : null;
  const tcNum = tc && Number.isFinite(Number(tc)) ? Number(tc) : null;
  if (ocfNum === null && tcNum === null) return "";
  if (ocfNum !== null && tcNum !== null) {
    return `${ocfNum.toFixed(2)}% (+${tcNum.toFixed(2)}% TC)`;
  }
  return `${(ocfNum ?? tcNum)!.toFixed(2)}%`;
}

/**
 * Write per-fund data into the template's Fund Details block. Data goes into
 * columns B (Fund Name), C (ISIN), D (Units), E (Price), F (Value), G (Fund
 * charge). The template's row N is the header; rows N+1..N+reservedRows are
 * pre-styled data slots. Overflow (rare) lands in plain rows after the block.
 */
function writeFundLines(
  ws: ExcelJS.Worksheet,
  block: FundBlock,
  lines: ExportFundLine[],
): void {
  const reserved = block.reservedRows;
  for (let i = 0; i < Math.min(lines.length, reserved); i++) {
    const f = lines[i];
    const rowNum = block.firstDataRow + i;
    ws.getCell(`B${rowNum}`).value = f.fundName || "";
    ws.getCell(`C${rowNum}`).value = f.isinSedolCiti ?? "";
    ws.getCell(`D${rowNum}`).value = numeric(f.numberOfUnits);
    ws.getCell(`E${rowNum}`).value = gbp(f.pricePerUnit);
    ws.getCell(`F${rowNum}`).value = gbp(f.value);
    ws.getCell(`G${rowNum}`).value = fundCharge(f.ocf, f.transactionCosts);
  }
  // Overflow: append below the reserved block. These rows will lack the
  // template's cell borders / fills but at least the data is present.
  if (lines.length > reserved) {
    let rowNum = block.firstDataRow + reserved;
    for (let i = reserved; i < lines.length; i++) {
      const f = lines[i];
      ws.getCell(`B${rowNum}`).value = f.fundName || "";
      ws.getCell(`C${rowNum}`).value = f.isinSedolCiti ?? "";
      ws.getCell(`D${rowNum}`).value = numeric(f.numberOfUnits);
      ws.getCell(`E${rowNum}`).value = gbp(f.pricePerUnit);
      ws.getCell(`F${rowNum}`).value = gbp(f.value);
      ws.getCell(`G${rowNum}`).value = fundCharge(f.ocf, f.transactionCosts);
      rowNum++;
    }
  }
}
