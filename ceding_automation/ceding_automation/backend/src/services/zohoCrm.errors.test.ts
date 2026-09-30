import { describe, it, expect } from "vitest";
import { ZohoAuthError, ZohoContactNotFoundError } from "./zohoCrm";

describe("ZohoContactNotFoundError", () => {
  it("is an Error with a discriminating name and the contactZohoId preserved", () => {
    const err = new ZohoContactNotFoundError("contact-abc-123");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ZohoContactNotFoundError");
    expect(err.contactZohoId).toBe("contact-abc-123");
    // Message includes the id so log lines stay actionable when the
    // discriminated type gets stringified.
    expect(err.message).toContain("contact-abc-123");
  });

  it("is distinguishable from ZohoAuthError via instanceof", () => {
    // Regression guard: workdrive.ts resolveCaseFolderId's fall-through
    // depends on instanceof discrimination — if the two error classes ever
    // share a supertype other than Error, or one accidentally extends the
    // other, the auth branch would silently be treated as "contact missing"
    // and we'd be back to the KI-13-adjacent silent-swallow bug.
    expect(new ZohoContactNotFoundError("x") instanceof ZohoAuthError).toBe(false);
    expect(new ZohoAuthError() instanceof ZohoContactNotFoundError).toBe(false);
  });
});
