// frontend/src/pages/AuthCallback.tsx
//
// Azure AD SSO redirect handler.
// The backend exchanges the Azure auth-code for a JWT, then redirects here:
//   /auth/callback?token=<jwt>&user=<json>&returnTo=<path>
// On error:
//   /auth/callback?error=<message>
//
// This page stores the token, sets the frontend role, and forwards the user
// to their original destination (e.g. /cases?zohoTaskId=xxx).

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/lib/store";
import { useRole, ROLE_MAP } from "@/hooks/useRole";
import { Loader2, AlertCircle } from "lucide-react";

const AuthCallback = () => {
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuthStore();
  const { setRole } = useRole();
  const navigate = useNavigate();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const error = searchParams.get("error");
    if (error) {
      setErrorMsg(decodeURIComponent(error));
      return;
    }

    const token = searchParams.get("token");
    const userJson = searchParams.get("user");
    const returnTo = searchParams.get("returnTo") ?? "/dashboard";

    if (!token || !userJson) {
      setErrorMsg("Incomplete sign-in data received. Please try again.");
      return;
    }

    try {
      const user = JSON.parse(userJson) as {
        id: string;
        email: string;
        name: string;
        role: string;
      };

      // Persist to auth store (Zustand + localStorage)
      setAuth(
        { id: user.id, email: user.email, name: user.name, role: user.role as never },
        token
      );

      // Set the frontend role so RoleGuard lets the user through.
      // Fail honest on an unmapped role: leave fh_role unset so RoleGuard
      // bounces the user rather than silently defaulting to CA_TEAM
      // (which they may not have). Mirrors pages/Auth.tsx. See KI-07/KI-16.
      const frontendRole = ROLE_MAP[user.role];
      if (frontendRole) {
        setRole(frontendRole);
      } else {
        console.warn(`[AuthCallback] Unknown backend role, leaving fh_role unset: ${user.role}`);
      }

      // Forward to where the user was going (preserves zohoTaskId, etc.)
      navigate(returnTo, { replace: true });
    } catch {
      setErrorMsg("Failed to process sign-in data. Please try again.");
    }
  // Run once on mount — searchParams is stable from the initial URL
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (errorMsg) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-8">
        <div className="text-center max-w-md">
          <div className="flex justify-center mb-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-7 w-7 text-destructive" />
            </div>
          </div>
          <h2 className="text-xl font-bold text-foreground mb-2">Sign-in failed</h2>
          <p className="text-sm text-muted-foreground mb-6">{errorMsg}</p>
          <a
            href="/"
            className="inline-block text-sm font-medium text-primary hover:underline"
          >
            ← Back to login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-4" />
        <p className="text-sm text-muted-foreground">Completing sign-in…</p>
      </div>
    </div>
  );
};

export default AuthCallback;
