// backend/src/services/zohoCreator.ts
// Thin client for the Zoho Creator Data API (v2.1).
//
// Why this exists: Palindrome is not a request/response transcription API. It
// is a worker that sweeps a Creator form for rows flagged "Ready For
// Processing", does the work, and stamps the row when it finishes. Creator is
// therefore the job queue, and this module is how the ceding backend enqueues
// and reads back.
//
// The org's existing meeting pipeline does the same thing from Deluge
// (`zoho.creator.createRecord(...)` in UploadMeetingInfoToCreator2). We reuse
// the SAME app and the SAME form deliberately — the Palindrome trigger takes
// no payload, so it can only sweep the one form it is bound to. Writing to a
// new form would mean Palindrome never sees our rows.
//
// Auth reuses the CRM refresh token via getZohoAccessToken(). That token must
// have been minted with ZohoCreator.form.CREATE + ZohoCreator.report.READ —
// see the scope list in zohoCrm.ts::buildAuthorizeUrl. Tokens minted before
// those scopes were added will fail here with an OAUTH_SCOPE_MISMATCH.

import axios from 'axios';
import { getZohoAccessToken } from './zohoCrm';

// Read env at call-time so .env edits are picked up without a rebuild —
// same convention as workdrive.ts.
const creatorApiBase = () =>
  process.env.ZOHO_CREATOR_API_BASE ?? 'https://www.zohoapis.eu/creator/v2.1';

const appOwner = () => process.env.ZOHO_CREATOR_APP_OWNER ?? 'zoho_jan116';
const appName = () =>
  process.env.ZOHO_CREATOR_APP_NAME ?? 'meeting-recording-processing';

export function isCreatorConfigured(): boolean {
  return Boolean(appOwner() && appName() && process.env.ZOHO_REFRESH_TOKEN);
}

// ── Errors ────────────────────────────────────────────────────────────────
// Scope failures are the single most likely thing to go wrong on first run,
// so they get their own type and a message that names the fix rather than
// leaving a raw Zoho error code for someone to search.
export class CreatorScopeError extends Error {
  constructor(detail: string) {
    super(
      `Zoho Creator rejected the token (${detail}). The refresh token was ` +
        `minted before ZohoCreator.* scopes were added. Re-run ` +
        `/api/crm/oauth/authorize and replace ZOHO_REFRESH_TOKEN in .env.`,
    );
    this.name = 'CreatorScopeError';
  }
}

export class CreatorApiError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'CreatorApiError';
  }
}

// Creator does not use HTTP status alone to signal failure — it will answer
// 200 with an error code in the body. Observed: PATCHing a row on a form that
// carries a workflow the caller cannot run returns
//   HTTP 200 {"code":9750, ...}
// and silently discards the update. Checking only res.status therefore
// reports success for writes that never happened.
//
// 3000 is Creator's success code for data APIs.
const CREATOR_OK = 3000;

function assertCreatorOk(body: unknown, what: string): void {
  const code = (body as { code?: number } | null)?.code;
  if (typeof code === 'number' && code !== CREATOR_OK) {
    const message =
      (body as { message?: string } | null)?.message ?? `Creator returned code ${code}`;
    throw new CreatorApiError(200, body, `${what} refused by Creator (code ${code}): ${message}`);
  }
}

function mapCreatorError(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data;
    const asText = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    if (status === 401 || asText.includes('OAUTH_SCOPE_MISMATCH') || asText.includes('INVALID_OAUTHSCOPE')) {
      throw new CreatorScopeError(asText.slice(0, 200));
    }
    throw new CreatorApiError(status, body, `Zoho Creator request failed (${status ?? 'no status'}): ${asText.slice(0, 300)}`);
  }
  throw err instanceof Error ? err : new Error(String(err));
}

// ── Create ────────────────────────────────────────────────────────────────

export interface CreateRecordResult {
  /** Creator's internal row ID — our handle for polling this job. */
  recordId: string | null;
  raw: unknown;
}

/**
 * Add one row to a Creator form.
 *
 * `data` uses Creator FIELD LINK NAMES, not display labels. Name-type fields
 * take a nested object, e.g.
 *   { Client_1_Name: { first_name: "Jane", last_name: "Doe" } }
 * which is why the payload type is loose here rather than a strict record of
 * strings.
 */
