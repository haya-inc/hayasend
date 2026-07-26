import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { describe, expect, it } from "vitest";
import { S3AttachmentStorage } from "../src/adapters/attachment-storage.js";
import type { AttachmentUploadRecord } from "../src/core/types.js";

const content = Buffer.from("verified S3 attachment");
const checksumHex = createHash("sha256").update(content).digest("hex");
const checksumBase64 = Buffer.from(checksumHex, "hex").toString("base64");
const record: AttachmentUploadRecord = {
  id: "att_1234567890abcdef1234567890abcdef",
  filename: "report.txt",
  content_type: "text/plain",
  size_bytes: content.byteLength,
  checksum_sha256: checksumHex,
  object_key: "attachments/att_123/content",
  upload_token_hash: "hash",
  created_at: "2030-01-01T00:00:00.000Z",
  upload_expires_at: "2030-01-01T00:15:00.000Z",
  expires_at: "2030-01-02T00:00:00.000Z",
};

describe("S3AttachmentStorage", () => {
  it("produces a SigV4 URL whose signed headers include the checksum", async () => {
    const client = new S3Client({
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "test-secret",
      },
    });
    const storage = new S3AttachmentStorage("example-bucket", client);

    const target = await storage.createUploadTarget(
      record,
      "unused",
      "https://api.example",
    );
    const url = new URL(target.url);

    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "x-amz-checksum-sha256",
    );
    expect(url.searchParams.has("x-amz-checksum-sha256")).toBe(false);
  });

  it("binds SHA-256 to the presigned PUT and verifies it with HeadObject", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return {
          ContentLength: content.byteLength,
          ChecksumSHA256: checksumBase64,
        };
      },
    } as unknown as S3Client;
    let presignCommand: unknown;
    let presignOptions: unknown;
    const presign = (async (
      _client: unknown,
      command: unknown,
      options: unknown,
    ) => {
      presignCommand = command;
      presignOptions = options;
      return "https://bucket.example/upload";
    }) as typeof getSignedUrl;
    const storage = new S3AttachmentStorage("bucket", client, presign);

    const target = await storage.createUploadTarget(
      record,
      "unused",
      "https://api.example",
    );
    expect(target).toEqual({
      method: "PUT",
      url: "https://bucket.example/upload",
      headers: {
        "content-type": "text/plain",
        "x-amz-checksum-sha256": checksumBase64,
      },
      expires_at: record.upload_expires_at,
    });
    expect(presignCommand).toMatchObject({
      input: {
        Bucket: "bucket",
        Key: record.object_key,
        ChecksumSHA256: checksumBase64,
      },
    });
    expect(presignOptions).toMatchObject({ expiresIn: 900 });
    expect(
      (presignOptions as { unhoistableHeaders: Set<string> })
        .unhoistableHeaders,
    ).toEqual(new Set(["x-amz-checksum-sha256"]));

    await storage.verify(record);
    expect(commands[0]).toBeInstanceOf(HeadObjectCommand);
    expect((commands[0] as HeadObjectCommand).input).toMatchObject({
      Bucket: "bucket",
      Key: record.object_key,
      ChecksumMode: "ENABLED",
    });
  });

  it("verifies downloaded bytes before passing them to SES", async () => {
    const client = {
      async send(command: unknown) {
        expect(command).toBeInstanceOf(GetObjectCommand);
        return {
          Body: {
            async transformToByteArray() {
              return content;
            },
          },
        };
      },
    } as unknown as S3Client;
    const storage = new S3AttachmentStorage("bucket", client);
    await expect(storage.read(record)).resolves.toEqual(content);
    await expect(
      storage.read({ ...record, checksum_sha256: "0".repeat(64) }),
    ).rejects.toThrow("integrity verification");
  });
});
