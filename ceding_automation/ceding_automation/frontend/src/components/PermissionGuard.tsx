import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/lib/store";

// Per-user permission keys mirrored from backend/src/middleware/auth.ts.
// Keep the union small — one entry per boolean permission on the User row.
export type UserPermission = "canAccessAiTraining";

// Same env-flag behaviour as RoleGuard: prod (VITE_DISABLE_DEMO_LOGIN=true)
// bypasses the in-app picker and bounces unauth users straight to Microsoft.
const DEMO_LOGIN_DISABLED =
  String(import.meta.env.VITE_DISABLE_DEMO_LOGIN).toLowerCase() === "true";
const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001/api";

// Route-level gate that reads a boolean permission from the auth store
// rather than a role. Explicitly separate from RoleGuard because the
// grantees for canAccessAiTraining span CA_TEAM and ADMIN — a role-list
// gate would require an all-CA_TEAM allowlist and defeat the purpose.
export function PermissionGuard({
  children,
  perm,
}: {
  children: React.ReactNode;
  perm: UserPermission;
}) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  const returnTo = location.pathname + location.search;

  useEffect(() => {
    if (!user && DEMO_LOGIN_DISABLED) {
      window.location.replace(
        `${API_BASE}/auth/azure?returnTo=${encodeURIComponent(returnTo)}`,
      );
    }
  }, [user, returnTo]);

  if (!user) {
    if (DEMO_LOGIN_DISABLED) return null;
    const to =
      returnTo && returnTo !== "/" ? `/?returnTo=${encodeURIComponent(returnTo)}` : "/";
    return <Navigate to={to} replace />;
  }

  if (!user[perm]) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
