import { createContext, useContext, useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";

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

  // Re-validate token on mount
  useEffect(() => {
    if (!token) {
      setProfile(null);
      setLoading(false);
      return;
    }
    api
      .get("/auth/me")
      .then((res) => {
        const u = res.data as { id: string; email: string; name: string; role: string };
        useAuthStore.getState().setAuth(
          { id: u.id, email: u.email, name: u.name, role: u.role as never },
          token
        );
        setProfile({ full_name: u.name ?? null, role: u.role.toLowerCase() });
      })
      .catch(() => {
        logout();
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
    logout();
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
