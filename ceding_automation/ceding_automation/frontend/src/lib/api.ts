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
  generateCallScript: (caseId: string) =>
    api.post(`/cases/${caseId}/call-script`),
  uploadTranscript: (caseId: string, text: string, source?: string) =>
    api.post(`/cases/${caseId}/transcript`, { text, source }),
};

// ── Providers ────────────────────────────────────────────
export const providersApi = {
  list: () => api.get("/providers"),
  get: (id: string) => api.get(`/providers/${id}`),
  create: (data: Record<string, unknown>) => api.post("/providers", data),
  update: (id: string, data: Record<string, unknown>) => api.put(`/providers/${id}`, data),
  delete: (id: string) => api.delete(`/providers/${id}`),
};

// ── Audit ────────────────────────────────────────────────
export const auditApi = {
  getForCase: (caseId: string) => api.get(`/audit/cases/${caseId}`),
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
