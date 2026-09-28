import { describe, it, expect } from "vitest";
import { buildExportFileName } from "./exportFileName";

describe("buildExportFileName", () => {
  it("uses the team's previous format", () => {
    expect(buildExportFileName({ providerName: "Nest Pensions", clientName: "Amanda Pankhurst", policyNumber: "12345678" }))
      .toBe("Ceding Checklist – Nest Pensions – Amanda Pankhurst – 12345678.xlsx");
  });
  it("cleans characters Windows / WorkDrive reject (e.g. two policy refs)", () => {
    expect(buildExportFileName({ providerName: "Aegon Platform", clientName: "Guy Stanton", policyNumber: "8714659 / 714126" }))
      .toBe("Ceding Checklist – Aegon Platform – Guy Stanton – 8714659 714126.xlsx");
    expect(buildExportFileName({ providerName: 'A:B*C?"D<E>F|G\\H', clientName: "X", policyNumber: "1" }))
      .toBe("Ceding Checklist – A B C D E F G H – X – 1.xlsx");
  });
  it("leaves out missing parts instead of printing blanks", () => {
    expect(buildExportFileName({ providerName: "Aviva", clientName: "Barrie Addison", policyNumber: null }))
      .toBe("Ceding Checklist – Aviva – Barrie Addison.xlsx");
    expect(buildExportFileName({ providerName: "  ", clientName: "Barrie Addison", policyNumber: "TK1" }))
      .toBe("Ceding Checklist – Barrie Addison – TK1.xlsx");
  });
  it("falls back to the case ref when everything else is blank", () => {
    expect(buildExportFileName({ caseRef: "FH-2026-000143" })).toBe("Ceding Checklist – FH-2026-000143.xlsx");
  });
});
