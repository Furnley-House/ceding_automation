import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useRole, type Role } from "@/hooks/useRole";

// Match RolePicker's flag: prod (VITE_DISABLE_DEMO_LOGIN=true) skips the
// in-app login picker and bounces unauth users straight to Microsoft.
const DEMO_LOGIN_DISABLED =
  String(import.meta.env.VITE_DISABLE_DEMO_LOGIN).toLowerCase() === "true";
const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001/api";

export function RoleGuard({ children, allow }: { children: React.ReactNode; allow?: Role[] }) {
  const { role } = useRole();
  const location = useLocation();

  // Preserve the full path + query string so SSO can send the user back to
  // exactly where they were trying to go (e.g. /cases?taskid=xxx).
  const returnTo = location.pathname + location.search;

  // Prod path: bypass the in-app picker and go straight to /auth/azure on
  // the backend. window.location is needed (full reload) because the SSO
  // endpoint is on a different origin from the SPA bundle.
  useEffect(() => {
    if (!role && DEMO_LOGIN_DISABLED) {
      window.location.replace(
        `${API_BASE}/auth/azure?returnTo=${encodeURIComponent(returnTo)}`,
      );
    }
  }, [role, returnTo]);

  if (!role) {
    if (DEMO_LOGIN_DISABLED) {
      // Hold-on render while the effect above kicks off the SSO redirect.
      // Returning null avoids a flash of the role picker.
      return null;
    }
    const to = returnTo && returnTo !== "/" ? `/?returnTo=${encodeURIComponent(returnTo)}` : "/";
    return <Navigate to={to} replace />;
  }

  if (allow && !allow.includes(role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
