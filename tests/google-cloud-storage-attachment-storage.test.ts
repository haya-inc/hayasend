import { createHash } from "node:crypto";
import type { Storage } from "@google-cloud/storage";
import { describe, expect, it, vi } from "vitest";
import { GoogleCloudStorageAttachmentStorage } from "../src/adapters/google-cloud-storage-attachment-storage.js";
import type { AttachmentUploadRecord } from "../src/core/types.js";

const content = Buffer.from("verified Google Cloud Storage attachment");
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

describe("GoogleCloudStorageAttachmentStorage", () => {
  it("binds the declared SHA-256 metadata to a V4 upload URL", async () => {
    const getSignedUrl = vi.fn(async () => [
      "https://storage.googleapis.com/bucket/object?signed=true",
    ]);
    const getMetadata = vi.fn(async () => [
      {
        size: String(content.byteLength),
        metadata: { "hayasend-sha256": checksum },
      },
    ]);
    const save = vi.fn(async () => undefined);
    const download = vi.fn(async () => [content]);
    const exists = vi.fn(async () => [false]);
    const client = {
      bucket(name: string) {
        expect(name).toBe("portable-attachments");
        return {
          file(key: string) {
            if (key === "attachments/.hayasend-readiness") {
              return { exists };
            }
            expect(key).toBe(record.object_key);
            return { getSignedUrl, getMetadata, save, download };
          },
        };
      },
    } as unknown as Storage;
    const storage = new GoogleCloudStorageAttachmentStorage(
      "portable-attachments",
      client,
    );

    await expect(
      storage.createUploadTarget(record, "unused", "https://api.example"),
    ).resolves.toEqual({
      method: "PUT",
      url: "https://storage.googleapis.com/bucket/object?signed=true",
      headers: {
        "content-type": "text/plain",
        "x-goog-meta-hayasend-sha256": checksum,
      },
      expires_at: record.upload_expires_at,
    });
    expect(getSignedUrl).toHaveBeenCalledWith({
      version: "v4",
      action: "write",
      expires: new Date(record.upload_expires_at),
      contentType: "text/plain",
      extensionHeaders: {
        "x-goog-meta-hayasend-sha256": checksum,
      },
      queryParams: {
        ifGenerationMatch: "0",
      },
    });

    await storage.upload(record, content, "text/plain");
    expect(save).toHaveBeenCalledWith(
      content,
      expect.objectContaining({
        resumable: false,
        validation: "crc32c",
        contentType: "text/plain",
        metadata: {
          contentType: "text/plain",
          metadata: {
            "hayasend-sha256": checksum,
          },
        },
        preconditionOpts: {
          ifGenerationMatch: 0,
        },
      }),
    );
    await expect(storage.verify(record)).resolves.toBeUndefined();
    await expect(storage.read(record)).resolves.toEqual(
      new Uint8Array(content),
    );
    await expect(storage.checkReadiness()).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledOnce();
  });

  it("rejects missing or corrupted objects without exposing metadata", async () => {
    const client = {
      bucket() {
        return {
          file() {
            return {
              async getMetadata() {
                throw { code: 404 };
              },
              async download() {
                return [Buffer.from("corrupt")];
              },
            };
          },
        };
      },
    } as unknown as Storage;
    const storage = new GoogleCloudStorageAttachmentStorage(
      "portable-attachments",
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
