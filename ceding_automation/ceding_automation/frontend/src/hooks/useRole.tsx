import { createContext, useContext, useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";

export type Role = "ca_team" | "adviser" | "paraplanner" | "admin";

export const ROLE_LABELS: Record<Role, string> = {
  ca_team: "CA Team",
  adviser: "Adviser",
  paraplanner: "Paraplanner",
  admin: "Admin",
};

// Display labels shown on the role-picker tiles (before sign-in).
// Once signed in, the rest of the app uses the actual user's name from the auth
// store (not these labels), so ownership checks reflect the JWT identity.
export const ROLE_USERS: Record<Role, string> = {
  ca_team: "Revathy S",
  adviser: "James Whitfield",
  paraplanner: "Megan Doherty",
  admin: "Nicki Foster",
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

  // Prefer the signed-in user's real name (from the JWT) so ownership checks line
  // up with what the backend assigns. Fall back to the static ROLE_USERS label
  // only in the rare dev-mode case where login didn't succeed.
  const userName = authUserName ?? (role ? ROLE_USERS[role] : null);

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
    canApprove: role === "adviser" || role === "paraplanner",
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useRole = () => useContext(Ctx);
