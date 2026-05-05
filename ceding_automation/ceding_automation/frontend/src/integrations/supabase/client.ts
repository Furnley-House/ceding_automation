/**
 * Supabase compatibility shim — routes all Supabase calls to the Express backend.
 * Drop-in replacement so source pages work unchanged.
 */

import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

// ── camelCase → snake_case key conversion ──────────────────────────────────
function toSnake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function snakeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snakeKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [toSnake(k), snakeKeys(val)])
    );
  }
  return v;
}

// snake_case → camelCase for outgoing request bodies
function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── Backend → UI status mapping ───────────────────────────────────────────
const STATUS_MAP: Record<string, string> = {
  DRAFT: "pending_loa",
  STAGE_1_LOA_PREP: "pending_loa",
  STAGE_2_COLLECT_DETAILS: "pending_loa",
  STAGE_3_CRM_SETUP: "pending_loa",
  STAGE_4_PROVIDER_REQUEST: "awaiting_documents",
  STAGE_5_CHASING: "awaiting_documents",
  STAGE_6_DOCUMENT_UPLOAD: "awaiting_documents",
  STAGE_7_MISSING_INFO: "extraction_complete",
  STAGE_8_VERIFY_CHECKLIST: "extraction_complete",
  STAGE_9_ADVISER_REVIEW: "in_review",
  STAGE_10_COMPLETE: "complete",
  ON_HOLD: "on_hold",
  IN_REVIEW: "in_review",
  APPROVED: "approved",
  CANCELLED: "complete",
};

function flattenCase(c: Record<string, unknown>): Record<string, unknown> {
  const provider = c.provider as Record<string, unknown> | null | undefined;
  const assignedTo = c.assigned_to as Record<string, unknown> | null | undefined;
  const rawStatus = (c.status as string | undefined) ?? "";
  const uiStatus = STATUS_MAP[rawStatus.toUpperCase()] ?? rawStatus.toLowerCase();
  return {
    ...c,
    backend_status: rawStatus,
    status: uiStatus,
    provider_name: provider?.name ?? "",
    plan_number: c.policy_ref ?? c.policy_reference ?? "",
    assigned_to_name: assignedTo?.name ?? "",
  };
}

function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [toCamel(k), camelKeys(val)])
    );
  }
  return v;
}

// ── Table-to-endpoint routing ──────────────────────────────────────────────
const TABLE_ROUTES: Record<string, string> = {
  cases: "/cases",
  providers: "/providers",
  notifications: "/notifications",
  profiles: "/auth/me",
  // These tables don't have dedicated backend endpoints — return empty gracefully
  tasks: "__empty__",
  automation_rules: "__empty__",
  call_logs: "__empty__",
  field_audit: "__log__",
};

// ── Minimal chainable query builder ───────────────────────────────────────
class QueryBuilder {
  private table: string;
  private filters: Record<string, unknown> = {};
  private _single = false;

  constructor(table: string) {
    this.table = table;
  }

  select(_cols?: string) { return this; }

  eq(col: string, val: unknown) {
    this.filters[col] = val;
    return this;
  }

  order(_col: string, _opts?: unknown) { return this; }
  limit(_n: number) { return this; }

  single() {
    this._single = true;
    return this;
  }

  then(
    resolve: (v: { data: unknown; error: unknown }) => void,
    reject: (e: unknown) => void
  ) {
    return this._execute().then(resolve, reject);
  }

