import { createContext, useContext, useEffect, useState } from "react";

export type Role = "ca_team" | "adviser" | "paraplanner" | "admin";

export const ROLE_LABELS: Record<Role, string> = {
  ca_team: "CA Team",
  adviser: "Adviser",
  paraplanner: "Paraplanner",
  admin: "Admin",
};

export const ROLE_USERS: Record<Role, string> = {
  ca_team: "Priya Ramesh",
  adviser: "James Whitfield",
  paraplanner: "Emma Clarke",
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

  useEffect(() => {
    if (role) localStorage.setItem(KEY, role);
  }, [role]);

  const setRole = (r: Role) => setRoleState(r);
  const clearRole = () => {
    localStorage.removeItem(KEY);
    setRoleState(null);
  };

  const value: RoleCtx = {
    role,
    userName: role ? ROLE_USERS[role] : null,
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
