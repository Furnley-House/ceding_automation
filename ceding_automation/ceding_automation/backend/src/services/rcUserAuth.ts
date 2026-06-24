// backend/src/services/rcUserAuth.ts
// Per-user RC mapping using the admin JWT — no per-user OAuth.
// Each Ceding user is mapped to ONE RingCentral extension. The backend uses the
// admin JWT to call `/extension/{rcExtensionId}/call-log` so the user only sees
// THEIR own recordings.
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { getAccessToken } from "./ringcentral";

const prisma = new PrismaClient();
const RC_SERVER = process.env.RINGCENTRAL_SERVER_URL ?? "https://platform.ringcentral.com";

export interface RcExtensionInfo {
  id: string;
  extensionNumber?: string;
  name: string;
  email?: string;
  type?: string;
  status?: string;
}

// ── List all extensions in the RC account (admin JWT) ─────────────────────
export async function listRcExtensions(): Promise<RcExtensionInfo[]> {
  const token = await getAccessToken();
  const { data } = await axios.get(
    `${RC_SERVER}/restapi/v1.0/account/~/extension`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { perPage: 250, status: "Enabled" },
    }
  );
  const records = ((data as Record<string, unknown>)?.records ?? []) as Record<string, unknown>[];
  return records.map((r) => {
    const contact = (r.contact as Record<string, unknown> | undefined) ?? {};
    const first = contact.firstName as string | undefined;
    const last = contact.lastName as string | undefined;
    const name = [first, last].filter(Boolean).join(" ") || (r.name as string) || "Extension";
    return {
      id: String(r.id),
      extensionNumber: r.extensionNumber as string | undefined,
      name,
      email: contact.email as string | undefined,
      type: r.type as string | undefined,
      status: r.status as string | undefined,
    };
  });
}

// ── Fetch a single extension by id ────────────────────────────────────────
export async function fetchRcExtension(extensionId: string): Promise<RcExtensionInfo | null> {
  const token = await getAccessToken();
  try {
    const { data } = await axios.get(
      `${RC_SERVER}/restapi/v1.0/account/~/extension/${extensionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const r = data as Record<string, unknown>;
    const contact = (r.contact as Record<string, unknown> | undefined) ?? {};
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || (r.name as string) || "Extension";
    return {
      id: String(r.id),
      extensionNumber: r.extensionNumber as string | undefined,
      name,
      email: contact.email as string | undefined,
      type: r.type as string | undefined,
      status: r.status as string | undefined,
    };
  } catch {
    return null;
  }
}

// ── Auto-connect: find the RC extension whose email matches the user's app email ──
export async function autoConnectUserByEmail(
  userId: string,
  userEmail: string
): Promise<{ matched: boolean; extension?: RcExtensionInfo }> {
  const extensions = await listRcExtensions();
  const normalize = (s?: string) => (s ?? "").trim().toLowerCase();
  const target = normalize(userEmail);
  const match = extensions.find((e) => normalize(e.email) === target);
  if (!match) return { matched: false };

  await prisma.user.update({
    where: { id: userId },
    data: {
      rcExtensionId: match.id,
      rcOwnerName: match.name,
      rcConnectedAt: new Date(),
    },
  });
  return { matched: true, extension: match };
}

// ── Map a Ceding user to whichever RC extension their RC widget is signed in as ──
// widgetLoginNumber comes from the widget's rc-login-status-notify event and looks
// like "+441162185867*777" where 777 is the extension number. Since only someone
// who actually authenticated to RC as that extension can produce this value, it
// counts as proof of ownership.
export async function connectUserByWidgetLogin(
  userId: string,
  widgetLoginNumber: string
): Promise<{ matched: boolean; extension?: RcExtensionInfo; error?: string }> {
  // Format: "+E164PhoneNumber*ExtensionNumber" — split on '*'
  const parts = widgetLoginNumber.split("*");
  if (parts.length < 2 || !parts[1]) {
    return { matched: false, error: `Could not parse RC widget login: ${widgetLoginNumber}` };
  }
  const extensionNumber = parts[1].trim();
  const extensions = await listRcExtensions();
  const match = extensions.find((e) => e.extensionNumber === extensionNumber);
  if (!match) {
    return { matched: false, error: `RC extension ${extensionNumber} not found in account` };
  }
  await prisma.user.update({
    where: { id: userId },
    data: {
      rcExtensionId: match.id,
      rcOwnerName: match.name,
      rcConnectedAt: new Date(),
    },
  });
  return { matched: true, extension: match };
}

// ── Manual pick: save a specific extensionId for the user ────────────────
export async function setUserRcExtension(userId: string, extensionId: string): Promise<RcExtensionInfo> {
  const ext = await fetchRcExtension(extensionId);
  if (!ext) throw new Error("Extension not found in RingCentral account");
  await prisma.user.update({
    where: { id: userId },
    data: {
      rcExtensionId: ext.id,
      rcOwnerName: ext.name,
      rcConnectedAt: new Date(),
    },
  });
  return ext;
}

// ── Read the user's mapped extension ID, throw 403 if not mapped ─────────
export async function getUserRcExtensionId(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { rcExtensionId: true },
  });
  if (!user?.rcExtensionId) {
    throw Object.assign(
      new Error("Connect your RingCentral extension first"),
      { rcStatus: 403 }
    );
  }
  return user.rcExtensionId;
}

export async function disconnectRcUser(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      rcExtensionId: null,
      rcOwnerName: null,
      rcConnectedAt: null,
      rcRefreshToken: null,
      rcAccessToken: null,
      rcAccessTokenExpiresAt: null,
      rcAccountId: null,
    },
  });
}

export async function getRcConnectionStatus(userId: string): Promise<{
  connected: boolean;
  ownerName?: string | null;
  extensionId?: string | null;
  connectedAt?: Date | null;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { rcExtensionId: true, rcOwnerName: true, rcConnectedAt: true },
  });
  return {
    connected: !!user?.rcExtensionId,
    ownerName: user?.rcOwnerName,
    extensionId: user?.rcExtensionId,
    connectedAt: user?.rcConnectedAt,
  };
}
