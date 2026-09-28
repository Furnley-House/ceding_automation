import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/lib/store";

// Per-user permission keys mirrored from backend/src/middleware/auth.ts.
// Keep the union small — one entry per boolean permission on the User row.
export type UserPermission = "canAccessAiTraining";

// Route-level gate that reads a boolean permission from the auth store
// rather than a role. Explicitly separate from RoleGuard because the
// grantees for canAccessAiTraining span CA_TEAM and ADMIN — a role-list
// gate would require an all-CA_TEAM allowlist and defeat the purpose.
//
// Post-2026-09-17: no VITE_DISABLE_DEMO_LOGIN branching. Unauthenticated
// users go to `/`, which is the unified Login page (SSO + password) —
// same treatment as the pre-2026-09-17 non-prod path, now the only path.
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

  if (!user) {
    const to =
      returnTo && returnTo !== "/" ? `/?returnTo=${encodeURIComponent(returnTo)}` : "/";
    return <Navigate to={to} replace />;
  }

  if (!user[perm]) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
