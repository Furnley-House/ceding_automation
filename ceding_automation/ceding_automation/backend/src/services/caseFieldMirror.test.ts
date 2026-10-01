import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock the Prisma client used by the mirror. The gate behaviour (returning
// early when source="ai") doesn't need a real DB — if the gate fires it
// must NOT touch Prisma at all. The tests assert exactly that.
//
// vi.mock is hoisted above imports. Any shared mock fns must live inside
// vi.hoisted() so they're initialised in the same hoisted phase.
const mocks = vi.hoisted(() => ({
  caseFindUnique: vi.fn(),
  caseUpdate: vi.fn(),
  providerFindFirst: vi.fn(),
  providerCreate: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => ({
    case: { findUnique: mocks.caseFindUnique, update: mocks.caseUpdate },
    provider: { findFirst: mocks.providerFindFirst, create: mocks.providerCreate },
  })),
}));

// Import AFTER vi.mock so the mocked PrismaClient is in place.
import { mirrorChecklistToCase } from "./caseFieldMirror";

const { caseFindUnique, caseUpdate, providerFindFirst, providerCreate } = mocks;

beforeEach(() => {
  caseFindUnique.mockReset();
  caseUpdate.mockReset();
  providerFindFirst.mockReset();
  providerCreate.mockReset();
});

describe("mirrorChecklistToCase — source='ai' gate (boundary rule)", () => {
  it("source='ai' returns {changed:false} without touching the database for any fieldKey", async () => {
    // The whole point: AI never writes to case details. Test every mirrored
    // fieldKey — provider_name, plan_number, start_date — all return without
    // a single DB call when source='ai'.
    for (const fieldKey of ["provider_name", "plan_number", "start_date"]) {
      const result = await mirrorChecklistToCase("case-1", fieldKey, "Phoenix Life", "ai");
      expect(result).toEqual({ changed: false });
    }
    expect(caseFindUnique).not.toHaveBeenCalled();
    expect(caseUpdate).not.toHaveBeenCalled();
    expect(providerFindFirst).not.toHaveBeenCalled();
    expect(providerCreate).not.toHaveBeenCalled();
  });

  it("source='ai' gate fires BEFORE the empty-value guard — even with an obviously-empty value, no DB call", async () => {
    // Regression guard: previously the empty-value check came first; a
    // caller passing a non-empty value plus source='ai' would still pass
    // the empty-value guard and reach the switch. The gate must come first.
    await mirrorChecklistToCase("case-1", "provider_name", "Phoenix Life Limited", "ai");
    expect(caseFindUnique).not.toHaveBeenCalled();
  });

  it("source='ai' gate ignores fieldKey — even an unknown fieldKey returns {changed:false} without touching the DB", async () => {
    // Defensive: if someone later adds a new fieldKey to the switch, the
    // gate must still block it when source='ai' without any pre-switch
    // DB read.
    const result = await mirrorChecklistToCase("case-1", "some_new_field_added_later", "value", "ai");
    expect(result).toEqual({ changed: false });
    expect(caseFindUnique).not.toHaveBeenCalled();
  });
});

describe("mirrorChecklistToCase — source='ca' continues to work", () => {
  it("source='ca' with a value for an unmirrored fieldKey proceeds past the gate and hits the switch default", async () => {
    // Not strictly asserting a Case.update — just that the gate didn't
    // short-circuit. The findUnique call happens; the switch hits the
    // default branch; no update.
    caseFindUnique.mockResolvedValueOnce({
      id: "case-1",
      policyRef: null,
      planStartDate: null,
      providerId: null,
      provider: null,
    });
    const result = await mirrorChecklistToCase("case-1", "unmirrored_field", "value", "ca");
    expect(result).toEqual({ changed: false }); // default branch
    expect(caseFindUnique).toHaveBeenCalledOnce();
    expect(caseUpdate).not.toHaveBeenCalled();
  });

  it("source='ca' with an empty value early-returns (empty-value guard still in effect for CA path)", async () => {
    await mirrorChecklistToCase("case-1", "provider_name", "", "ca");
    await mirrorChecklistToCase("case-1", "provider_name", null, "ca");
    await mirrorChecklistToCase("case-1", "provider_name", "   ", "ca");
    expect(caseFindUnique).not.toHaveBeenCalled();
  });
});
