// backend/src/services/zohoCrm.ts
import { PlanType } from '@prisma/client';

const accountsBase = () => process.env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.eu';
const apiBase = () => process.env.ZOHO_API_BASE ?? 'https://sandbox.zohoapis.eu/crm/v6';

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let cache: TokenCache | null = null;

export async function getZohoAccessToken(): Promise<string> {
  return getAccessToken();
}

async function getAccessToken(): Promise<string> {
  if (cache && Date.now() < cache.expiresAt - 60_000) return cache.accessToken;

  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('ZOHO_REFRESH_TOKEN not set — visit /api/crm/oauth/authorize to complete setup');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID!,
    client_secret: process.env.ZOHO_CLIENT_SECRET!,
    refresh_token: refreshToken,
  });

  const res = await fetch(`${accountsBase()}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!data.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
  }

  cache = {
    accessToken: data.access_token as string,
    expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
  };

  return cache.accessToken;
}

export function buildAuthorizeUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    // Scopes:
    //   - modules.ALL  → read/write any module incl. the custom Plans module
    //     (used by complete-export to PATCH plan records)
    //   - contacts.READ → resolve the paraplanner from the linked Contact
    //   - tasks.ALL → existing CRM-task import flow
    //   - settings.fields.READ / users.READ → admin lookups
    //   - WorkDrive.* → upload exports + recordings to the ceding folder
    scope:
      'ZohoCRM.modules.ALL,ZohoCRM.modules.tasks.ALL,ZohoCRM.modules.contacts.READ,ZohoCRM.settings.fields.READ,ZohoCRM.users.READ,WorkDrive.files.ALL,WorkDrive.team.READ',
    client_id: process.env.ZOHO_CLIENT_ID!,
    response_type: 'code',
    access_type: 'offline',
    redirect_uri: redirectUri,
  });
  return `${accountsBase()}/oauth/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ZOHO_CLIENT_ID!,
    client_secret: process.env.ZOHO_CLIENT_SECRET!,
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetch(`${accountsBase()}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  return res.json() as Promise<Record<string, unknown>>;
}

export async function listTasks(page = 1, perPage = 200): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}/Tasks?page=${page}&per_page=${perPage}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  return res.json();
}

export async function getTask(taskId: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}/Tasks/${taskId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  return res.json();
}

export async function getContact(contactId: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}/Contacts/${contactId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Zoho Contacts/${contactId} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ── Contact record access ───────────────────────────────────
// Pull the full Contact record from CRM. The Contact is the source of
// truth for "who owns this client" — Plan records inherit user-lookup
// fields from here. We expose the raw record so callers can extract
// whatever fields they need; helpers below do the common extractions.
export async function getContactRecord(
  contactZohoId: string,
): Promise<Record<string, unknown> | null> {
  const raw = (await getContact(contactZohoId)) as { data?: unknown[] };
  return Array.isArray(raw?.data) ? (raw.data[0] as Record<string, unknown>) : null;
}

// Extract a single-user-lookup value (e.g. Contact.Paraplanner) from a
// Contact record. Zoho returns these as `{ id, name, email }`. We return
// in the same shape — `id` is always a Zoho User id (real, valid, can be
// reused for any User Lookup field on any module).
export interface ZohoUserRef {
  id: string;
  name?: string;
  email?: string;
}

function readUserRef(contact: Record<string, unknown>, fieldKey: string): ZohoUserRef | null {
  const v = contact[fieldKey];
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : undefined;
  if (!id) return null;
  return {
    id,
    name: typeof obj.name === 'string' ? obj.name : undefined,
    email: typeof obj.email === 'string' ? obj.email : undefined,
  };
}

// Extract a multi-user-lookup value (e.g. Contact.Client_Owners). Returns
// the array verbatim so it can be passed straight into the Plans PATCH.
function readMultiUserRefs(contact: Record<string, unknown>, fieldKey: string): ZohoUserRef[] {
  const v = contact[fieldKey];
  if (!Array.isArray(v)) return [];
  const out: ZohoUserRef[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : undefined;
    if (!id) continue;
    out.push({
      id,
      name: typeof obj.name === 'string' ? obj.name : undefined,
      email: typeof obj.email === 'string' ? obj.email : undefined,
    });
  }
  return out;
}

// One-stop extractor for the user-lookup fields we want to push to Plans.
// All field names are env-configurable so the same code works against any
// Furnley House Zoho org without redeploy.
export interface ContactUserFields {
  clientOwners: ZohoUserRef[];     // Plans.Client_Owners ← Contact.Client_Owners
  paraplanner: ZohoUserRef | null;  // single user — used to derive Client_Owners if multi-select empty
  owner: ZohoUserRef | null;        // Plans.Owner ← Contact.Owner (CRM record-owner)
}

export function extractContactUserFields(
  contact: Record<string, unknown>,
): ContactUserFields {
  const clientOwnersField = process.env.ZOHO_CONTACT_FIELD_CLIENT_OWNERS ?? 'Client_Owners';
  const paraplannerField =
    process.env.ZOHO_CONTACT_FIELD_PARAPLANNER ?? 'Paraplanner';
  const ownerField = process.env.ZOHO_CONTACT_FIELD_OWNER ?? 'Owner';

  return {
    clientOwners: readMultiUserRefs(contact, clientOwnersField),
    paraplanner: readUserRef(contact, paraplannerField),
    owner: readUserRef(contact, ownerField),
  };
}

// ── Back-compat ─────────────────────────────────────────────
// Kept so the CRM import flow (which uses this to match a Zoho paraplanner
// to an app user at task-import time) doesn't have to change. New code
// should use getContactRecord + extractContactUserFields instead.
export interface ContactParaplanner {
  name?: string;
  email?: string;
  zohoUserId?: string;
}

export async function lookupParaplannerFromContact(
  contactZohoId: string,
): Promise<ContactParaplanner | null> {
  const contact = await getContactRecord(contactZohoId);
  if (!contact) return null;
  const fields = extractContactUserFields(contact);
  // Prefer multi-select Client_Owners[0], fall back to single Paraplanner.
  const ref = fields.clientOwners[0] ?? fields.paraplanner;
  if (!ref) return null;
  return { name: ref.name, email: ref.email, zohoUserId: ref.id };
}

export async function updateTask(
  taskId: string,
  fields: Record<string, unknown>
): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}/Tasks/${taskId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [{ id: taskId, ...fields }] }),
  });
  return res.json();
}

export async function createTask(fields: Record<string, unknown>): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}/Tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [fields] }),
  });
  return res.json();
}

// ── Custom Plans module updates ─────────────────────────────
// The Furnley House CRM has a custom module that stores per-plan details
// (provider, policy ref, valuation, retirement age, etc.). When the CA team
// finishes the ceding flow we PATCH that record so the CRM is the source
// of truth. Module API name is configurable via env (defaults to "Plans").
function planModuleName(): string {
  return process.env.ZOHO_PLAN_MODULE ?? 'Plans';
}

// Junction module that links Plans to Clients (multi-client / joint plans).
// Without rows here, a newly-created Plan won't appear under the Client in CRM.
function plansXClientsModuleName(): string {
  return process.env.ZOHO_PLANS_X_CLIENTS_MODULE ?? 'Plans_X_Clients';
}

// App PlanType enum → exact Plans-module pick-list label. Adjust if your
// CRM uses different labels for any of these.
export function mapPlanTypeToZoho(planType: string): string {
  switch (planType) {
    case "PENSION":      return "Pension";
    case "ISA":          return "ISA";
    case "GIA":          return "GIA";
    case "BOND":         return "Bond";
    case "FINAL_SALARY": return "Final Salary";
    case "PROTECTION":   return "Protection";
    default:             return planType;
  }
}

export async function updatePlanRecord(
  planRecordId: string,
  fields: Record<string, unknown>,
): Promise<unknown> {
  const token = await getAccessToken();
  const url = `${apiBase()}/${planModuleName()}/${encodeURIComponent(planRecordId)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [{ id: planRecordId, ...fields }] }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Zoho ${planModuleName()}/${planRecordId} PUT failed (${res.status}): ${body}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

// Search the Plans module for a record whose Policy_Ref matches. Used when
// the case row has no zohoCaseId yet — so the very first export can still
// find the right CRM record without needing the user to re-import the task.
// Returns the Zoho record id of the unique match, or null when there is no
// match / multiple matches (caller decides what to do).
export async function findPlanRecordByPolicyRef(
  policyRef: string,
): Promise<{ id: string; record: Record<string, unknown> } | null> {
  if (!policyRef || !policyRef.trim()) return null;
  const token = await getAccessToken();
  const criteria = `(Policy_Ref:equals:${policyRef.trim()})`;
  const url = `${apiBase()}/${planModuleName()}/search?criteria=${encodeURIComponent(criteria)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (res.status === 204) return null; // Zoho convention: no match
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Zoho ${planModuleName()} search failed (${res.status}): ${body}`);
  }
  const parsed = JSON.parse(body) as { data?: Array<Record<string, unknown>> };
  const matches = parsed.data ?? [];
  if (matches.length !== 1) return null; // ambiguous or no match → require manual resolution
  const rec = matches[0];
  return { id: rec.id as string, record: rec };
}

