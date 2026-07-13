// frontend/src/lib/api.ts
import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { useAuthStore } from "./store";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001/api";
const DEMO_LOGIN_DISABLED =
  String(import.meta.env.VITE_DISABLE_DEMO_LOGIN).toLowerCase() === "true";

export const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Where to send the user when refresh is impossible and we genuinely need
// an interactive sign-in. Prod skips the in-app picker.
function redirectToSignIn(): void {
  const returnTo = window.location.pathname + window.location.search;
  if (DEMO_LOGIN_DISABLED) {
    if (window.location.pathname !== "/auth/callback") {
      window.location.replace(
        `${API_BASE}/auth/azure?returnTo=${encodeURIComponent(returnTo)}`,
      );
    }
  } else {
    if (!window.location.pathname.startsWith("/?")) {
      window.location.href = `/?returnTo=${encodeURIComponent(returnTo)}`;
    }
  }
}

// Coalesce concurrent refresh attempts. If a wave of 401s lands during a
// fetch storm (e.g. dashboard mount fires 6 queries in parallel), only one
// /auth/refresh request goes out; the rest await the shared promise.
let refreshInFlight: Promise<string | null> | null = null;
async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const stale = useAuthStore.getState().token;
    if (!stale) return null;
    try {
      // Use raw axios so we don't recurse through the 401 interceptor on
      // this request. The expired JWT is sent as Bearer — the backend's
      // /auth/refresh decodes it with ignoreExpiration:true.
      const resp = await axios.post(
        `${API_BASE}/auth/refresh`,
        {},
        { headers: { Authorization: `Bearer ${stale}` } },
      );
      const data = resp.data as {
        token: string;
        user: { id: string; email: string; name: string; role: string };
      };
      useAuthStore.getState().setAuth(
        { id: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role as never },
        data.token,
      );
      return data.token;
    } catch {
      return null;
    } finally {
      // Released after the next event-loop turn so callers using the same
      // promise see consistent results before a fresh refresh can start.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

interface RetryConfig extends AxiosRequestConfig {
  _retry?: boolean;
}

api.interceptors.response.use(
  (res) => res,
  async (err: AxiosError) => {
    const original = err.config as RetryConfig | undefined;

    // Only one retry per request. /auth/refresh itself is excluded so a
    // refresh failure doesn't loop.
    if (
      err.response?.status === 401 &&
      original &&
      !original._retry &&
      !original.url?.endsWith("/auth/refresh")
    ) {
      original._retry = true;
      const newToken = await refreshAccessToken();
      if (newToken) {
        original.headers = original.headers ?? {};
        (original.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
        return api(original);
      }
      // Refresh genuinely failed (no stored refresh_token, Microsoft
      // refused, etc.) — drop the local session and bounce through SSO.
      useAuthStore.getState().logout();
      redirectToSignIn();
    }
    return Promise.reject(err);
  },
);

// ── Cases ────────────────────────────────────────────────
export const casesApi = {
  list: (params?: Record<string, string>) => api.get("/cases", { params }),
  get: (id: string) => api.get(`/cases/${id}`),
  create: (data: Record<string, unknown>) => api.post("/cases", data),
  updateStatus: (id: string, status: string, reason?: string) =>
    api.patch(`/cases/${id}/status`, { status, onHoldReason: reason }),
  updateLoa: (id: string, loaStatus: string) =>
    api.patch(`/cases/${id}/loa`, { loaStatus }),
  assignParaplanner: (id: string, paralPlannerId: string, note?: string) =>
    api.post(`/cases/${id}/assign-paraplanner`, { paralPlannerId, note }),
  logChase: (id: string, method: string, notes?: string) =>
    api.post(`/cases/${id}/chase`, { method, notes }),
  /**
   * Stage 9 one-shot export: posts the generated XLSX as multipart, gets
   * WorkDrive metadata + Zoho update result back.
   */
  completeExport: (id: string, blob: Blob, fileName: string) => {
    const form = new FormData();
    form.append("file", blob, fileName);
    form.append("fileName", fileName);
    return api.post(`/cases/${id}/complete-export`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
  // D4 — search the Zoho Plans module for the "Link existing" picker.
  searchPlans: (q: string) =>
    api.get(`/cases/plans/search`, { params: { q } }),
  // D4 — link an existing Plans record to a case (caches id + name and
  // PATCHes the linked Zoho Task's What_Id).
  linkPlan: (id: string, planRecordId: string) =>
    api.post(`/cases/${id}/link-plan`, { planRecordId }),
  // D4 — create a new Plans record in Zoho from the case data, then link.
  createPlan: (id: string) =>
    api.post(`/cases/${id}/create-plan`),
};

// ── Documents ────────────────────────────────────────────
export const documentsApi = {
  list: (caseId: string) => api.get(`/cases/${caseId}/documents`),
  upload: (caseId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.post(`/cases/${caseId}/documents`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
  getUrl: (caseId: string, docId: string) =>
    api.get(`/cases/${caseId}/documents/${docId}/url`),
  extract: (caseId: string, docId: string) =>
    api.post(`/cases/${caseId}/documents/${docId}/extract`),
  extractPending: (caseId: string) =>
    api.post<{ count: number; documentIds: string[] }>(
      `/cases/${caseId}/documents/extract-pending`,
    ),
};

// ── Checklist ────────────────────────────────────────────
export const checklistApi = {
  get: (caseId: string) => api.get(`/cases/${caseId}/checklist`),
  seedField: (
    caseId: string,
    payload: { fieldKey: string; label?: string; section?: string; value?: string | null },
  ) => api.post(`/cases/${caseId}/checklist/seed`, payload),
  editField: (caseId: string, fieldId: string, value: string) =>
    api.patch(`/cases/${caseId}/checklist/${fieldId}`, { value }),
  resolveConflict: (caseId: string, fieldId: string, chosenValue: string) =>
    api.post(`/cases/${caseId}/checklist/${fieldId}/resolve-conflict`, { chosenValue }),
  approveField: (caseId: string, fieldId: string) =>
    api.post(`/cases/${caseId}/checklist/${fieldId}/approve`),
  requestReview: (caseId: string, fieldId: string, comment: string) =>
    api.post(`/cases/${caseId}/checklist/${fieldId}/request-review`, { comment }),
  approveAll: (caseId: string) =>
    api.post(`/cases/${caseId}/checklist/approve-all`),
  // Bulk-marks every currently-missing scalar checklist field on the case
  // as "N/A" with confidence=HIGH. Existing values and approved rows are
  // untouched. Available to CA_TEAM / ADMIN roles; server-side enforced.
  markMissingNA: (caseId: string) =>
    api.post<{ filled: number; message: string }>(
      `/cases/${caseId}/checklist/mark-missing-na`,
    ),
  generateCallScript: (caseId: string) =>
    api.post(`/cases/${caseId}/call-script`),
  uploadTranscript: (caseId: string, text: string, source?: string) =>
    api.post(`/cases/${caseId}/transcript`, { text, source }),
};

// ── Fund Lines ───────────────────────────────────────────
export const fundLinesApi = {
  list: (caseId: string) => api.get(`/cases/${caseId}/fund-lines`),
  bulk: (caseId: string, body: { rows: Record<string, unknown>[]; replace?: boolean }) =>
    api.post(`/cases/${caseId}/fund-lines/bulk`, body),
};

// ── Providers ────────────────────────────────────────────
export const providersApi = {
  list: (includeInactive = false) =>
    api.get("/providers", {
      params: includeInactive ? { includeInactive: "true" } : undefined,
    }),
  get: (id: string) => api.get(`/providers/${id}`),
  create: (data: Record<string, unknown>) => api.post("/providers", data),
  update: (id: string, data: Record<string, unknown>) => api.put(`/providers/${id}`, data),
  delete: (id: string) => api.delete(`/providers/${id}`),
};

// ── Checklist Templates (admin) ──────────────────────────
export const checklistTemplatesApi = {
  list: (params?: { planType?: string; includeInactive?: boolean }) =>
    api.get("/checklist-templates", {
      params: {
        ...(params?.planType ? { planType: params.planType } : {}),
        ...(params?.includeInactive ? { includeInactive: "true" } : {}),
      },
    }),
  create: (data: Record<string, unknown>) => api.post("/checklist-templates", data),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch(`/checklist-templates/${id}`, data),
  reorder: (items: { id: string; displayOrder: number }[]) =>
    api.post("/checklist-templates/reorder", items),
  delete: (id: string) => api.delete(`/checklist-templates/${id}`),
};

// ── Audit ────────────────────────────────────────────────
export const auditApi = {
  getForCase: (caseId: string) => api.get(`/audit/cases/${caseId}`),
  // Global audit (admin / paraplanner / adviser only — backend gates access)
  list: (params?: {
    action?: string;
    source?: string;
    caseId?: string;
    userId?: string;
    search?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) => api.get("/audit", { params }),
  // Record an export action — server writes the audit row using the JWT
  // identity so the actor can't be spoofed.
  logExport: (
    caseId: string,
    body: {
      action: "CHECKLIST_EXPORTED" | "WORKDRIVE_EXPORTED";
      fileName?: string;
      destination?: string;
      notes?: string;
    },
  ) => api.post(`/audit/cases/${caseId}/log-export`, body),
};

// ── Notifications ────────────────────────────────────────
export const notificationsApi = {
  list: () => api.get("/notifications"),
  markRead: (id: string) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.patch("/notifications/read-all"),
};

// ── Auth ─────────────────────────────────────────────────
export const authApi = {
  login: (email: string) => api.post("/auth/login", { email }),
  me: () => api.get("/auth/me"),
  // Called automatically by the 401 interceptor; exposed here for callers
  // that want to refresh proactively (e.g. before a long-running operation).
  refresh: () => api.post("/auth/refresh"),
};

// ── Users ────────────────────────────────────────────────
export const usersApi = {
  list: () => api.get("/users"),
  create: (data: Record<string, unknown>) => api.post("/users", data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/users/${id}`, data),
};

// ── Zoho CRM ─────────────────────────────────────────────
export const crmApi = {
  listTasks: (page = 1, perPage = 200) =>
    api.get("/crm/tasks", { params: { page, per_page: perPage } }),
  getTask: (id: string) => api.get(`/crm/tasks/${id}`),
  updateTask: (id: string, data: Record<string, unknown>) =>
    api.put(`/crm/tasks/${id}`, data),
  createTask: (data: Record<string, unknown>) => api.post("/crm/tasks", data),
};