export async function createCreatorRecord(
  formLinkName: string,
  data: Record<string, unknown>,
): Promise<CreateRecordResult> {
  const token = await getZohoAccessToken();
  const url = `${creatorApiBase()}/data/${appOwner()}/${appName()}/form/${formLinkName}`;

  try {
    const { data: body } = await axios.post(
      url,
      { data },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json',
          // Same strict validation as the GET path — see getCreatorRecords.
          Accept: 'application/json',
        },
        timeout: 20_000,
      },
    );

    assertCreatorOk(body, 'Record create');

    // Creator v2.1 replies { code, data: { ID }, message } on success.
    const inner = (body as { data?: Record<string, unknown> })?.data;
    const recordId =
      (inner?.ID as string | undefined) ?? (inner?.id as string | undefined) ?? null;
    return { recordId, raw: body };
  } catch (err) {
    mapCreatorError(err);
  }
}

// ── Read ──────────────────────────────────────────────────────────────────

export interface CreatorRecord {
  id: string;
  [field: string]: unknown;
}

/**
 * Read rows from a Creator report.
 *
 * `criteria` is Creator's own filter syntax, e.g.
 *   (Meeting_Filename == "FH-2026-000123_call.mp3")
 * Passing undefined returns the most recent rows, newest first.
 */
export async function getCreatorRecords(
  reportLinkName: string,
  criteria?: string,
  limit = 20,
): Promise<CreatorRecord[]> {
  const token = await getZohoAccessToken();
  const url = `${creatorApiBase()}/data/${appOwner()}/${appName()}/report/${reportLinkName}`;

  // Creator rejects anything other than 200 / 500 / 1000 here with code 9250 —
  // it is a page size, not a row limit. Round up to the smallest legal page
  // that covers `limit`, then trim client-side.
  const maxRecords = limit <= 200 ? 200 : limit <= 500 ? 500 : 1000;

  try {
    const { data: body } = await axios.get(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        // Creator validates this header strictly and accepts only
        // "application/json" or "text/csv" (code 9210). Axios would
        // otherwise send "application/json, text/plain, */*" and be refused.
        Accept: 'application/json',
      },
      params: {
        ...(criteria ? { criteria } : {}),
        max_records: maxRecords,
      },
      timeout: 20_000,
    });

    const rows = ((body as { data?: unknown[] })?.data ?? []) as Array<Record<string, unknown>>;
    return rows
      .slice(0, limit)
      .map((r) => ({ ...r, id: String(r.ID ?? r.id ?? '') }));
  } catch (err) {
    // "No rows matched" is not a failure — a poller asking about a record
    // that has been deleted, or a criteria that matches nothing, should get
    // an empty list. Creator signals this inconsistently:
    //   404 + code 3100  (report has no rows)
    //   400 + code 9280  ("No records found matching the given criteria")
    // Flatten both to [] rather than throwing, or every caller has to know
    // Zoho's error vocabulary.
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const asText = JSON.stringify(err.response?.data ?? {});
      const noRows =
        asText.includes('3100') ||
        asText.includes('9280') ||
        asText.toLowerCase().includes('no records');
      if ((status === 404 || status === 400) && noRows) return [];
    }
    mapCreatorError(err);
  }
}

// ── Update ────────────────────────────────────────────────────────────────

/**
 * Patch fields on one Creator row.
 *
 * Used to stamp a ceding row Completed once we have collected its transcript.
 * Palindrome does not reliably do this itself — rows have been observed with
 * their transcript written to WorkDrive while processing_status sat on
 * "Ready For Processing" indefinitely — which leaves the shared report
 * looking like a backlog of stuck jobs.
 *
 * ONLY call this for rows this application created (a Transcript row holds
 * the id in palindromeRecordId). The form is shared with the org's meeting
 * pipeline and their rows are not ours to touch.
 */
export async function updateCreatorRecord(
  reportLinkName: string,
  recordId: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const token = await getZohoAccessToken();
  const url = `${creatorApiBase()}/data/${appOwner()}/${appName()}/report/${reportLinkName}/${recordId}`;

  try {
    const { data: body } = await axios.patch(
      url,
      { data },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 20_000,
      },
    );
    assertCreatorOk(body, 'Record update');
    return body;
  } catch (err) {
    mapCreatorError(err);
  }
}

/** Convenience: fetch a single row by its Creator record ID. */
export async function getCreatorRecordById(
  reportLinkName: string,
  recordId: string,
): Promise<CreatorRecord | null> {
  const rows = await getCreatorRecords(reportLinkName, `(ID == ${recordId})`, 1);
  return rows[0] ?? null;
}
