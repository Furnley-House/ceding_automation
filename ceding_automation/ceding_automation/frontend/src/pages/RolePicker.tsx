import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useRole, ROLE_LABELS, ROLE_USERS, type Role } from "@/hooks/useRole";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { ClipboardCheck, UserCheck, FileSearch, ShieldCheck, Loader2 } from "lucide-react";
import logo from "@/assets/logo-dark.png";

// Backend base URL for SSO redirect (browser navigates directly to it)
const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001/api";

// Demo email per role — must match seeded users in the backend.
// `ca_team` resolves to Revathy S so it lines up with the real Zoho task owner.
const ROLE_EMAILS: Record<Role, string> = {
  ca_team: "revathy.s@furnleyhouse.co.uk",
  paraplanner: "paraplanner@furnleyhouse.co.uk",
  adviser: "adviser@furnleyhouse.co.uk",
  admin: "admin@furnleyhouse.co.uk",
};

const roles: { id: Role; icon: React.ElementType; tagline: string; perms: string[] }[] = [
  {
    id: "ca_team",
    icon: ClipboardCheck,
    tagline: "Chennai · Data Capture",
    perms: [
      "Upload documents & run AI extraction",
      "Edit all checklist fields",
      "Make provider calls & analyse transcripts",
    ],
  },
  {
    id: "paraplanner",
    icon: FileSearch,
    tagline: "UK · Review & Approval",
    perms: [
      "Review extracted data",
      "Approve fields or request review",
      "Comment on cases",
    ],
  },
  {
    id: "adviser",
    icon: UserCheck,
    tagline: "UK · Client Recommendations",
    perms: [
      "Final case approval",
      "Edit values (audit-logged)",
      "Prepare suitability reports",
    ],
  },
  {
    id: "admin",
    icon: ShieldCheck,
    tagline: "Configuration & Users",
    perms: [
      "Manage users & roles",
      "Manage Provider Directory",
      "Manage checklist templates",
    ],
  },
];

const RolePicker = () => {
  const { setRole } = useRole();
  const { setAuth } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);

  // If RoleGuard forwarded a returnTo, preserve it through login
  const returnTo = searchParams.get("returnTo") ?? "/dashboard";

  // Microsoft SSO — browser navigates directly to the backend OAuth redirect
  const ssoLogin = () => {
    window.location.href = `${API_BASE}/auth/azure?returnTo=${encodeURIComponent(returnTo)}`;
  };

  const pick = async (r: Role) => {
    setLoading(r);
    setError(null);
    try {
      const res = await api.post("/auth/login", { email: ROLE_EMAILS[r] });
      const { token, user } = res.data as {
        token: string;
        user: { id: string; email: string; name: string; role: string };
      };
      setAuth({ id: user.id, email: user.email, name: user.name, role: user.role as never }, token);
      setRole(r);
      navigate(returnTo, { replace: true });
    } catch {
      // Fallback: work without a token (dev mode with no backend)
      setRole(r);
      navigate(returnTo, { replace: true });
    } finally {
      setLoading(null);
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
        <div className="w-full max-w-5xl">
          <div className="text-center mb-10">
            <p className="text-xs uppercase tracking-widest text-primary font-semibold mb-2">
              Role access
            </p>
            <h1 className="text-3xl font-bold theme-heading text-foreground mb-2">
              Sign in to continue
            </h1>
            <p className="text-sm text-muted-foreground max-w-xl mx-auto mb-6">
              Use your Furnley House Microsoft account, or pick a demo role below.
            </p>

            {/* ── Microsoft SSO button ───────────────────────────────── */}
            <button
              onClick={ssoLogin}
              className="inline-flex items-center gap-3 px-6 py-3 rounded-lg border border-border bg-card hover:bg-accent hover:border-primary transition-colors text-sm font-medium text-foreground shadow-sm"
            >
              {/* Microsoft logo SVG */}
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 21 21">
                <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
              </svg>
              Sign in with Microsoft
            </button>

            {error && (
              <p className="mt-3 text-sm text-destructive">{error}</p>
            )}

            <div className="flex items-center gap-4 max-w-lg mx-auto mt-8 mb-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">or demo as a role</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {roles.map((r) => (
              <button
                key={r.id}
                onClick={() => pick(r.id)}
                disabled={loading !== null}
                className="theme-card theme-card-accent border border-border bg-card text-left transition-all hover:shadow-lg hover:-translate-y-1 group disabled:opacity-60 disabled:pointer-events-none"
              >
                <div
                  className="flex h-12 w-12 items-center justify-center bg-primary/10 mb-4"
                  style={{ borderRadius: "var(--btn-radius)" }}
                >
                  {loading === r.id ? (
                    <Loader2 className="h-6 w-6 text-primary animate-spin" />
                  ) : (
                    <r.icon className="h-6 w-6 text-primary" />
                  )}
                </div>
                <h3 className="text-base font-bold theme-heading text-foreground mb-0.5">
                  {ROLE_LABELS[r.id]}
                </h3>
                <p className="text-[11px] text-muted-foreground mb-3">{r.tagline}</p>
                <p className="text-xs text-foreground font-medium mb-3 pb-3 border-b border-border">
                  Sign in as{" "}
                  <span className="text-primary">{ROLE_USERS[r.id]}</span>
                </p>
                <ul className="space-y-1.5">
                  {r.perms.map((p) => (
                    <li
                      key={p}
                      className="text-[11px] text-muted-foreground leading-snug flex gap-1.5"
                    >
                      <span className="text-primary mt-0.5">•</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 text-xs font-semibold text-primary group-hover:underline">
                  Continue as {ROLE_LABELS[r.id]} →
                </div>
              </button>
            ))}
          </div>
        </div>
      </main>

      <footer className="border-t border-border bg-card px-8 py-3 text-center text-[11px] text-muted-foreground">
        Data retained for 12 months per FH policy · © Furnley House Financial Planning Partners
      </footer>
    </div>
  );
};

export default RolePicker;
