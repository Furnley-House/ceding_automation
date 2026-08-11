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

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      setAuth: (user, token) => set({ user, token }),
      logout: () => set({ user: null, token: null }),
    }),
    { name: "ceding-auth" }
  )
);
