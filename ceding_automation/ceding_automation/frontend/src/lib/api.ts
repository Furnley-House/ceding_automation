// frontend/src/lib/api.ts
import axios from "axios";
import { useAuthStore } from "./store";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:3001/api",
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout();
      // Redirect to the login/role-picker page (root) — not /login which doesn't exist
      if (!window.location.pathname.startsWith("/?")) {
        window.location.href = `/?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      }
    }
    return Promise.reject(err);
  }
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
  fillTestData: (caseId: string) =>
    api.post(`/cases/${caseId}/checklist/fill-test-data`),
  generateCallScript: (caseId: string) =>
    api.post(`/cases/${caseId}/call-script`),
  uploadTranscript: (caseId: string, text: string, source?: string) =>
    api.post(`/cases/${caseId}/transcript`, { text, source }),
};

// ── Fund Lines ───────────────────────────────────────────
export const fundLinesApi = {
  list: (caseId: string) => api.get(`/cases/${caseId}/fund-lines`),
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