// Multi-result Plans search by Policy_Ref starts-with. Used by the D4
// "Link existing" picker — exposes ambiguous / partial matches so the
// CA can choose, instead of the unique-match silent-skip behaviour of
// findPlanRecordByPolicyRef.
//
// Returns up to `limit` lightweight rows (id, Name, Policy_Ref, Plan_Type).
export interface PlanSearchHit {
  id: string;
  name: string | null;
  policyRef: string | null;
  planType: string | null;
}
export async function searchPlansByPolicyRefStartsWith(
  q: string,
  limit = 10,
): Promise<PlanSearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const token = await getAccessToken();
  // Zoho CRM v6 doesn't support `starts_with` on all field types; Policy_Ref
  // is a Single Line and supports `starts_with`. `equals` is the safe fallback
  // if your CRM rejects the operator (catch the 400 and retry).
  const criteria = `(Policy_Ref:starts_with:${trimmed})`;
  const url = `${apiBase()}/${planModuleName()}/search?criteria=${encodeURIComponent(criteria)}&per_page=${Math.min(
    limit,
    200,
  )}`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (res.status === 204) return [];
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Zoho ${planModuleName()} search failed (${res.status}): ${body}`);
  }
  const parsed = JSON.parse(body) as { data?: Array<Record<string, unknown>> };
  const rows = parsed.data ?? [];
  return rows.slice(0, limit).map((r) => ({
    id: String(r.id ?? ""),
    name: typeof r.Name === "string" ? r.Name : null,
    policyRef: typeof r.Policy_Ref === "string" ? r.Policy_Ref : null,
    planType: typeof r.Plan_Type === "string" ? r.Plan_Type : null,
  }));
}

// Create a new Plans record in Zoho. Used by the D4 "Create new in Zoho"
// flow when no existing Plans record matches the case's Policy Ref.
// Returns the new record's id (and Name when Zoho echoes it back).
//
// Plan↔Contact linkage is established separately via the Plans_X_Clients
// junction module — see createPlansXClientsLinks() below. We deliberately
// don't carry the client id on the Plans record itself.
export async function createPlanRecord(
  fields: Record<string, unknown>,
): Promise<{ id: string; name: string | null }> {
  const token = await getAccessToken();
  const url = `${apiBase()}/${planModuleName()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [fields] }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Zoho ${planModuleName()} POST failed (${res.status}): ${body}`);
  }
  const parsed = JSON.parse(body) as { data?: Array<{ details?: { id?: string }; status?: string; message?: string }> };
  const first = parsed.data?.[0];
  if (!first || first.status !== "success" || !first.details?.id) {
    throw new Error(`Zoho ${planModuleName()} POST returned non-success: ${body}`);
  }
  const newId = first.details.id;
  // Zoho's create response doesn't include Name — fetch the new record to
  // capture the auto-generated Plan Name (e.g. "Plan119576") for caching.
  let name: string | null = null;
  try {
    const fetched = await findPlanRecordById(newId);
    const nm = fetched?.record.Name;
    if (typeof nm === "string" && nm.trim()) name = nm.trim();
  } catch {
    // Best-effort: name backfill failure shouldn't block the create.
  }
  return { id: newId, name };
}

// Create Plans_X_Clients junction rows so the Plan shows up under its Client(s)
// in CRM (multi-client / joint plans need one row per client).
// Returns { created: N, errors: [...] } — never throws so a partial failure
// doesn't roll back a successful Plans POST.
export async function createPlansXClientsLinks(
  planRecordId: string,
  clientOwnerIds: string[],
): Promise<{ created: number; errors: string[] }> {
  const ids = clientOwnerIds.filter((id) => typeof id === "string" && id.trim().length > 0);
  if (ids.length === 0) return { created: 0, errors: [] };

  const token = await getAccessToken();
  const url = `${apiBase()}/${plansXClientsModuleName()}`;
  const rows = ids.map((clientId) => ({
    Plans: planRecordId,
    Client_Owners: clientId,
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: rows }),
  });
  const body = await res.text();
  if (!res.ok) {
    return { created: 0, errors: [`POST ${plansXClientsModuleName()} failed (${res.status}): ${body}`] };
  }
  const parsed = JSON.parse(body) as {
    data?: Array<{ status?: string; message?: string; details?: { id?: string } }>;
  };
  let created = 0;
  const errors: string[] = [];
  (parsed.data ?? []).forEach((row, i) => {
    if (row.status === "success" && row.details?.id) {
      created++;
    } else {
      errors.push(`row ${i} (client ${ids[i]}): ${row.message ?? "unknown error"}`);
    }
  });
  return { created, errors };
}

// Link a Zoho Task to a Plans record by setting What_Id + $se_module.
// Both fields are required by the CRM API — `What_Id` alone is rejected.
export async function linkTaskToPlan(taskId: string, planRecordId: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}/Tasks/${taskId}`, {
    method: "PUT",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: [
        {
          id: taskId,
          What_Id: planRecordId,
          $se_module: planModuleName(),
        },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Zoho Tasks/${taskId} What_Id update failed (${res.status}): ${body}`);
  }
}

// Fetch a single Plans record by id. Used by the case-sync to backfill
// Plans.Name onto cases that already have zohoCaseId cached from an earlier
// import (Task.What_Id) but predate the zohoPlanName column.
export async function findPlanRecordById(
  recordId: string,
): Promise<{ id: string; record: Record<string, unknown> } | null> {
  if (!recordId || !recordId.trim()) return null;
  const token = await getAccessToken();
  const url = `${apiBase()}/${planModuleName()}/${encodeURIComponent(recordId.trim())}`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (res.status === 204 || res.status === 404) return null;
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Zoho ${planModuleName()} get failed (${res.status}): ${body}`);
  }
  const parsed = JSON.parse(body) as { data?: Array<Record<string, unknown>> };
  const rec = parsed.data?.[0];
  if (!rec) return null;
  return { id: rec.id as string, record: rec };
}

