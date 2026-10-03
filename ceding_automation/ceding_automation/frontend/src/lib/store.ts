// frontend/src/lib/store.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface User {
  id: string;
  email: string;
  name: string;
  role: "CA_TEAM" | "ADVISER" | "PARAPLANNER" | "ADMIN";
  // Per-user permission for /ai-training. Optional in the type only so
  // persisted sessions from before the flag existed keep parsing; the
  // /me refetch on next mount rehydrates it. PermissionGuard treats
  // undefined as "no access" (identical to false).
  canAccessAiTraining?: boolean;
}

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  logout: () => void;
}

// localStorage key owned by hooks/useRole.tsx. Imported-by-name rather
// than the hook (would create a circular dep via React Context). The
// logout() below clears it alongside auth so a stale role can't
// coexist with a null signed-in user — that mismatch was the cause of
// the "Megan Doherty" display-only leak in the UI (AppHeader, Dashboard
// greeting, MyInbox stat bar, "my cases" filters) seen in Revathy's
// 2026-10-03 retest (4b). The leak never reached a persisted audit row
// — backend audit writes use req.user.id from the JWT, not any
// frontend-supplied name string. See hooks/useRole.tsx for the full
// correction note.
const ROLE_STORAGE_KEY = "fh_role";

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      setAuth: (user, token) => set({ user, token }),
      logout: () => {
        // Clear auth (user + token in this zustand store) AND the role
        // in localStorage, atomically. Previously api.ts's 401 interceptor
        // called logout() directly without also clearing fh_role, so a
        // refresh failure left fh_role set with no auth user. The hooks/
        // useRole fallback then wrote a hardcoded demo name as the user.
        localStorage.removeItem(ROLE_STORAGE_KEY);
        set({ user: null, token: null });
      },
    }),
    { name: "ceding-auth" }
  )
);
