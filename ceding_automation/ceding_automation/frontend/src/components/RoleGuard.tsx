import { Navigate, useLocation } from "react-router-dom";
import { useRole, type Role } from "@/hooks/useRole";

export function RoleGuard({ children, allow }: { children: React.ReactNode; allow?: Role[] }) {
  const { role } = useRole();
  const location = useLocation();

  if (!role) {
    // Preserve the full path + query string so the login page can send the user
    // back to exactly where they were trying to go (e.g. /cases?zohoTaskId=xxx).
    const returnTo = location.pathname + location.search;
    const to = returnTo && returnTo !== "/" ? `/?returnTo=${encodeURIComponent(returnTo)}` : "/";
    return <Navigate to={to} replace />;
  }

  if (allow && !allow.includes(role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
