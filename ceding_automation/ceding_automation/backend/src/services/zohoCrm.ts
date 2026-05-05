// backend/src/services/zohoCrm.ts
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
