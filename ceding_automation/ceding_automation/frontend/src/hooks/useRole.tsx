import { createContext, useContext, useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";

export type Role = "ca_team" | "adviser" | "paraplanner" | "admin";

export const ROLE_LABELS: Record<Role, string> = {
  ca_team: "CA Team",
  adviser: "Adviser",
  paraplanner: "Paraplanner",
  admin: "Admin",
};

// Map backend UserRole enum values (UPPER_SNAKE) to the frontend Role type
// (lower_snake). Used by every auth-completion path — password login in
// pages/Auth.tsx and SSO in pages/AuthCallback.tsx — to keep `fh_role`
// in step with the newly-signed-in JWT. Adding a third auth path? Import
// this map, call setRole(ROLE_MAP[user.role] ?? "ca_team"). SEE ALSO
// KI-07 / KI-16 — the two-store drift this map compensates for.
export const ROLE_MAP: Record<string, Role> = {
  CA_TEAM: "ca_team",
  ADVISER: "adviser",
  PARAPLANNER: "paraplanner",
  ADMIN: "admin",
};

interface RoleCtx {
  role: Role | null;
  userName: string | null;
  setRole: (r: Role) => void;
  clearRole: () => void;
  isCA: boolean;
  isAdviser: boolean;
  isParaplanner: boolean;
  isAdmin: boolean;
  canEditChecklist: boolean;
  canApprove: boolean;
}

const Ctx = createContext<RoleCtx>({
  role: null,
  userName: null,
  setRole: () => {},
  clearRole: () => {},
  isCA: false,
  isAdviser: false,
  isParaplanner: false,
  isAdmin: false,
  canEditChecklist: false,
  canApprove: false,
});

const KEY = "fh_role";

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const [role, setRoleState] = useState<Role | null>(() => {
    const v = localStorage.getItem(KEY);
    return v && ["ca_team", "adviser", "paraplanner", "admin"].includes(v) ? (v as Role) : null;
  });

  // Subscribe to the auth store so userName updates the moment a user signs in / out.
  const authUserName = useAuthStore((s) => s.user?.name ?? null);

  useEffect(() => {
    if (role) localStorage.setItem(KEY, role);
  }, [role]);

  const setRole = (r: Role) => setRoleState(r);
  const clearRole = () => {
    localStorage.removeItem(KEY);
    setRoleState(null);
  };

  // userName is the signed-in user's real name from the JWT, or null.
  // The previous `?? ROLE_USERS[role]` fallback was removed on 2026-10-03
  // after it was caught showing the demo paraplanner name "Megan Doherty"
  // in production UI — any time authUserName was null but fh_role was
  // still set in localStorage (e.g. after a 401-triggered logout that
  // cleared auth but not role, see store.ts logout), the fallback picked
  // a hardcoded demo name and rendered it in the AppHeader avatar/name,
  // Dashboard greeting, and "my cases" filters (MyInbox, Cases).
  //
  // CORRECTION (2026-10-03, after prod audit check): nothing persisted
  // badly. The backend writes audit rows and checklist.manualEditedById
  // from `req.user.id` (JWT), ignoring any frontend-supplied actor name
  // string. ChecklistField's `manuallyEditedBy: userName` was local
  // display state only; `useChecklistFields.actorName` was sent on
  // /approve-all requests but silently ignored by the handler. Prod
  // audit_logs query showed zero suspicious rows. Leak was display-only;
  // the fix (and the three-file closure of the gap) is still right, but
  // the audit trail was never corrupted. A hardcoded name is worse than
  // null — callers already handle null with their own guards
  // ("Unknown user" / "there" / empty state).
  const userName = authUserName;

  const value: RoleCtx = {
    role,
    userName,
    setRole,
    clearRole,
    isCA: role === "ca_team",
    isAdviser: role === "adviser",
    isParaplanner: role === "paraplanner",
    isAdmin: role === "admin",
    canEditChecklist: role === "ca_team" || role === "admin",
    // canApprove now includes admin — the backend approve routes
    // (POST /checklist/:id/approve, /approve-all) already accept the
    // ADMIN role, but the UI was hiding the buttons. Furnley policy:
    // when the assigned paraplanner is unavailable, an adviser or an
    // admin can sign off the checklist in their place.
    canApprove:
      role === "adviser" || role === "paraplanner" || role === "admin",
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useRole = () => useContext(Ctx);
