import { Navigate } from "react-router-dom";
import { useRole, type Role } from "@/hooks/useRole";

export function RoleGuard({ children, allow }: { children: React.ReactNode; allow?: Role[] }) {
  const { role } = useRole();
  if (!role) return <Navigate to="/" replace />;
  if (allow && !allow.includes(role)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
