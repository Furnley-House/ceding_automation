import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import logo from "@/assets/logo-dark.png";

// Forced first-sign-in password rotation. Reached when POST /auth/login
// responded with mustChangePassword=true, or via user-initiated navigation
// from a future settings screen (out of scope for phase 1).
//
// Requires the current password AS WELL AS the new one so a stolen JWT
// cannot rotate the password without also knowing the current secret.
// Backend enforces the same rule at /auth/change-password.
//
// This screen must NOT be reachable without a valid JWT — App.tsx routes
// it inside the same protected shell as /dashboard. If the user has no
// token they hit the auth redirect and get bounced to /login first.

const ChangePassword = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, token } = useAuthStore();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateChecked, setGateChecked] = useState(false);

  const returnTo = searchParams.get("returnTo") ?? "/dashboard";

  // Gate: only users who actually HAVE a password may see this screen.
  // An SSO-only user arriving here via a stale returnTo, a bookmark, or
  // a typed URL is a dead-end — they have nothing to change. Bounce them
  // to their intended destination. GET /auth/me returns `hasPassword`
  // (see routes/auth.ts) — the flag is a boolean derived server-side
  // from `passwordHash IS NOT NULL`; the hash itself is never on the wire.
  useEffect(() => {
    if (!token) {
      // No auth at all → login page. Preserve returnTo so we come back
      // to /change-password once authenticated (though the /auth/me
      // check below will bounce SSO-only users anyway).
      navigate(`/?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
      return;
    }
    let cancelled = false;
    api
      .get("/auth/me")
      .then((res) => {
        if (cancelled) return;
        const me = res.data as { hasPassword?: boolean };
        if (!me.hasPassword) {
          // SSO-only user. Send them where they were going.
          navigate(returnTo, { replace: true });
          return;
        }
        setGateChecked(true);
      })
      .catch(() => {
        if (cancelled) return;
        navigate(`/?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    // Client-side floor. Backend enforces its own (min 12 chars, max 128,
    // must-differ-from-current) — these checks are UX affordances, not
    // security controls. If they get out of sync with the backend, the
    // backend's error message wins.
    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must be different from your current password.");
      return;
    }

    setSubmitting(true);
    try {
      await api.post("/auth/change-password", {
        currentPassword,
        newPassword,
      });
      // Backend has updated the hash and cleared mustChangePassword; the
      // existing JWT is still valid so the app continues without a
      // re-login.
      navigate(returnTo, { replace: true });
    } catch (err) {
      const status = (err as { response?: { status?: number; data?: { error?: string } } }).response;
      if (status?.status === 401) {
        setError("Current password is incorrect.");
      } else if (status?.data?.error) {
        setError(status.data.error);
      } else {
        setError("Could not change password. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Don't flash the form for the ~200ms while the gate check runs — an
  // SSO-only user would see the "Set a new password" heading and inputs
  // for a beat before being bounced away.
  if (!gateChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

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
              Set a new password
            </p>
            <h1 className="text-xl font-bold theme-heading text-foreground mb-2">
              {user?.name ? `Welcome, ${user.name}` : "Welcome"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Please replace the temporary password your admin gave you before continuing.
            </p>
          </div>

          {/* Field pattern matches the rest of the app — see Login.tsx and
              UserManagementPanel for the same shape. Plain wrapper, Label
              with the uppercase-kicker styling, Input with mt-1. Any hint
              text after the input keeps its own `mt-1.5` so it sits below
              the field rather than reflowing into the wrapper's spacing. */}
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label
                htmlFor="current-password"
                className="text-xs uppercase tracking-wider text-muted-foreground font-semibold"
              >
                Temporary password
              </Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={submitting}
                className="mt-1"
                autoFocus
              />
            </div>
            <div>
              <Label
                htmlFor="new-password"
                className="text-xs uppercase tracking-wider text-muted-foreground font-semibold"
              >
                New password
              </Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={submitting}
                className="mt-1"
              />
              <p className="text-[11px] text-muted-foreground mt-1.5">
                At least 12 characters. A pass-phrase of three or four words works well.
              </p>
            </div>
            <div>
              <Label
                htmlFor="confirm-password"
                className="text-xs uppercase tracking-wider text-muted-foreground font-semibold"
              >
                Confirm new password
              </Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
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
                  Updating password…
                </>
              ) : (
                "Set new password and continue"
              )}
            </Button>
          </form>
        </div>
      </main>

      <footer className="border-t border-border bg-card px-8 py-3 text-center text-[11px] text-muted-foreground">
        © Furnley House Financial Planning Partners
      </footer>
    </div>
  );
};

export default ChangePassword;
