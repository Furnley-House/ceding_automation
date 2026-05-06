// backend/src/services/zohoCrm.ts
import { PlanType } from '@prisma/client';

const accountsBase = () => process.env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.eu';
const apiBase = () => process.env.ZOHO_API_BASE ?? 'https://sandbox.zohoapis.eu/crm/v6';

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let cache: TokenCache | null = null;

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
    scope: 'ZohoCRM.modules.tasks.ALL,ZohoCRM.settings.fields.READ,ZohoCRM.users.READ',
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
  planSubType?: string;
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
  const planSubTypeField = env.ZOHO_TASK_FIELD_PLAN_SUBTYPE;
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

  const providerName =
    (providerField && pickString(task, [providerField])) ||
    pickString(task, ['Provider', 'Provider_Name', 'Ceding_Provider']);

  const planTypeRaw =
    (planTypeField && pickString(task, [planTypeField])) ||
    pickString(task, ['Plan_Type', 'PlanType', 'Product_Type']) ||
    pickString(task, ['Subject']);
  const planType = inferPlanType(planTypeRaw);

  const planSubType =
    (planSubTypeField && pickString(task, [planSubTypeField])) ||
    pickString(task, ['Plan_Sub_Type', 'Sub_Plan_Type']);

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
    planSubType,
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
