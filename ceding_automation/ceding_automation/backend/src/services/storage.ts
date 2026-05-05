// backend/src/services/storage.ts
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from "@azure/storage-blob";

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY!;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME!;

const credential = new StorageSharedKeyCredential(accountName, accountKey);
const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  credential
);

export async function uploadToAzureBlob(
  blobPath: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: mimeType },
  });

  return blockBlobClient.url;
}

export async function generateSasUrl(blobPath: string, expiryMinutes = 60): Promise<string> {
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
}

export async function downloadBlobAsBuffer(blobPath: string): Promise<Buffer> {
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
  const downloadResponse = await blockBlobClient.download();
  const chunks: Buffer[] = [];
  for await (const chunk of downloadResponse.readableStreamBody as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
