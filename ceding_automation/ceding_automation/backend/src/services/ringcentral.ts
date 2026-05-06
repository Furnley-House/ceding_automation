// backend/src/services/ringcentral.ts
// Production RingCentral integration using JWT auth + Ring-Out API.
// Falls back gracefully when credentials are not configured.
import axios from "axios";

const RC_SERVER =
  process.env.RINGCENTRAL_SERVER_URL ?? "https://platform.ringcentral.com";
const CLIENT_ID = process.env.RINGCENTRAL_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.RINGCENTRAL_CLIENT_SECRET ?? "";
const RC_JWT = process.env.RINGCENTRAL_JWT ?? "";
export const AGENT_PHONE = process.env.RINGCENTRAL_AGENT_PHONE ?? "";

export function isRingCentralConfigured(): boolean {
  return (
    CLIENT_ID.length > 0 &&
    !CLIENT_ID.startsWith("your-") &&
    CLIENT_SECRET.length > 0 &&
    !CLIENT_SECRET.startsWith("your-") &&
    RC_JWT.length > 0 &&
    !RC_JWT.startsWith("your-") &&
    AGENT_PHONE.length > 0
  );
}

// ── Token cache (JWT flow refreshes automatically) ────────────────────────
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }

  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const { data } = await axios.post(
    `${RC_SERVER}/restapi/oauth/token`,
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: RC_JWT,
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${creds}`,
      },
    }
  );

  cachedToken = {
    value: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

// ── Ring-Out types ────────────────────────────────────────────────────────
export type RingOutStatus =
  | "Proceeding"
  | "Success"
  | "NoAnswer"
  | "Rejected"
  | "HangUp"
  | "IPPhoneOffline"
  | "NotActivated"
  | "CallConnected";

export interface RingOutSession {
  id: string;
  status: RingOutStatus;
}

// ── Initiate outbound call ────────────────────────────────────────────────
// RingCentral ring-out dials the agent's phone first, then connects to target.
export async function initiateRingOut(toPhone: string): Promise<RingOutSession> {
  if (!isRingCentralConfigured()) {
    throw new Error(
      "RingCentral not configured. Set RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET, RINGCENTRAL_JWT and RINGCENTRAL_AGENT_PHONE in .env."
    );
  }

  const token = await getAccessToken();

  const { data } = await axios.post(
    `${RC_SERVER}/restapi/v1.0/account/~/extension/~/ring-out`,
    {
      from: { phoneNumber: AGENT_PHONE },
      to: { phoneNumber: toPhone },
      playPrompt: false,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  return {
    id: String(data.id),
    status: (data.status?.callStatus as RingOutStatus) ?? "Proceeding",
  };
}

// ── Poll call status ──────────────────────────────────────────────────────
export async function getRingOutStatus(sessionId: string): Promise<RingOutSession> {
  if (!isRingCentralConfigured()) throw new Error("RingCentral not configured");

  const token = await getAccessToken();
  const { data } = await axios.get(
    `${RC_SERVER}/restapi/v1.0/account/~/extension/~/ring-out/${sessionId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return {
    id: String(data.id),
    status: (data.status?.callStatus as RingOutStatus) ?? "Proceeding",
  };
}

// ── Cancel / hang up ──────────────────────────────────────────────────────
export async function cancelRingOut(sessionId: string): Promise<void> {
  if (!isRingCentralConfigured()) return;
  const token = await getAccessToken();
  await axios.delete(
    `${RC_SERVER}/restapi/v1.0/account/~/extension/~/ring-out/${sessionId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// ── Fetch most-recent call recording URL ─────────────────────────────────
// RingCentral stores call legs in call-log. We look up the most recent entry
// matching the given ringCentralId (sessionId) to find the recording media URL.
export async function getRecordingUrl(ringCentralId: string): Promise<string | null> {
  if (!isRingCentralConfigured()) return null;
  try {
    const token = await getAccessToken();
    const { data } = await axios.get(
      `${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log/${ringCentralId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { showRecording: true },
      }
    );
    return data?.recording?.contentUri ?? null;
  } catch {
    return null;
  }
}
