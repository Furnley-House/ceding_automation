// backend/src/services/storage.ts
import fs from "fs";
import path from "path";

// ── Azure availability check ──────────────────────────────────────────────
// Returns true only when all three vars are set AND don't look like placeholders
function isAzureConfigured(): boolean {
  const name = process.env.AZURE_STORAGE_ACCOUNT_NAME ?? "";
  const key = process.env.AZURE_STORAGE_ACCOUNT_KEY ?? "";
  const container = process.env.AZURE_STORAGE_CONTAINER_NAME ?? "";
  return (
    name.length > 0 &&
    key.length > 0 &&
    container.length > 0 &&
    !key.startsWith("your-") // filter out .env.example placeholder values
  );
}

// ── Local fallback path ───────────────────────────────────────────────────
const LOCAL_UPLOADS_DIR = path.resolve(__dirname, "../../uploads");

function ensureLocalDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Azure helpers (lazily imported so startup never fails) ────────────────
async function getAzureClients() {
  const { BlobServiceClient, StorageSharedKeyCredential } = await import(
    "@azure/storage-blob"
  );
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY!;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME!;
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const blobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential
  );
  return { blobServiceClient, containerName, credential, accountName };
}

// ── Public API ────────────────────────────────────────────────────────────

export async function uploadToAzureBlob(
  blobPath: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  if (isAzureConfigured()) {
    try {
      const { blobServiceClient, containerName } = await getAzureClients();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
      await blockBlobClient.uploadData(buffer, {
        blobHTTPHeaders: { blobContentType: mimeType },
      });
      return blockBlobClient.url;
    } catch (err) {
      console.warn(
        "[storage] Azure upload failed, falling back to local storage:",
        (err as Error).message
      );
    }
  }

  // Local filesystem fallback
  const localPath = path.join(LOCAL_UPLOADS_DIR, blobPath);
  ensureLocalDir(localPath);
  fs.writeFileSync(localPath, buffer);
  console.log(`[storage] File saved locally: ${localPath}`);
  return `/uploads/${blobPath}`;
}

export async function generateSasUrl(
  blobPath: string,
  expiryMinutes = 60
): Promise<string> {
  if (isAzureConfigured()) {
    try {
      const { credential, containerName, accountName } = await getAzureClients();
      const { generateBlobSASQueryParameters, BlobSASPermissions } = await import(
        "@azure/storage-blob"
      );
      const expiresOn = new Date();
      expiresOn.setMinutes(expiresOn.getMinutes() + expiryMinutes);
      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          blobName: blobPath,
          permissions: BlobSASPermissions.parse("r"),
          expiresOn,
        },
        credential
      ).toString();
      return `https://${accountName}.blob.core.windows.net/${containerName}/${blobPath}?${sasToken}`;
    } catch (err) {
      console.warn(
        "[storage] Azure SAS URL generation failed, returning local path:",
        (err as Error).message
      );
    }
  }

  // Local fallback — served as static files via /uploads route
  return `/uploads/${blobPath}`;
}

export async function downloadBlobAsBuffer(blobPath: string): Promise<Buffer> {
  if (isAzureConfigured()) {
    try {
      const { blobServiceClient, containerName } = await getAzureClients();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
      const downloadResponse = await blockBlobClient.download();
      const chunks: Buffer[] = [];
      for await (const chunk of downloadResponse.readableStreamBody as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      console.warn(
        "[storage] Azure download failed, falling back to local storage:",
        (err as Error).message
      );
    }
  }

  // Local fallback
  const localPath = path.join(LOCAL_UPLOADS_DIR, blobPath);
  return fs.readFileSync(localPath);
}
