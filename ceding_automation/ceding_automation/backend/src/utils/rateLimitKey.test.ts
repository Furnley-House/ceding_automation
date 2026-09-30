import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { buildRateLimitKey } from "./rateLimitKey";

const SECRET = "test-secret-for-rate-limit-key";

function makeToken(payload: Record<string, unknown>, secret: string = SECRET): string {
  return jwt.sign(payload, secret);
}

describe("buildRateLimitKey", () => {
  it("returns user:<userId> for a valid Bearer JWT", () => {
    const token = makeToken({ userId: "user-abc" });
    expect(
      buildRateLimitKey({
        authHeader: `Bearer ${token}`,
        ip: "10.0.0.1",
        jwtSecret: SECRET,
      })
    ).toBe("user:user-abc");
  });

  it("falls back to ip:<ip> when there is no Authorization header", () => {
    expect(
      buildRateLimitKey({
        authHeader: undefined,
        ip: "10.0.0.2",
        jwtSecret: SECRET,
      })
    ).toBe("ip:10.0.0.2");
  });

  it("falls back to ip:<ip> when Authorization is not a Bearer scheme", () => {
    expect(
      buildRateLimitKey({
        authHeader: "Basic dXNlcjpwYXNz",
        ip: "10.0.0.3",
        jwtSecret: SECRET,
      })
    ).toBe("ip:10.0.0.3");
  });

  it("falls back to ip:<ip> when the JWT signature is invalid", () => {
    // Token signed with a different secret — verification must fail.
    const token = makeToken({ userId: "user-abc" }, "wrong-secret");
    expect(
      buildRateLimitKey({
        authHeader: `Bearer ${token}`,
        ip: "10.0.0.4",
        jwtSecret: SECRET,
      })
    ).toBe("ip:10.0.0.4");
  });

  it("falls back to ip:<ip> when the JWT is malformed", () => {
    expect(
      buildRateLimitKey({
        authHeader: "Bearer not.a.jwt",
        ip: "10.0.0.5",
        jwtSecret: SECRET,
      })
    ).toBe("ip:10.0.0.5");
  });

  it("falls back to ip:<ip> when the JWT verifies but has no userId claim", () => {
    // A token with no userId in the payload — we can't key by user.
    const token = makeToken({ email: "someone@example.com" });
    expect(
      buildRateLimitKey({
        authHeader: `Bearer ${token}`,
        ip: "10.0.0.6",
        jwtSecret: SECRET,
      })
    ).toBe("ip:10.0.0.6");
  });

  it("returns ip:unknown when both auth and ip are missing", () => {
    // express-rate-limit v7 requires a string, never undefined. This is the
    // last-resort key — treats "no signal at all" as one shared bucket.
    expect(
      buildRateLimitKey({
        authHeader: undefined,
        ip: undefined,
        jwtSecret: SECRET,
      })
    ).toBe("ip:unknown");
  });

  it("faked userId in an unsigned token does not get its own bucket (signature check enforces this)", () => {
    // Regression guard: if buildRateLimitKey ever drops jwt.verify in favour
    // of a plain decode, an attacker can rotate userIds to bypass the limit.
    // The unsigned "jwt" below decodes cleanly but has no valid signature.
    const [header, payload] = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ userId: "attacker" })).toString("base64url"),
    ];
    const unsigned = `${header}.${payload}.`;

    expect(
      buildRateLimitKey({
        authHeader: `Bearer ${unsigned}`,
        ip: "10.0.0.7",
        jwtSecret: SECRET,
      })
    ).toBe("ip:10.0.0.7");
  });
});
