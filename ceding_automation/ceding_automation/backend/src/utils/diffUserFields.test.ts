import { describe, it, expect } from "vitest";
import { diffUserFields, type UserAuditableSnapshot } from "./diffUserFields";

const BASE: UserAuditableSnapshot = {
  role: "CA_TEAM",
  status: "ACTIVE",
  canAccessAiTraining: false,
};

describe("diffUserFields", () => {
  it("no-op PATCH with identical values produces zero records", () => {
    expect(diffUserFields(BASE, { ...BASE })).toEqual([]);
  });

  it("PATCH with empty after (no audited fields sent) produces zero records", () => {
    expect(diffUserFields(BASE, {})).toEqual([]);
  });

  it("role change only → one USER_ROLE_CHANGED record", () => {
    const changes = diffUserFields(BASE, { role: "ADMIN" });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      action: "USER_ROLE_CHANGED",
      field: "role",
      oldValue: "CA_TEAM",
      newValue: "ADMIN",
    });
  });

  it("status change only → one USER_STATUS_CHANGED record", () => {
    const changes = diffUserFields(BASE, { status: "INACTIVE" });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      action: "USER_STATUS_CHANGED",
      field: "status",
      oldValue: "ACTIVE",
      newValue: "INACTIVE",
    });
  });

  it("permission grant → one USER_PERMISSION_CHANGED record with stringified booleans", () => {
    const changes = diffUserFields(BASE, { canAccessAiTraining: true });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      action: "USER_PERMISSION_CHANGED",
      field: "canAccessAiTraining",
      oldValue: "false",
      newValue: "true",
    });
  });

  it("permission revoke → old=true, new=false", () => {
    const before: UserAuditableSnapshot = { ...BASE, canAccessAiTraining: true };
    const changes = diffUserFields(before, { canAccessAiTraining: false });
    expect(changes).toEqual([
      {
        action: "USER_PERMISSION_CHANGED",
        field: "canAccessAiTraining",
        oldValue: "true",
        newValue: "false",
      },
    ]);
  });

  it("all three fields change in one PATCH → three records, one per field", () => {
    const changes = diffUserFields(BASE, {
      role: "ADMIN",
      status: "INACTIVE",
      canAccessAiTraining: true,
    });
    expect(changes).toHaveLength(3);
    expect(changes.map((c) => c.field).sort()).toEqual([
      "canAccessAiTraining",
      "role",
      "status",
    ]);
  });

  it("re-passing the same role/status/permission produces zero records (no-op semantics)", () => {
    const changes = diffUserFields(BASE, {
      role: "CA_TEAM",
      status: "ACTIVE",
      canAccessAiTraining: false,
    });
    expect(changes).toEqual([]);
  });

  it("mixed: role changes but status matches → only the role record", () => {
    const changes = diffUserFields(BASE, { role: "PARAPLANNER", status: "ACTIVE" });
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("role");
  });
});
