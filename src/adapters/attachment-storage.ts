import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError, ValidationError } from "../core/errors.js";
import type {
  AttachmentObjectReference,
  AttachmentUploadRecord,
  AttachmentUploadTarget,
} from "../core/types.js";
import type { AttachmentStorage } from "../ports/attachment-storage.js";

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
type Presigner = typeof getSignedUrl;

function checksumBase64(checksumHex: string) {
  return Buffer.from(checksumHex, "hex").toString("base64");
}

function checksumHex(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

function validateContent(
  reference: AttachmentObjectReference,
  content: Uint8Array,
) {
  if (
    content.byteLength !== reference.size_bytes ||
    checksumHex(content) !== reference.checksum_sha256
  ) {
    throw new Error(
      `Stored attachment ${reference.object_key} failed integrity verification.`,
    );
  }
}

export class S3AttachmentStorage implements AttachmentStorage {
  constructor(
    private readonly bucket: string,
    private readonly client = new S3Client({}),
    private readonly presign: Presigner = getSignedUrl,
  ) {}

  async createUploadTarget(
    record: AttachmentUploadRecord,
    _uploadToken: string,
    _apiBaseUrl: string,
  ): Promise<AttachmentUploadTarget> {
    const checksum = checksumBase64(record.checksum_sha256);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: record.object_key,
      ContentType: record.content_type,
      ChecksumSHA256: checksum,
    });
    const url = await this.presign(this.client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
    });
    return {
      method: "PUT",
      url,
      headers: {
        "content-type": record.content_type,
        "x-amz-checksum-sha256": checksum,
      },
      expires_at: record.upload_expires_at,
    };
  }

  async upload(
    record: AttachmentUploadRecord,
    content: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: record.object_key,
        Body: content,
        ContentType: contentType,
        ChecksumSHA256: checksumBase64(record.checksum_sha256),
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async verify(reference: AttachmentObjectReference): Promise<void> {
    let result;
    try {
      result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: reference.object_key,
          ChecksumMode: "ENABLED",
        }),
      );
    } catch (error) {
      if (
        ["NotFound", "NoSuchKey"].includes(
          (error as { name?: string }).name ?? "",
        )
      ) {
        throw new ValidationError("Attachment content has not been uploaded.");
      }
      throw error;
    }
    if (
      result.ContentLength !== reference.size_bytes ||
      result.ChecksumSHA256 !== checksumBase64(reference.checksum_sha256)
    ) {
      throw new ValidationError(
        "Stored attachment size or checksum does not match its declaration.",
      );
    }
  }

  async read(reference: AttachmentObjectReference): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: reference.object_key,
        ChecksumMode: "ENABLED",
      }),
    );
    const content = await result.Body?.transformToByteArray();
    if (!content) {
      throw new Error(`Stored attachment ${reference.object_key} is empty.`);
    }
    validateContent(reference, content);
    return content;
  }
}

export class MemoryAttachmentStorage implements AttachmentStorage {
  private readonly objects = new Map<string, Uint8Array>();

  async createUploadTarget(
    record: AttachmentUploadRecord,
    uploadToken: string,
    apiBaseUrl: string,
  ): Promise<AttachmentUploadTarget> {
    return {
      method: "PUT",
      url: `${apiBaseUrl}/attachments/${record.id}/content?token=${encodeURIComponent(uploadToken)}`,
      headers: { "content-type": record.content_type },
      expires_at: record.upload_expires_at,
    };
  }

  async upload(
    record: AttachmentUploadRecord,
    content: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    this.objects.set(record.object_key, Uint8Array.from(content));
  }

  async verify(reference: AttachmentObjectReference): Promise<void> {
    const stored = this.objects.get(reference.object_key);
    if (!stored) {
      throw new ValidationError("Attachment content has not been uploaded.");
    }
    try {
      validateContent(reference, stored);
    } catch {
      throw new ValidationError(
        "Stored attachment size or checksum does not match its declaration.",
      );
    }
  }

  async read(reference: AttachmentObjectReference): Promise<Uint8Array> {
    const stored = this.objects.get(reference.object_key);
    if (!stored) {
      throw new Error(
        `Stored attachment ${reference.object_key} was not found.`,
      );
    }
    validateContent(reference, stored);
    return Uint8Array.from(stored);
  }
}

export class DisabledAttachmentStorage implements AttachmentStorage {
  private unavailable(): never {
    throw new AppError(
      503,
      "attachment_storage_not_configured",
      "Direct attachment uploads are not enabled for this deployment. Inline base64 attachments remain available.",
    );
  }

  assertConfigured(): void {
    this.unavailable();
  }

  async createUploadTarget(
    _record: AttachmentUploadRecord,
    _uploadToken: string,
    _apiBaseUrl: string,
  ): Promise<AttachmentUploadTarget> {
    return this.unavailable();
  }

  async upload(
    _record: AttachmentUploadRecord,
    _content: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    return this.unavailable();
  }

  async verify(_reference: AttachmentObjectReference): Promise<void> {
    return this.unavailable();
  }

  async read(_reference: AttachmentObjectReference): Promise<Uint8Array> {
    return this.unavailable();
  }
}