  private async _execute(): Promise<{ data: unknown; error: unknown }> {
    const route = TABLE_ROUTES[this.table];

    if (route === "__empty__") return { data: [], error: null };
    if (route === "__log__") return { data: null, error: null };

    try {
      let url = route;
      // Nested routes based on filters
      if (this.filters.case_id) {
        if (this.table === "checklist_fields") {
          url = `/cases/${this.filters.case_id}/checklist`;
        } else if (this.table === "documents") {
          url = `/cases/${this.filters.case_id}/documents`;
        }
      }
      if (this.table === "profiles") {
        url = "/auth/me";
      }

      const res = await api.get(url, this.table === "cases" ? { params: { limit: 200 } } : {});

      // Cases endpoint returns { cases: [...], total, ... } — extract the array
      let rawData = res.data;
      if (this.table === "cases" && rawData && typeof rawData === "object" && "cases" in rawData) {
        rawData = (rawData as { cases: unknown[] }).cases;
      }

      let converted = snakeKeys(rawData);
      // Flatten and normalise case fields
      if (this.table === "cases") {
        if (Array.isArray(converted)) {
          converted = converted.map((c) => flattenCase(c as Record<string, unknown>));
        } else if (converted && typeof converted === "object") {
          converted = flattenCase(converted as Record<string, unknown>);
        }
      }

      if (this._single) {
        const arr = Array.isArray(converted) ? (converted[0] ?? null) : converted;
        return { data: arr, error: null };
      }
      return { data: Array.isArray(converted) ? converted : [converted], error: null };
    } catch (err: unknown) {
      return { data: null, error: err };
    }
  }
}

// ── Insert/update builder ─────────────────────────────────────────────────
class MutationBuilder {
  private table: string;
  private operation: "insert" | "update" | "upsert";
  private payload: unknown;
  private filters: Record<string, unknown> = {};
  private _single = false;

  constructor(table: string, op: "insert" | "update" | "upsert", data: unknown) {
    this.table = table;
    this.operation = op;
    this.payload = data;
  }

  eq(col: string, val: unknown) {
    this.filters[col] = val;
    return this;
  }

  select(_cols?: string) { return this; }

  single() {
    this._single = true;
    return this;
  }

  then(
    resolve: (v: { data: unknown; error: unknown }) => void,
    reject: (e: unknown) => void
  ) {
    return this._execute().then(resolve, reject);
  }

  private async _execute(): Promise<{ data: unknown; error: unknown }> {
    const route = TABLE_ROUTES[this.table];

    if (route === "__empty__") return { data: this.payload, error: null };
    if (route === "__log__") return { data: this.payload, error: null };

    try {
      const body = camelKeys(this.payload);
      let res;

      if (this.operation === "insert") {
        res = await api.post(route, body);
      } else {
        const id = this.filters.id as string | undefined;
        if (id) {
          res = await api.patch(`${route}/${id}`, body);
        } else {
          res = await api.patch(route, body);
        }
      }

      const converted = snakeKeys(res?.data);
      if (this._single) {
        const arr = Array.isArray(converted) ? (converted[0] ?? null) : converted;
        return { data: arr, error: null };
      }
      return { data: Array.isArray(converted) ? converted : [converted], error: null };
    } catch (err: unknown) {
      return { data: null, error: err };
    }
  }
}

