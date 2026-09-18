import { Navigate, useLocation } from "react-router-dom";
import { useRole, type Role } from "@/hooks/useRole";

// Route-level role gate. Post-2026-09-17: no VITE_DISABLE_DEMO_LOGIN
// branching. Unauthenticated users go to `/`, which is the unified Login
// page (SSO + password) — same treatment as the pre-2026-09-17 non-prod
// path, now the only path. The `allow` list, when present, additionally
// restricts which roles may render the child; a role mismatch redirects
// to /dashboard so the user lands somewhere legitimate.
export function RoleGuard({ children, allow }: { children: React.ReactNode; allow?: Role[] }) {
  const { role } = useRole();
  const location = useLocation();

  // Preserve the full path + query string so SSO can send the user back to
  // exactly where they were trying to go (e.g. /cases?taskid=xxx).
  const returnTo = location.pathname + location.search;

  if (!role) {
    const to = returnTo && returnTo !== "/" ? `/?returnTo=${encodeURIComponent(returnTo)}` : "/";
    return <Navigate to={to} replace />;
  }

  if (allow && !allow.includes(role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
