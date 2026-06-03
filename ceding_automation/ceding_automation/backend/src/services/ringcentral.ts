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

export async function getAccessToken(): Promise<string> {
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

// ── List recent call recordings from RC call-log ─────────────────────────────
export interface CallRecordingEntry {
  id: string;
  sessionId: string;
  startTime: string;
  duration: number;
  direction: string;
  from: { phoneNumber: string; name?: string };
  to: { phoneNumber: string; name?: string };
  hasRecording: boolean;
  recordingId?: string;
  contentUri?: string;
}

// List recordings using a caller-supplied access token (obtained from the RC widget's
// network requests). This bypasses server-side JWT config entirely — any team member
// who is logged into the RC widget can copy their token from DevTools and use it here.
//
// Sources tried per server:
//   1. call-log?showRecording=true  — actual call recordings (requires recording enabled)
//   2. message-store?messageType=VoiceMail — voicemails (RC widget "Recordings" tab shows these)
export async function listCallRecordingsWithToken(
  bearerToken: string,
  options: { perPage?: number; extensionOnly?: boolean } = {}
): Promise<CallRecordingEntry[]> {
  // Try the configured server first, then sandbox — token is only valid on the
  // environment the RC widget is using (prod or devtest/sandbox).
  // Only try the configured server — devtest domain has DNS resolution issues on some networks
  const servers = [...new Set([RC_SERVER, 'https://platform.ringcentral.com'])];
  const perPage = options.perPage ?? 30;
  const authHeader = { Authorization: `Bearer ${bearerToken}` };

  // Helper to map a call-log record to a CallRecordingEntry
  function mapCallLogRecord(r: Record<string, unknown>, mediaServer: string): CallRecordingEntry | null {
    const rec = r.recording as Record<string, unknown> | undefined;
    if (!rec) return null;
    const recId = rec.id as string | undefined;
    const contentUri = (rec.contentUri as string | undefined)
      || (rec.uri as string | undefined)
      || (recId ? `${mediaServer}/restapi/v1.0/account/~/recording/${recId}/content` : '');
    if (!contentUri) return null;
    return {
      id: r.id as string,
      sessionId: (r.telephonySessionId as string) || (r.sessionId as string) || (r.id as string),
      startTime: r.startTime as string,
      duration: (r.duration as number) ?? 0,
      direction: (r.direction as string) ?? 'Outbound',
      from: (r.from as { phoneNumber: string; name?: string }) ?? { phoneNumber: '' },
      to: (r.to as { phoneNumber: string; name?: string }) ?? { phoneNumber: '' },
      hasRecording: true,
      recordingId: recId,
      contentUri,
    };
  }

  let lastErr: unknown = null;
  let got401 = false;
  for (const server of servers) {
    const results: CallRecordingEntry[] = [];
    const seen = new Set<string>();
    let serverReachable = false;
    const mediaServer = server.replace('platform.', 'media.');

    function addRecord(entry: CallRecordingEntry | null) {
      if (entry && !seen.has(entry.id)) { seen.add(entry.id); results.push(entry); }
    }

    // ── 1. Extension call-log (no type filter — picks up all voice calls) ────
    try {
      const { data } = await axios.get(
        `${server}/restapi/v1.0/account/~/extension/~/call-log`,
        { headers: authHeader, params: { showRecording: true, perPage, dateFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() } }
      );
      serverReachable = true;
      const records = ((data as Record<string, unknown>)?.records ?? []) as Record<string, unknown>[];
      console.log(`[RC] extension call-log ${server}: ${records.length} records`);
      records.forEach((r) => addRecord(mapCallLogRecord(r, mediaServer)));
    } catch (err: unknown) {
      lastErr = err;
      if ((err as any)?.response?.status === 401) got401 = true;
      console.log(`[RC] extension call-log ${server} failed:`, (err as any)?.response?.status);
    }

    // ── 2. Call-log-sync (what the RC widget uses — may include calls the normal log misses) ─
    if (serverReachable) {
      try {
        const { data: syncData } = await axios.get(
          `${server}/restapi/v1.0/account/~/extension/~/call-log-sync`,
          { headers: authHeader, params: { syncType: 'FSync', showRecording: true, recordCount: perPage } }
        );
        const syncRecords = ((syncData as Record<string, unknown>)?.records ?? []) as Record<string, unknown>[];
        console.log(`[RC] call-log-sync ${server}: ${syncRecords.length} records`);
        syncRecords.forEach((r) => addRecord(mapCallLogRecord(r, mediaServer)));
      } catch {
        // best-effort
      }
    }

    // ── 3. Account-level call-log — only when extensionOnly is false (shows all extensions) ─
    if (serverReachable && !options.extensionOnly) {
      try {
        const { data: accData } = await axios.get(
          `${server}/restapi/v1.0/account/~/call-log`,
          { headers: authHeader, params: { showRecording: true, perPage, dateFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() } }
        );
        const accRecords = ((accData as Record<string, unknown>)?.records ?? []) as Record<string, unknown>[];
        console.log(`[RC] account call-log ${server}: ${accRecords.length} records`);
        accRecords.forEach((r) => addRecord(mapCallLogRecord(r, mediaServer)));
      } catch {
        // requires admin scope — best-effort
      }
    }

    // ── 4. Voicemails from message-store ──────────────────────────────────
    if (serverReachable) {
      try {
        const { data: vmData } = await axios.get(
          `${server}/restapi/v1.0/account/~/extension/~/message-store`,
          { headers: authHeader, params: { messageType: 'VoiceMail', perPage } }
        );
        const msgs = ((vmData as Record<string, unknown>)?.records ?? []) as Record<string, unknown>[];
        console.log(`[RC] voicemails ${server}: ${msgs.length}`);
        for (const m of msgs) {
          const atts = (m.attachments as Array<Record<string, unknown>>) ?? [];
          const att = atts.find((a) => a.contentUri || a.uri);
          if (!att) continue;
          const contentUri = (att.contentUri as string | undefined) || (att.uri as string | undefined) || '';
          const from = (m.from as { phoneNumber?: string; name?: string }) ?? {};
          const toList = (m.to as Array<{ phoneNumber?: string; name?: string }>) ?? [];
          const to = toList[0] ?? {};
          addRecord({
            id: m.id as string,
            sessionId: (m.conversationId as string) || (m.id as string),
            startTime: (m.creationTime as string) || '',
            duration: (m.duration as number) ?? 0,
            direction: (m.direction as string) ?? 'Inbound',
            from: { phoneNumber: from.phoneNumber ?? '', name: from.name },
            to: { phoneNumber: to.phoneNumber ?? '', name: to.name },
            hasRecording: true,
            recordingId: att.id as string | undefined,
            contentUri,
          });
        }
      } catch {
        // best-effort
      }
    }

    console.log(`[RC] total results from ${server}: ${results.length}`);
    if (serverReachable) return results;
  }
  if (got401) throw Object.assign(new Error('RC token expired or invalid — paste a fresh token from DevTools'), { rcStatus: 403 });
  throw lastErr ?? new Error('Failed to fetch recordings from RingCentral');
}

// ── Send an audio buffer directly to Azure Whisper ────────────────────────
export async function transcribeAudioBuffer(audioBuffer: Buffer, filename: string = 'recording.mp3'): Promise<{ transcript: string | null; error?: string }> {
  const whisperDeployment = process.env.AZURE_OPENAI_WHISPER_DEPLOYMENT ?? 'whisper';
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureApiKey = process.env.AZURE_OPENAI_API_KEY;

  if (!azureEndpoint || !azureApiKey || azureApiKey.startsWith('your-') || azureEndpoint.includes('YOUR_RESOURCE')) {
    return { transcript: null, error: 'Azure OpenAI not configured' };
  }

  const endpoint = azureEndpoint.replace(/\/$/, '');
  const url = `${endpoint}/openai/deployments/${whisperDeployment}/audio/transcriptions?api-version=2024-06-01`;

  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file', audioBuffer, { filename, contentType: 'audio/mpeg' });
  form.append('model', whisperDeployment);
  form.append('response_format', 'text');

  const resp = await axios.post(url, form, {
    headers: { 'api-key': azureApiKey, ...form.getHeaders() },
  });
  const text = typeof resp.data === 'string' ? resp.data.trim() : (resp.data as any)?.text ?? null;
  return { transcript: text || null };
}

// ── Transcribe a recording from RC media server (downloads + sends to Whisper) ──
export async function transcribeRecordingWithToken(
  contentUri: string,
  bearerToken: string
): Promise<{ transcript: string | null; error?: string }> {
  const audioResp = await axios.get(contentUri, {
    headers: { Authorization: `Bearer ${bearerToken}` },
    responseType: 'arraybuffer',
  });
  return transcribeAudioBuffer(Buffer.from(audioResp.data as ArrayBuffer), 'recording.mp3');
}

// Uses server-side JWT — no user token required. Reuses the same multi-source logic.
export async function listCallRecordings(options: {
  phoneNumber?: string;
  dateFrom?: string;
  perPage?: number;
}): Promise<CallRecordingEntry[]> {
  if (!isRingCentralConfigured()) {
    throw new Error('RingCentral is not configured on the server. Set RINGCENTRAL_CLIENT_ID, CLIENT_SECRET, JWT and AGENT_PHONE in .env.');
  }
  const token = await getAccessToken();
  return listCallRecordingsWithToken(token, { perPage: options.perPage ?? 20, extensionOnly: true });
}

// Transcribe a recording using the server-side JWT — no user token required.
export async function transcribeRecording(contentUri: string): Promise<{ transcript: string | null; error?: string }> {
  if (!isRingCentralConfigured()) return { transcript: null, error: 'RingCentral not configured' };
  const token = await getAccessToken();
  return transcribeRecordingWithToken(contentUri, token);
}

// ── Fetch transcript for a completed call via RC AI Speech-to-Text ────────────
// Steps: call-log lookup → recording contentUri → RC AI STT job → poll for result.
// Returns transcript text, or null if the recording isn't ready / plan lacks AI features.
export async function fetchCallTranscript(telephonySessionId: string): Promise<{
  transcript: string | null;
  hasRecording: boolean;
  jobPending: boolean;
}> {
  if (!isRingCentralConfigured()) throw new Error('RingCentral not configured');
  const token = await getAccessToken();

  // 1. Find the call log record for this session
  let recording: Record<string, unknown> | undefined;
  try {
    const { data: logResp } = await axios.get(
      `${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // Try telephonySessionId parameter first, then sessionId
        params: { telephonySessionId, showRecording: true, type: 'Voice' },
      }
    );
    const record = ((logResp as Record<string, unknown>)?.records as Record<string, unknown>[] | undefined)?.[0];
    recording = record?.recording as Record<string, unknown> | undefined;
  } catch {
    return { transcript: null, hasRecording: false, jobPending: false };
  }

  if (!recording?.contentUri) {
    return { transcript: null, hasRecording: false, jobPending: false };
  }

  // 2. Submit recording to RC AI Speech-to-Text (requires RingEX AI add-on)
  try {
    const { data: jobResp } = await axios.post(
      `${RC_SERVER}/ai/audio/v1/async/speech-to-text`,
      {
        contentUri: recording.contentUri,
        encoding: 'Mpeg',
        languageCode: 'en-US',
        speakerCount: 2,
        separateSpeakerPerChannel: false,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    const jobId = (jobResp as Record<string, unknown>)?.jobId as string | undefined;
    if (!jobId) return { transcript: null, hasRecording: true, jobPending: false };

    // 3. Poll for completion — up to ~30 seconds
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const { data: result } = await axios.get(
        `${RC_SERVER}/ai/audio/v1/async/speech-to-text/${jobId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const r = result as Record<string, unknown>;

      if (r.status === 'Completed') {
        const segments = (r.transcript ?? []) as Array<{ speakerId?: string; text: string }>;
        const text = segments.map((s) => `[${s.speakerId ?? 'Speaker'}] ${s.text}`).join('\n');
        return { transcript: text || null, hasRecording: true, jobPending: false };
      }
      if (r.status === 'Failed') break;
    }

    // Job still in-flight after our wait window
    return { transcript: null, hasRecording: true, jobPending: true };
  } catch {
    // AI plan not enabled on this account
    return { transcript: null, hasRecording: true, jobPending: false };
  }
}
