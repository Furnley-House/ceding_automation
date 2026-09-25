// backend/src/services/recordingLinks.ts
// Short-lived, signed, unauthenticated download URLs for call recordings.
//
// ── Why this exists ───────────────────────────────────────────────────────
// Palindrome reads a recording by fetching a URL over plain HTTP; it does not
// read the WorkDrive folder it has been granted access to. (Proven: it failed
// a submission with "Failed to download file after 3 attempts: Redirect
// response '302'" after following a WorkDrive permalink to a login page. The
// folder share is what lets it WRITE its output back.)
//
// The org's meeting pipeline gets away with this because Zoho Meeting hands
// out its own fetchable URL (download.zoho.eu/webdownload?event-id=...).
// Ceding recordings live in WorkDrive and RingCentral, and neither does.
// WorkDrive external download links would solve it, but they are disabled
// org-wide and that is the correct setting to keep.
//
// So the backend serves the audio itself, behind a URL that is:
//   * signed    — HMAC-SHA256 over the payload; nothing else validates
//   * expiring  — minutes, not forever
//   * scoped    — one WorkDrive file, nothing else reachable through it
//   * revocable — rotate RECORDING_LINK_SECRET and every issued URL dies
//   * audited   — the route logs each fetch against the case
//
// That is strictly tighter than the meeting pipeline's Zoho URL, which has no
// expiry we control, and it needs no WorkDrive sharing scopes.

import crypto from 'crypto';

const DEFAULT_TTL_MIN = 30;

function secret(): string {
  const s = process.env.RECORDING_LINK_SECRET ?? '';
  if (!s || s.startsWith('your-')) {
    throw new Error(
      'RECORDING_LINK_SECRET is not set. Generate one with ' +
        '`openssl rand -hex 32` and add it to .env — signed recording links ' +
        'cannot be issued without it.',
    );
  }
  return s;
}

function ttlMinutes(): number {
  const n = Number(process.env.RECORDING_LINK_TTL_MIN);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MIN;
}

/**
 * Externally reachable base URL for this backend, e.g.
 *   https://ca-cedingai-backend-staging....azurecontainerapps.io
 * or a tunnel host when developing locally.
 *
 * Deliberately NOT defaulted to localhost: a localhost URL in a Creator row
 * is worse than no URL, because Palindrome fails on it silently-ish three
 * times before giving up. Better to fail loudly at submit time.
 */
function publicBaseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL ?? '';
  const trimmed = raw.replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error(
      'PUBLIC_BASE_URL is not set. Palindrome fetches recordings over the ' +
        'public internet, so the backend must know its own externally ' +
        'reachable URL. Locally, run a tunnel (cloudflared / ngrok) and set ' +
        'PUBLIC_BASE_URL to the tunnel host.',
    );
  }
  if (/localhost|127\.0\.0\.1/i.test(trimmed)) {
    throw new Error(
      `PUBLIC_BASE_URL is "${trimmed}", which Palindrome cannot reach. ` +
        'Use a tunnel host locally, or the deployed backend URL.',
    );
  }
  return trimmed;
}

// ── Token format ──────────────────────────────────────────────────────────
// <base64url(payload)>.<base64url(hmac)>
//
// Payload is JSON: { f: workdriveFileId, n: filename, c: caseId, e: expiryMs }
// Kept short because the whole token ends up in a Creator text field.

interface RecordingTokenPayload {
  f: string; // WorkDrive file id
  n: string; // original filename (for Content-Disposition)
  c: string; // case id — for audit attribution
  e: number; // expiry, epoch ms
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadB64: string): string {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadB64).digest());
}

export interface SignedRecordingLink {
  url: string;
  token: string;
  expiresAt: Date;
}

export function createRecordingLink(args: {
  workdriveFileId: string;
  filename: string;
  caseId: string;
  ttlMinutes?: number;
}): SignedRecordingLink {
  const ttl = args.ttlMinutes ?? ttlMinutes();
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  const payload: RecordingTokenPayload = {
    f: args.workdriveFileId,
    n: args.filename,
    c: args.caseId,
    e: expiresAt.getTime(),
  };

  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const token = `${payloadB64}.${sign(payloadB64)}`;

  return {
    url: `${publicBaseUrl()}/api/public/recordings/${token}`,
    token,
    expiresAt,
  };
}

export type VerifyFailure =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'EXPIRED';

export type VerifyResult =
  | { ok: true; fileId: string; filename: string; caseId: string; expiresAt: Date }
  | { ok: false; reason: VerifyFailure };

export function verifyRecordingToken(token: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'MALFORMED' };
  const [payloadB64, providedSig] = parts;

  let expectedSig: string;
  try {
    expectedSig = sign(payloadB64);
  } catch {
    // Missing secret — treat as a signature failure rather than leaking config
    // state to an unauthenticated caller. The route logs the real cause.
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  // Constant-time compare. Length check first because timingSafeEqual throws
  // on mismatched lengths.
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  let payload: RecordingTokenPayload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8')) as RecordingTokenPayload;
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (!payload.f || typeof payload.e !== 'number') {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (Date.now() > payload.e) {
    return { ok: false, reason: 'EXPIRED' };
  }

  return {
    ok: true,
    fileId: payload.f,
    filename: payload.n ?? 'recording.mp3',
    caseId: payload.c ?? '',
    expiresAt: new Date(payload.e),
  };
}

/** True when links can actually be issued — used to fail fast at submit time. */
export function isRecordingLinkConfigured(): boolean {
  try {
    secret();
    publicBaseUrl();
    return true;
  } catch {
    return false;
  }
}

/** Human-readable reason links are unavailable, for error responses. */
export function recordingLinkConfigError(): string | null {
  try {
    secret();
    publicBaseUrl();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
