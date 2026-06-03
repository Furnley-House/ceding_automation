// backend/src/services/workdrive.ts
// Upload files (call recordings, transcripts, generated PDFs) to Zoho WorkDrive.
import axios from 'axios';
import FormData from 'form-data';
import { getZohoAccessToken } from './zohoCrm';

// Read env at call-time, not module-load, so .env edits are picked up without rebuilding
const workdriveApiBase = () => process.env.ZOHO_WORKDRIVE_API_BASE ?? 'https://www.zohoapis.eu/workdrive/api/v1';
// Sandbox/test default for the Furnley House ceding recordings folder. Used
// when ZOHO_WORKDRIVE_FOLDER_ID isn't set (or is still the .env.example
// placeholder). Production deployments MUST set the env var explicitly.
const DEFAULT_WORKDRIVE_FOLDER_ID = 'a7yip2d39bf2cd6074a09a5190cf73e7a61bf';
const defaultFolderId = () => {
  const fromEnv = process.env.ZOHO_WORKDRIVE_FOLDER_ID;
  if (fromEnv && !fromEnv.startsWith('your-')) return fromEnv;
  return DEFAULT_WORKDRIVE_FOLDER_ID;
};

export interface WorkDriveUploadResult {
  id: string;
  name: string;
  permalink?: string;
  resourceId?: string;
}

export interface WorkDriveFile {
  id: string;
  name: string;
  extension?: string;
  sizeBytes?: number;
  createdTime?: string;
  modifiedTime?: string;
  permalink?: string;
  downloadUrl?: string;
}

// List files in a WorkDrive folder (default folder if no ID provided).
export async function listWorkDriveFiles(folderId?: string): Promise<WorkDriveFile[]> {
  const parentId = folderId ?? defaultFolderId();
  if (!parentId || parentId.startsWith('your-')) {
    throw new Error('ZOHO_WORKDRIVE_FOLDER_ID not configured');
  }
  const token = await getZohoAccessToken();
  const { data } = await axios.get(
    `${workdriveApiBase()}/files/${parentId}/files`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const items = ((data as { data?: Array<Record<string, unknown>> }).data ?? []);
  return items
    .map((it) => {
      const attrs = (it.attributes as Record<string, unknown>) ?? {};
      return {
        id: it.id as string,
        name: (attrs.name as string) ?? '',
        extension: attrs.extn as string | undefined,
        sizeBytes: attrs.storage_info ? ((attrs.storage_info as Record<string, unknown>).size as number | undefined) : undefined,
        createdTime: attrs.created_time as string | undefined,
        modifiedTime: attrs.modified_time as string | undefined,
        permalink: attrs.permalink as string | undefined,
        downloadUrl: attrs.download_url as string | undefined,
      };
    })
    .filter((f) => (f.extension ?? '').toLowerCase() === 'mp3' || f.name.toLowerCase().endsWith('.mp3'));
}

// Download a WorkDrive file's binary content (used for streaming or transcription).
export async function downloadWorkDriveFile(fileId: string): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
  const token = await getZohoAccessToken();
  const resp = await axios.get(
    `${workdriveApiBase()}/download/${fileId}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` }, responseType: 'arraybuffer' }
  );
  const headers = resp.headers as Record<string, string>;
  return {
    buffer: Buffer.from(resp.data as ArrayBuffer),
    contentType: headers['content-type'] ?? 'audio/mpeg',
    filename: headers['content-disposition'],
  };
}

export async function uploadToWorkDrive(
  buffer: Buffer,
  fileName: string,
  folderId?: string,
  contentType: string = 'application/octet-stream'
): Promise<WorkDriveUploadResult> {
  const parentId = folderId ?? defaultFolderId();
  if (!parentId || parentId.startsWith('your-')) {
    throw new Error('ZOHO_WORKDRIVE_FOLDER_ID not configured');
  }

  const token = await getZohoAccessToken();

  const form = new FormData();
  form.append('content', buffer, { filename: fileName, contentType });
  form.append('parent_id', parentId);
  form.append('filename', fileName);
  form.append('override-name-exist', 'true');

  const { data } = await axios.post(
    `${workdriveApiBase()}/upload`,
    form,
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );

  // WorkDrive returns {data: [{attributes: {resource_id, name, permalink, ...}}]}
  const first = (data as { data?: Array<Record<string, unknown>> })?.data?.[0];
  const attrs = (first?.attributes as Record<string, unknown>) ?? {};
  return {
    id: (first?.id as string) ?? (attrs.resource_id as string),
    name: (attrs.name as string) ?? fileName,
    permalink: attrs.permalink as string | undefined,
    resourceId: attrs.resource_id as string | undefined,
  };
}
