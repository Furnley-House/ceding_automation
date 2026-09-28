// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import { buildStyledExport, type ExportInput } from "./exportTemplate";

const TEMPLATE = readFileSync(resolve(__dirname, "../../public/templates/ceding-checklist-template.xlsx"));

beforeAll(() => {
  // buildStyledExport fetches the template from /templates/…; serve the real file.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(TEMPLATE)));
});

async function build(input: Partial<ExportInput> & Pick<ExportInput, "planType">) {
  const out = await buildStyledExport({
    caseRef: "FH-TEST", clientName: "Test", fields: [], fundLines: [], auditRows: [], ...input,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out as unknown as ArrayBuffer);
  return wb.worksheets[0];
}

const merged = (ws: ExcelJS.Worksheet, r: number) => ws.getCell(`B${r}`).isMerged && ws.getCell(`G${r}`).isMerged;

describe("buildStyledExport", () => {
  it("merges every answer row B:G that the template left split", async () => {
    const pension = await build({ planType: "PENSION", fields: [{ field_key: "fund_charges_weighted", value: "1.0%" }] });
    for (const r of [6, 7, 25, 26, 47, 51]) expect(merged(pension, r), `Pension row ${r}`).toBe(true);
    expect(pension.getCell("B47").value).toBe("1.0%");
    expect(merged(await build({ planType: "ISA" }), 34)).toBe(true);
    const gia = await build({ planType: "GIA" });
    for (const r of [48, 49]) expect(merged(gia, r), `GIA row ${r}`).toBe(true);
  });

  it("uses one answer colour right of column A (no red / black)", async () => {
    const ws = await build({ planType: "PENSION", fields: [
      { field_key: "inherited_pension", value: "No" },          // B11 is red + bold in the template
      { field_key: "normal_retirement_date", value: "2032" },  // B10 is black in the template
    ] });
    const bad: string[] = [];
    ws.eachRow((row) => row.eachCell((cell, col) => {
      if (col < 2) return;
      if (cell.font?.color?.argb !== "FF4B4777") bad.push(`${cell.address}=${cell.font?.color?.argb ?? "none"}`);
    }));
    expect(bad).toEqual([]);
    expect(ws.getCell("B11").font?.bold).toBe(true); // colour only — template bold kept
    // Column A (questions) must keep the template's own colours — ExcelJS
    // shares style objects, so a careless font write on B bleeds into A.
    const template = new ExcelJS.Workbook();
    await template.xlsx.load(TEMPLATE as unknown as ArrayBuffer);
    const tws = template.getWorksheet("Pension")!;
    const changedA: string[] = [];
    for (let r = 1; r <= 83; r++) {
      const before = tws.getCell(`A${r}`).font?.color?.argb ?? null;
      const after = ws.getCell(`A${r}`).font?.color?.argb ?? null;
      if (before !== after) changedA.push(`A${r}: ${before} -> ${after}`);
    }
    expect(changedA).toEqual([]);
  });

  it("writes Employer and Personal per tax year into row 21", async () => {
    const ws = await build({ planType: "PENSION", contributions: [
      { position: 1, taxYearLabel: "2026/27", amount: null, employer: null, personal: "£214.80" },
      { position: 2, taxYearLabel: "2025/26", amount: null, employer: "N/A", personal: "£429.60" },
      { position: 3, taxYearLabel: "2024/25", amount: null, employer: "£0.00", personal: "£429.60" },
      { position: 4, taxYearLabel: "2023/24", amount: null, employer: null, personal: "£429.60" },
    ] });
    expect([ws.getCell("B20").value, ws.getCell("C20").value, ws.getCell("D20").value, ws.getCell("F20").value])
      .toEqual(["2026/27", "2025/26", "2024/25", "2023/24"]);
    expect(ws.getCell("B21").value).toBe("Employer: —\nPersonal: £214.80");
    expect(ws.getCell("C21").value).toBe("Employer: N/A\nPersonal: £429.60");
    expect(ws.getCell("D21").value).toBe("Employer: £0.00\nPersonal: £429.60");
    expect(ws.getCell("F21").value).toBe("Employer: —\nPersonal: £429.60");
    expect(ws.getCell("C21").isMerged).toBe(false); // per-year grid is not collapsed into B:G
  });

  it("keeps the legacy free-text contributions when the grid is empty", async () => {
    const ws = await build({ planType: "PENSION",
      fields: [{ field_key: "contributions_4yr_history", value: "2024/2025: £500" }],
      contributions: [1, 2, 3, 4].map((p) => ({ position: p, taxYearLabel: `Y${p}`, amount: null, employer: null, personal: null })),
    });
    expect(ws.getCell("B21").value).toBe("2024/2025: £500");
    expect(merged(ws, 21)).toBe(true);
  });

  it("puts the valuation date on a new line under Current / Transfer Value", async () => {
    for (const [planType, cvRow, tvRow] of [["PENSION", 24, 25], ["ISA", 16, 17], ["GIA", 16, 17]] as const) {
      const ws = await build({ planType, fields: [
        { field_key: "current_value", value: "£167,162.29" },
        { field_key: "current_value_as_of", value: "2026-06-01" },
        { field_key: "transfer_value", value: "£167,000.00" },
        { field_key: "transfer_value_as_of", value: "2026-06-15T00:00:00.000Z" },
      ] });
      expect(ws.getCell(`B${cvRow}`).value, planType).toBe("£167,162.29\nAs at 01/06/2026");
      expect(ws.getCell(`B${tvRow}`).value, planType).toBe("£167,000.00\nAs at 15/06/2026");
      expect(ws.getCell(`B${cvRow}`).alignment?.wrapText).toBe(true);
    }
  });

  it("leaves the value alone when there is no valuation date", async () => {
    const ws = await build({ planType: "PENSION", fields: [{ field_key: "current_value", value: "£10.00" }] });
    expect(ws.getCell("B24").value).toBe("£10.00");
  });
});
