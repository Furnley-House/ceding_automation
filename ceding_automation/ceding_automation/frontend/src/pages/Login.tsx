import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { useRole, type Role } from "@/hooks/useRole";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import logo from "@/assets/logo-dark.png";

// Backend UserRole → frontend Role. Must match the map in AuthCallback.tsx
// so the two sign-in paths produce identical state. RoleGuard reads useRole,
// not useAuthStore, so this mapping is load-bearing for post-login routing.
const ROLE_MAP: Record<string, Role> = {
  CA_TEAM: "ca_team",
  ADVISER: "adviser",
  PARAPLANNER: "paraplanner",
  ADMIN: "admin",
};

// Phase 1 login. Replaces the pre-2026-09-17 RolePicker which posted to
// POST /api/auth/login with just an email and no password — a server-side
// hole that let anyone with the public backend URL impersonate any user.
// The picker's client-side VITE_DISABLE_DEMO_LOGIN gate was cosmetic;
// deleting the picker rather than patching it is the honest fix.
//
// Two entry paths presented equally:
//   1. Microsoft SSO — the default for Furnley House staff.
//   2. Email + password — the phase 1 path for Anchor Wealth staff and
//      any future admin-provisioned local account.
//
// SSO does a full-page navigate to the backend OAuth redirect (Microsoft
// silent SSO handles the round-trip when the browser already has a
// tenant session). Password login is a JSON POST that keeps the SPA
// mounted; on `mustChangePassword=true` we redirect to /change-password
// before the app loads so the rotation cannot be skipped.

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001/api";

const Login = () => {
  const { setAuth, user, token } = useAuthStore();
  const { setRole } = useRole();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preserve deep-links across sign-in (e.g. /cases/abc?zohoTaskId=xxx).
  // Refuse `/change-password` as a returnTo — that URL is only valid
  // during the forced-rotation window on first sign-in, not as a
  // destination for anyone else. Otherwise a stale tab or a bookmark
  // pointing at /change-password can hijack the SSO returnTo chain.
  const rawReturnTo = searchParams.get("returnTo") ?? "/dashboard";
  const returnTo = rawReturnTo.startsWith("/change-password") ? "/dashboard" : rawReturnTo;

  // Already signed in? Send them where they were going. Prevents the
  // "authenticated user opens /login and their old token silently
  // re-authenticates the next request" foot-gun. If the user genuinely
  // wants to switch accounts they must sign out first — the AppHeader's
  // sign-out control is the only entry-point that clears both stores.
  useEffect(() => {
    if (user && token) {
      navigate(returnTo, { replace: true });
    }
    // Run once on mount — subsequent state changes during the form
    // submission handle their own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ssoLogin = () => {
    window.location.href = `${API_BASE}/auth/azure?returnTo=${encodeURIComponent(returnTo)}`;
  };

  const passwordLogin = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post("/auth/login", { email: email.trim(), password });
      const data = res.data as {
        token: string;
        user: {
          id: string;
          email: string;
          name: string;
          role: string;
          canAccessAiTraining: boolean;
        };
        mustChangePassword: boolean;
      };
      setAuth(
        {
          id: data.user.id,
          email: data.user.email,
          name: data.user.name,
          role: data.user.role as never,
          canAccessAiTraining: data.user.canAccessAiTraining,
        },
        data.token,
      );
      // BOTH stores must be set or RoleGuard bounces back to /. AuthCallback
      // does the equivalent at hooks/useAuth.tsx:64-65 for SSO; the password
      // path was missing this call and produced 200 responses that never
      // rendered a signed-in view.
      const frontendRole = ROLE_MAP[data.user.role] ?? "ca_team";
      setRole(frontendRole);
      if (data.mustChangePassword) {
        // Forced rotation. The change-password screen submits, then
        // navigates to returnTo — so the redirect target survives.
        navigate(`/change-password?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
        return;
      }
      navigate(returnTo, { replace: true });
    } catch (err) {
      // Backend returns generic "Invalid credentials" for wrong email,
      // wrong password, and no-password-set — mirror that here so we
      // don't leak more than the server intends.
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 429) {
        setError("Too many attempts. Please wait a few minutes and try again.");
      } else if (status === 400) {
        setError("Please enter both email and password.");
      } else {
        setError("Invalid credentials.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="app-header h-16 flex items-center px-8 border-b border-border bg-card">
        <img src={logo} alt="Furnley House" className="h-8 w-auto" />
        <div className="ml-4 border-l border-border pl-4">
          <p className="text-sm font-bold theme-heading text-foreground">Ceding Application</p>
          <p className="text-[11px] text-muted-foreground">
            Furnley House Financial Planning Partners
          </p>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <p className="text-xs uppercase tracking-widest text-primary font-semibold mb-2">
              Sign in
            </p>
            <h1 className="text-2xl font-bold theme-heading text-foreground">
              Ceding Application
            </h1>
          </div>

          {/* ── Microsoft SSO — Furnley House staff ────────────────── */}
          <button
            type="button"
            onClick={ssoLogin}
            className="w-full inline-flex items-center justify-center gap-3 px-6 py-3 rounded-lg border border-border bg-card hover:bg-accent hover:border-primary transition-colors text-sm font-medium text-foreground shadow-sm"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 21 21">
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Sign in with Microsoft
          </button>

          <div className="flex items-center gap-4 my-6">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* ── Email + password — Anchor Wealth staff, phase 1 ──── */}
          {/* Field pattern matches UserManagementPanel + AssignParaplannerDialog:
              plain <div> wrapper (no space-y-*), Label with the uppercase-kicker
              styling the rest of the app uses, Input with mt-1 for its margin
              from the label above. Do NOT reintroduce space-y-* here — an
              earlier attempt did, and interacted badly with the browser's
              autofill overlay positioning on this page. */}
          <form onSubmit={passwordLogin} className="space-y-4">
            <div>
              <Label
                htmlFor="email"
                className="text-xs uppercase tracking-wider text-muted-foreground font-semibold"
              >
                Email
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className="mt-1"
                autoFocus
              />
            </div>
            <div>
              <Label
                htmlFor="password"
                className="text-xs uppercase tracking-wider text-muted-foreground font-semibold"
              >
                Password
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className="mt-1"
              />
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>

          <p className="mt-6 text-[11px] text-center text-muted-foreground">
            Forgot your password? Contact your admin — self-service reset is coming in a later
            release.
          </p>
        </div>
      </main>

      <footer className="border-t border-border bg-card px-8 py-3 text-center text-[11px] text-muted-foreground">
        Data retained for 12 months per FH policy · © Furnley House Financial Planning Partners
      </footer>
    </div>
  );
};

export default Login;