// Providers custom module — same pattern as Plans. Searches by the standard
// `Name` field (override via ZOHO_PROVIDER_NAME_FIELD if your module uses a
// different label). Module API name defaults to "Providers", override via
// ZOHO_PROVIDER_MODULE.
function providerModuleName(): string {
  return process.env.ZOHO_PROVIDER_MODULE ?? 'Providers';
}
function providerNameField(): string {
  return process.env.ZOHO_PROVIDER_NAME_FIELD ?? 'Name';
}

export async function findProviderRecordByName(
  providerName: string,
): Promise<{ id: string; record: Record<string, unknown> } | null> {
  if (!providerName || !providerName.trim()) return null;
  const token = await getAccessToken();
  const trimmed = providerName.trim();
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };

  // 1. Exact match first — the cheapest, most precise.
  const searchOnce = async (criteria: string) => {
    const url = `${apiBase()}/${providerModuleName()}/search?criteria=${encodeURIComponent(criteria)}`;
    const res = await fetch(url, { headers });
    if (res.status === 204) return [] as Array<Record<string, unknown>>;
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Zoho ${providerModuleName()} search failed (${res.status}): ${body}`);
    }
    return (JSON.parse(body) as { data?: Array<Record<string, unknown>> }).data ?? [];
  };

  const exact = await searchOnce(`(${providerNameField()}:equals:${trimmed})`);
  if (exact.length === 1) return { id: exact[0].id as string, record: exact[0] };
  // Multiple exact matches: ambiguous → fail rather than guess.
  if (exact.length > 1) return null;

  // 2. No exact match — try starts_with so "Aviva" finds "Aviva Life & Pensions".
  const partial = await searchOnce(`(${providerNameField()}:starts_with:${trimmed})`);
  if (partial.length === 1) return { id: partial[0].id as string, record: partial[0] };

  // 3. Still ambiguous or empty — give up to avoid guessing.
  return null;
}

// ── Users — email → Zoho user id resolution ─────────────────
// Zoho doesn't expose a /users/search endpoint, so we list all users once
// and cache the email→id map in-process for an hour. Used by the export
// flow to pass `{id}` (not `{email}`) for Owner / Client_Owners lookups,
// which is the most reliable form.
interface ZohoUser {
  id: string;
  email?: string;
  full_name?: string;
  status?: string;
}
let userCache: { byEmail: Map<string, ZohoUser>; expiresAt: number } | null = null;
const USER_CACHE_TTL_MS = 60 * 60 * 1000;

async function loadUserCache(): Promise<Map<string, ZohoUser>> {
  if (userCache && Date.now() < userCache.expiresAt) return userCache.byEmail;
  const token = await getAccessToken();
  const url = `${apiBase()}/users?type=AllUsers&per_page=200`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Zoho users list failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { users?: ZohoUser[] };
  const byEmail = new Map<string, ZohoUser>();
  for (const u of body.users ?? []) {
    if (u.email) byEmail.set(u.email.toLowerCase(), u);
  }
  userCache = { byEmail, expiresAt: Date.now() + USER_CACHE_TTL_MS };
  return byEmail;
}

export async function findZohoUserByEmail(email: string | null | undefined): Promise<ZohoUser | null> {
  if (!email) return null;
  try {
    const map = await loadUserCache();
    return map.get(email.toLowerCase()) ?? null;
  } catch {
    return null; // never block the export on user lookup
  }
}

// Sometimes a Contact's User Lookup field gives us only `{id, name}` —
// the email is omitted. We need the email to match / auto-provision an
// app user, so we go back to the /users list (cached) and find the
// matching user by id. Same store as findZohoUserByEmail.
export async function findZohoUserById(id: string | null | undefined): Promise<ZohoUser | null> {
  if (!id) return null;
  try {
    const map = await loadUserCache();
    for (const u of map.values()) {
      if (u.id === id) return u;
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Zoho task → Case field mapping
// ─────────────────────────────────────────────────────────────
// Best-effort map. Stock Zoho Task fields: Subject, Description,
// Status, Priority, Due_Date, What_Id (linked module), Who_Id (Contact),
// $linked_module / $se_module, Owner.
//
// Custom field keys can vary per org. Override the field name for each
// target via env var, e.g.:
//   ZOHO_TASK_FIELD_CLIENT_NAME=Client_Full_Name
//   ZOHO_TASK_FIELD_PROVIDER=Ceding_Provider
//   ZOHO_TASK_FIELD_PLAN_TYPE=Plan_Type
//   ZOHO_TASK_FIELD_POLICY_REF=Policy_Number
//   ZOHO_TASK_FIELD_PLAN_SUBTYPE=Plan_Sub_Type
//   ZOHO_TASK_FIELD_DEEP_LINK=Zoho_Deep_Link

export interface MappedCase {
  clientName: string;
  clientZohoId?: string;
  planType: PlanType;
  policyRef?: string;
  providerName?: string;
  zohoCaseId?: string;
  zohoDeepLink?: string;
  rawSubject?: string;
  // Zoho task owner — used to assign the imported Case to the matching app user.
  ownerEmail?: string;
  ownerName?: string;
  ownerZohoId?: string;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    // Lookup-style fields come back as { id, name, module }
    if (v && typeof v === 'object' && 'name' in (v as Record<string, unknown>)) {
      const name = (v as Record<string, unknown>).name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  }
  return undefined;
}

function pickId(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === 'object' && 'id' in (v as Record<string, unknown>)) {
      const id = (v as Record<string, unknown>).id;
      if (typeof id === 'string' && id) return id;
    }
  }
  return undefined;
}

function inferPlanType(s: string | undefined): PlanType {
  if (!s) return PlanType.PENSION;
  const v = s.toLowerCase();
  if (v.includes('isa')) return PlanType.ISA;
  if (v.includes('gia') || v.includes('general investment')) return PlanType.GIA;
  if (v.includes('bond')) return PlanType.BOND;
  if (v.includes('final salary') || v.includes('db ') || v.includes('defined benefit')) {
    return PlanType.FINAL_SALARY;
  }
  if (v.includes('protection') || v.includes('life cover')) return PlanType.PROTECTION;
  return PlanType.PENSION;
}

export function mapZohoTaskToCase(task: Record<string, unknown>): MappedCase {
  const env = process.env;

  const clientField = env.ZOHO_TASK_FIELD_CLIENT_NAME;
  const providerField = env.ZOHO_TASK_FIELD_PROVIDER;
  const planTypeField = env.ZOHO_TASK_FIELD_PLAN_TYPE;
  const policyRefField = env.ZOHO_TASK_FIELD_POLICY_REF;
  const deepLinkField = env.ZOHO_TASK_FIELD_DEEP_LINK;

  // Client name — try custom field, then linked Contact (Who_Id), then linked Deal (What_Id), then Subject
  const clientName =
    (clientField && pickString(task, [clientField])) ||
    pickString(task, ['Who_Id']) ||
    pickString(task, ['What_Id']) ||
    pickString(task, ['$se_module', 'Subject']) ||
    'Unknown client';

  const clientZohoId =
    pickId(task, ['Who_Id']) ||
    pickId(task, ['What_Id']);

  // `Provider_group` is the actual field used on Furnley House's Zoho Tasks;
  // the older `Provider` / `Provider_Name` / `Ceding_Provider` keys are kept
  // as fallbacks so older orgs still map cleanly.
  const providerName =
    (providerField && pickString(task, [providerField])) ||
    pickString(task, ['Provider_group', 'Provider', 'Provider_Name', 'Ceding_Provider']);

  const planTypeRaw =
    (planTypeField && pickString(task, [planTypeField])) ||
    pickString(task, ['Plan_Type', 'PlanType', 'Product_Type']) ||
    pickString(task, ['Subject']);
  const planType = inferPlanType(planTypeRaw);

  const policyRef =
    (policyRefField && pickString(task, [policyRefField])) ||
    pickString(task, ['Policy_Number', 'Policy_Ref', 'Plan_Number', 'Plan_Reference']);

  const zohoDeepLink =
    (deepLinkField && pickString(task, [deepLinkField])) ||
    (typeof task.id === 'string'
      // ? `https://crm.zoho.eu/crm/tab/Tasks/${task.id}`
      ?`https://crmsandbox.zoho.eu/crm/transactionsandbox/tab/Tasks/${task.id}`
      : undefined);

  // If the task is linked to a Deal (What_Id), use that as the case-level reference
  const zohoCaseId = pickId(task, ['What_Id']);

  // Owner — Zoho Task.Owner is { id, name, email }
  const ownerObj = task.Owner as Record<string, unknown> | undefined;
  const ownerName = ownerObj && typeof ownerObj.name === 'string' ? ownerObj.name.trim() : undefined;
  const ownerEmail = ownerObj && typeof ownerObj.email === 'string' ? ownerObj.email.trim() : undefined;
  const ownerZohoId = ownerObj && typeof ownerObj.id === 'string' ? ownerObj.id.trim() : undefined;

  return {
    clientName,
    clientZohoId,
    planType,
    policyRef,
    providerName,
    zohoCaseId,
    zohoDeepLink,
    rawSubject: pickString(task, ['Subject']),
    ownerEmail,
    ownerName,
    ownerZohoId,
  };
}