// ── Storage mock ───────────────────────────────────────────────────────────
const storage = {
  from: (_bucket: string) => ({
    upload: async (path: string, file: File) => {
      // path format: "caseId/timestamp_filename"
      const caseId = path.split("/")[0];
      try {
        const form = new FormData();
        form.append("file", file);
        await api.post(`/cases/${caseId}/documents`, form, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        return { data: { path }, error: null };
      } catch (err) {
        return { data: null, error: err };
      }
    },
    getPublicUrl: (path: string) => ({
      data: { publicUrl: `/api/documents/${path}` },
    }),
    createSignedUrl: async (path: string, _expires: number) => ({
      data: { signedUrl: `/api/documents/${path}` },
      error: null,
    }),
  }),
};

// ── Functions mock (Edge Functions) ──────────────────────────────────────
const functions = {
  invoke: async (fnName: string, opts?: { body?: unknown }) => {
    try {
      let res;
      if (fnName === "extract-policy") {
        const { documentId } = (opts?.body ?? {}) as { documentId?: string };
        res = await api.post(`/documents/${documentId}/extract`);
      } else {
        return { data: null, error: new Error(`Unknown function: ${fnName}`) };
      }
      return { data: res.data, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  },
};

// ── Auth mock ─────────────────────────────────────────────────────────────
type AuthListener = (event: string, session: unknown) => void;
const authListeners: AuthListener[] = [];

const auth = {
  onAuthStateChange: (cb: AuthListener) => {
    authListeners.push(cb);
    // Fire immediately with current state
    const { token, user } = useAuthStore.getState();
    if (token && user) {
      setTimeout(() =>
        cb("SIGNED_IN", { user: { id: user.id, email: user.email }, access_token: token }), 0
      );
    }
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            const idx = authListeners.indexOf(cb);
            if (idx >= 0) authListeners.splice(idx, 1);
          },
        },
      },
    };
  },

  getSession: async () => {
    const { token, user } = useAuthStore.getState();
    if (!token) return { data: { session: null }, error: null };
    return {
      data: {
        session: { user: { id: user?.id, email: user?.email }, access_token: token },
      },
      error: null,
    };
  },

  getUser: async () => {
    const user = useAuthStore.getState().user;
    return { data: { user: user ? { id: user.id, email: user.email } : null }, error: null };
  },

  signInWithPassword: async ({ email }: { email: string; password?: string }) => {
    try {
      const res = await api.post("/auth/login", { email });
      const { token, user } = res.data as {
        token: string;
        user: { id: string; email: string; name: string; role: string };
      };
      useAuthStore.getState().setAuth(
        { id: user.id, email: user.email, name: user.name, role: user.role as never },
        token
      );
      authListeners.forEach((cb) =>
        cb("SIGNED_IN", { user: { id: user.id, email: user.email }, access_token: token })
      );
      return {
        data: {
          user: { id: user.id, email: user.email },
          session: { access_token: token },
        },
        error: null,
      };
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? (err as Error).message
        ?? "Login failed";
      return { data: { user: null, session: null }, error: { message: msg } };
    }
  },

  signUp: async ({ email }: { email: string; password?: string }) => {
    // Demo mode: signup = login
    return auth.signInWithPassword({ email });
  },

  signOut: async () => {
    useAuthStore.getState().logout();
    authListeners.forEach((cb) => cb("SIGNED_OUT", null));
    return { error: null };
  },
};

// ── Delete builder ────────────────────────────────────────────────────────
class DeleteBuilder {
  private table: string;
  private filters: Record<string, unknown[]> = {};

  constructor(table: string) {
    this.table = table;
  }

  eq(col: string, val: unknown) {
    this.filters[col] = [val];
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters[col] = vals;
    return this;
  }

  then(
    resolve: (v: { data: unknown; error: unknown }) => void,
    reject: (e: unknown) => void
  ) {
    return this._execute().then(resolve, reject);
  }

  private async _execute(): Promise<{ data: unknown; error: unknown }> {
    const route = TABLE_ROUTES[this.table];
    if (!route || route === "__empty__" || route === "__log__") {
      return { data: null, error: null };
    }
    try {
      const id = (this.filters.id ?? [])[0] as string | undefined;
      if (id) {
        await api.delete(`${route}/${id}`);
      }
      return { data: null, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  }
}

// ── Realtime channel mock (no-op — no realtime in Express backend) ────────
const mockChannel = {
  on: (_event: string, _filter: unknown, _cb: () => void) => mockChannel,
  subscribe: () => mockChannel,
};

// ── Main supabase client ──────────────────────────────────────────────────
export const supabase = {
  from: (table: string) => ({
    select: (cols?: string) => new QueryBuilder(table).select(cols),
    insert: (data: unknown) => new MutationBuilder(table, "insert", data),
    update: (data: unknown) => new MutationBuilder(table, "update", data),
    upsert: (data: unknown) => new MutationBuilder(table, "upsert", data),
    delete: () => new DeleteBuilder(table),
  }),
  storage: {
    ...storage,
    from: (bucket: string) => ({
      ...storage.from(bucket),
      remove: async (_paths: string[]) => ({ data: null, error: null }),
    }),
  },
  functions,
  auth,
  // Realtime channel — no-op stubs (Express backend has no realtime)
  channel: (_name: string) => mockChannel,
  removeChannel: (_channel: unknown) => {},
};
