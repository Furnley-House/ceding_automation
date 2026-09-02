import type { UserRole, UserStatus } from "@prisma/client";

// Fields on the User row that are audit-worthy when an ADMIN changes
// them. `name` is deliberately NOT audited here — a name edit is not a
// permission or safety event, and the current PATCH handler accepts it
// but the audit trail only cares about role, status, and the AI
// Training permission.
export interface UserAuditableSnapshot {
  role: UserRole;
  status: UserStatus;
  canAccessAiTraining: boolean;
}

export type UserAuditActionValue =
  | "USER_ROLE_CHANGED"
  | "USER_STATUS_CHANGED"
  | "USER_PERMISSION_CHANGED";

export interface UserFieldChange {
  action: UserAuditActionValue;
  field: "role" | "status" | "canAccessAiTraining";
  oldValue: string;
  newValue: string;
}

/**
 * Diff the audited subset of a User row before / after an update.
 *
 * Returns one record per field that ACTUALLY changed. A PATCH that
 * passes the same value the user already had produces no record — the
 * audit trail should represent state transitions, not intent.
 *
 * `after` is partial because the PATCH handler only passes fields the
 * caller sent. Fields absent from `after` are treated as unchanged.
 */
export function diffUserFields(
  before: UserAuditableSnapshot,
  after: Partial<UserAuditableSnapshot>,
): UserFieldChange[] {
  const changes: UserFieldChange[] = [];

  if (after.role !== undefined && after.role !== before.role) {
    changes.push({
      action: "USER_ROLE_CHANGED",
      field: "role",
      oldValue: before.role,
      newValue: after.role,
    });
  }

  if (after.status !== undefined && after.status !== before.status) {
    changes.push({
      action: "USER_STATUS_CHANGED",
      field: "status",
      oldValue: before.status,
      newValue: after.status,
    });
  }

  if (
    after.canAccessAiTraining !== undefined &&
    after.canAccessAiTraining !== before.canAccessAiTraining
  ) {
    changes.push({
      action: "USER_PERMISSION_CHANGED",
      field: "canAccessAiTraining",
      oldValue: String(before.canAccessAiTraining),
      newValue: String(after.canAccessAiTraining),
    });
  }

  return changes;
}
