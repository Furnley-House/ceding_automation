import { createContext, useContext, useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";

// useRole is a separate store (React Context + localStorage key "fh_role").
// signOut must clear BOTH stores or role state leaks: RoleGuard reads
// useRole, and a stale role in localStorage lets a new tab appear
// "signed in" even after logout. Importing the raw localStorage key
// rather than pulling the useRole hook here — this file is imported by
// AuthProvider which is above RoleProvider in the tree, so calling the
// hook would break the provider ordering.
const ROLE_STORAGE_KEY = "fh_role";

interface Profile {
  full_name: string | null;
  role: string;
}

interface AuthContextType {
  user: { id: string; email: string } | null;
  session: { access_token: string } | null;
  loading: boolean;
  signOut: () => Promise<void>;
  profile: Profile | null;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
  profile: null,
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { token, user: storeUser, logout } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);

  // Re-validate token on mount.
  // IMPORTANT: read tokens via useAuthStore.getState() rather than closing over
  // the render-time `token`. The SSO `/auth/callback` page is a child component,
  // so its `setAuth(MS_USER, MS_TOKEN)` runs *before* this effect in the same
  // commit. If we used the captured `token` (the demo token from a prior
  // session) when persisting the /auth/me response, we'd save the new user
  // alongside the old token — and on the next refresh that stale token would
  // resolve back to the demo user.
  useEffect(() => {
    const initialToken = useAuthStore.getState().token;
    if (!initialToken) {
      setProfile(null);
      setLoading(false);
      return;
    }
    api
      .get("/auth/me")
      .then((res) => {
        const u = res.data as {
          id: string;
          email: string;
          name: string;
          role: string;
          canAccessAiTraining?: boolean;
        };
        const latestToken = useAuthStore.getState().token;
        if (!latestToken) return; // user logged out mid-flight
        useAuthStore.getState().setAuth(
          {
            id: u.id,
            email: u.email,
            name: u.name,
            role: u.role as never,
            canAccessAiTraining: u.canAccessAiTraining ?? false,
          },
          latestToken
        );
        setProfile({ full_name: u.name ?? null, role: u.role.toLowerCase() });
      })
      .catch(() => {
        useAuthStore.getState().logout();
        setProfile(null);
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep profile in sync when store user changes (e.g. after RolePicker login)
  useEffect(() => {
    if (storeUser && token) {
      setProfile({
        full_name: storeUser.name ?? null,
        role: storeUser.role.toLowerCase(),
      });
    } else {
      setProfile(null);
    }
  }, [storeUser, token]);

  const signOut = async () => {
    logout();                              // clear useAuthStore (user + token)
    localStorage.removeItem(ROLE_STORAGE_KEY); // clear useRole's localStorage twin
    // Note: RoleProvider's in-memory state only re-reads localStorage on
    // mount, so the AppHeader handler still calls clearRole() to reset
    // the in-memory value in the current tab. Clearing localStorage here
    // ensures a NEW tab / hard refresh doesn't rehydrate the stale role.
    setProfile(null);
  };

  const user = storeUser && token ? { id: storeUser.id, email: storeUser.email } : null;
  const session = token ? { access_token: token } : null;

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut, profile }}>
      {children}
    </AuthContext.Provider>
  );
}
