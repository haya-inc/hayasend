import { createHash } from "node:crypto";
import type { BlobServiceClient } from "@azure/storage-blob";
import { describe, expect, it, vi } from "vitest";
import { AzureBlobAttachmentStorage } from "../src/adapters/azure-blob-attachment-storage.js";
import type { AttachmentUploadRecord } from "../src/core/types.js";

const content = Buffer.from("verified Azure Blob attachment");
const checksum = createHash("sha256").update(content).digest("hex");
const record: AttachmentUploadRecord = {
  id: "att_1234567890abcdef1234567890abcdef",
  filename: "report.txt",
  content_type: "text/plain",
  size_bytes: content.byteLength,
  checksum_sha256: checksum,
  object_key: "attachments/att_123/content",
  upload_token_hash: "hash",
  created_at: "2030-01-01T00:00:00.000Z",
  upload_expires_at: "2030-01-01T00:15:00.000Z",
  expires_at: "2030-01-02T00:00:00.000Z",
};

function delegationKey() {
  return {
    signedObjectId: "11111111-1111-1111-1111-111111111111",
    signedTenantId: "22222222-2222-2222-2222-222222222222",
    signedStartsOn: new Date("2029-12-31T23:55:00.000Z"),
    signedExpiresOn: new Date("2030-01-01T01:00:00.000Z"),
    signedService: "b",
    signedVersion: "2025-11-05",
    value: Buffer.from("test-signing-key").toString("base64"),
  };
}

describe("AzureBlobAttachmentStorage", () => {
  it("creates a create/write-only user delegation SAS and verifies metadata", async () => {
    const getUserDelegationKey = vi.fn(async () => delegationKey());
    const uploadData = vi.fn(async () => undefined);
    const getProperties = vi.fn(async () => ({
      contentLength: content.byteLength,
      metadata: { hayasend_sha256: checksum },
    }));
    const downloadToBuffer = vi.fn(async () => content);
    const containerProperties = vi.fn(async () => ({}));
    const blockBlob = {
      url: `https://portableaccount.blob.core.windows.net/attachments/${record.object_key}`,
      uploadData,
      getProperties,
      downloadToBuffer,
    };
    const client = {
      getUserDelegationKey,
      getContainerClient(name: string) {
        expect(name).toBe("attachments");
        return {
          getProperties: containerProperties,
          getBlockBlobClient(key: string) {
            expect(key).toBe(record.object_key);
            return blockBlob;
          },
        };
      },
    } as unknown as BlobServiceClient;
    const storage = new AzureBlobAttachmentStorage(
      "portableaccount",
      "attachments",
      client,
      () => new Date("2030-01-01T00:00:00.000Z"),
    );

    const target = await storage.createUploadTarget(
      record,
      "unused",
      "https://api.example",
    );
    const url = new URL(target.url);
    expect(url.origin).toBe("https://portableaccount.blob.core.windows.net");
    expect(url.searchParams.get("sp")).toBe("cw");
    expect(url.searchParams.get("spr")).toBe("https");
    expect(target.headers).toEqual({
      "content-type": "text/plain",
      "if-none-match": "*",
      "x-ms-blob-type": "BlockBlob",
      "x-ms-meta-hayasend_sha256": checksum,
    });

    await storage.upload(record, content, "text/plain");
    expect(uploadData).toHaveBeenCalledWith(content, {
      blobHTTPHeaders: {
        blobContentType: "text/plain",
      },
      metadata: {
        hayasend_sha256: checksum,
      },
      conditions: {
        ifNoneMatch: "*",
      },
    });
    await expect(storage.verify(record)).resolves.toBeUndefined();
    await expect(storage.read(record)).resolves.toEqual(
      new Uint8Array(content),
    );
    await expect(storage.checkReadiness()).resolves.toBeUndefined();

    await storage.createUploadTarget(
      { ...record, id: "att_other" },
      "unused",
      "https://api.example",
    );
    expect(getUserDelegationKey).toHaveBeenCalledOnce();
  });

  it("rejects missing or corrupted blobs", async () => {
    const client = {
      getContainerClient() {
        return {
          getBlockBlobClient() {
            return {
              async getProperties() {
                throw { statusCode: 404 };
              },
              async downloadToBuffer() {
                return Buffer.from("corrupt");
              },
            };
          },
        };
      },
    } as unknown as BlobServiceClient;
    const storage = new AzureBlobAttachmentStorage(
      "portableaccount",
      "attachments",
      client,
    );

    await expect(storage.verify(record)).rejects.toThrow(
      "has not been uploaded",
    );
    await expect(storage.read(record)).rejects.toThrow(
      "integrity verification",
    );
  });
});
