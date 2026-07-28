import { describe, expect, it, vi } from "vitest";
import {
  type VercelBlobClient,
  VercelBlobAttachmentStorage,
} from "../src/adapters/vercel-blob-attachment-storage.js";
import { sha256Bytes } from "../src/core/crypto.js";
import type { AttachmentUploadRecord } from "../src/core/types.js";

const token = "vercel_blob_read_write_token_for_private_store_1234567890";
const content = new TextEncoder().encode("private attachment");
const record: AttachmentUploadRecord = {
  id: "att_vercel_blob_00000000001",
  filename: "attachment.txt",
  content_type: "text/plain",
  size_bytes: content.byteLength,
  checksum_sha256: sha256Bytes(content),
  object_key: "attachments/att_vercel_blob_00000000001/content",
  upload_token_hash: "unused",
  created_at: "2026-07-28T00:00:00.000Z",
  upload_expires_at: "2026-07-28T00:15:00.000Z",
  expires_at: "2026-07-29T00:00:00.000Z",
};

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createClient() {
  return {
    issueSignedToken: vi.fn(),
    presignUrl: vi.fn(),
    put: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
  } as unknown as VercelBlobClient;
}

describe("VercelBlobAttachmentStorage", () => {
  it("issues a private, exact-path, bounded upload URL", async () => {
    const client = createClient();
    vi.mocked(client.issueSignedToken).mockResolvedValue({
      delegationToken: "delegation",
      clientSigningToken: "signing",
      validUntil: new Date(record.upload_expires_at).getTime(),
    });
    vi.mocked(client.presignUrl).mockResolvedValue({
      presignedUrl:
        "https://blob.vercel-storage.com/upload?signed=redacted",
    });
    const storage = new VercelBlobAttachmentStorage(token, client);

    await expect(
      storage.createUploadTarget(record, "unused", "https://api.example"),
    ).resolves.toEqual({
      method: "PUT",
      url: "https://blob.vercel-storage.com/upload?signed=redacted",
      headers: { "content-type": "text/plain" },
      expires_at: record.upload_expires_at,
    });
    expect(client.issueSignedToken).toHaveBeenCalledWith({
      pathname: record.object_key,
      operations: ["put"],
      validUntil: new Date(record.upload_expires_at).getTime(),
      allowedContentTypes: [record.content_type],
      maximumSizeInBytes: record.size_bytes,
      token,
    });
    expect(client.presignUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        delegationToken: "delegation",
        clientSigningToken: "signing",
      }),
      expect.objectContaining({
        access: "private",
        operation: "put",
        pathname: record.object_key,
        addRandomSuffix: false,
        allowOverwrite: false,
        maximumSizeInBytes: record.size_bytes,
      }),
    );
  });

  it("re-hashes private Blob bytes before accepting an attachment", async () => {
    const client = createClient();
    vi.mocked(client.get).mockResolvedValue({
      statusCode: 200,
      stream: stream(content),
      headers: new Headers(),
      blob: {
        url: "https://private.blob.vercel-storage.com/object",
        downloadUrl:
          "https://private.blob.vercel-storage.com/object?download=1",
        pathname: record.object_key,
        contentType: record.content_type,
        contentDisposition: "attachment",
        cacheControl: "private, max-age=0",
        etag: "opaque",
        size: content.byteLength,
        uploadedAt: new Date(record.created_at),
      },
    });
    const storage = new VercelBlobAttachmentStorage(token, client);

    await expect(
      storage.verify({
        object_key: record.object_key,
        size_bytes: record.size_bytes,
        checksum_sha256: record.checksum_sha256,
      }),
    ).resolves.toBeUndefined();
    expect(client.get).toHaveBeenCalledWith(record.object_key, {
      access: "private",
      token,
    });
  });

  it("rejects a blob whose bytes do not match the declared checksum", async () => {
    const client = createClient();
    const altered = new TextEncoder().encode("altered attachment");
    vi.mocked(client.get).mockResolvedValue({
      statusCode: 200,
      stream: stream(altered),
      headers: new Headers(),
      blob: {
        url: "https://private.blob.vercel-storage.com/object",
        downloadUrl:
          "https://private.blob.vercel-storage.com/object?download=1",
        pathname: record.object_key,
        contentType: record.content_type,
        contentDisposition: "attachment",
        cacheControl: "private, max-age=0",
        etag: "opaque",
        size: altered.byteLength,
        uploadedAt: new Date(record.created_at),
      },
    });
    const storage = new VercelBlobAttachmentStorage(token, client);

    await expect(
      storage.verify({
        object_key: record.object_key,
        size_bytes: altered.byteLength,
        checksum_sha256: record.checksum_sha256,
      }),
    ).rejects.toThrow("failed integrity verification");
  });
});
