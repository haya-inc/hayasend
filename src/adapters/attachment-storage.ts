import {
  GetObjectCommand,
  HeadBucketCommand,
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
import {
  ATTACHMENT_UPLOAD_URL_TTL_SECONDS,
  attachmentChecksumBase64,
  validateAttachmentContent,
} from "./attachment-integrity.js";

type Presigner = typeof getSignedUrl;

export interface S3AttachmentStorageOptions {
  checksumMode?: "native" | "metadata";
  serverSideEncryption?: "AES256";
}

export class S3AttachmentStorage implements AttachmentStorage {
  constructor(
    private readonly bucket: string,
    private readonly client = new S3Client({}),
    private readonly presign: Presigner = getSignedUrl,
    private readonly options: S3AttachmentStorageOptions = {
      checksumMode: "native",
      serverSideEncryption: "AES256",
    },
  ) {}

  async checkReadiness(): Promise<void> {
    await this.client.send(
      new HeadBucketCommand({
        Bucket: this.bucket,
      }),
    );
  }

  async createUploadTarget(
    record: AttachmentUploadRecord,
    _uploadToken: string,
    _apiBaseUrl: string,
  ): Promise<AttachmentUploadTarget> {
    const checksumMode = this.options.checksumMode ?? "native";
    const checksum = attachmentChecksumBase64(record.checksum_sha256);
    const checksumHeader =
      checksumMode === "native"
        ? { "x-amz-checksum-sha256": checksum }
        : { "x-amz-meta-hayasend-sha256": record.checksum_sha256 };
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: record.object_key,
      ContentType: record.content_type,
      IfNoneMatch: "*",
      ...(checksumMode === "native"
        ? { ChecksumSHA256: checksum }
        : {
            Metadata: {
              "hayasend-sha256": record.checksum_sha256,
            },
          }),
      ...(this.options.serverSideEncryption
        ? { ServerSideEncryption: this.options.serverSideEncryption }
        : {}),
    });
    const url = await this.presign(this.client, command, {
      expiresIn: ATTACHMENT_UPLOAD_URL_TTL_SECONDS,
      unhoistableHeaders: new Set([
        ...Object.keys(checksumHeader),
        "if-none-match",
        ...(this.options.serverSideEncryption
          ? ["x-amz-server-side-encryption"]
          : []),
      ]),
    });
    return {
      method: "PUT",
      url,
      headers: {
        "content-type": record.content_type,
        "if-none-match": "*",
        ...checksumHeader,
        ...(this.options.serverSideEncryption
          ? {
              "x-amz-server-side-encryption":
                this.options.serverSideEncryption,
            }
          : {}),
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
        IfNoneMatch: "*",
        ...(this.options.checksumMode === "metadata"
          ? {
              Metadata: {
                "hayasend-sha256": record.checksum_sha256,
              },
            }
          : {
              ChecksumSHA256: attachmentChecksumBase64(
                record.checksum_sha256,
              ),
            }),
        ...(this.options.serverSideEncryption
          ? { ServerSideEncryption: this.options.serverSideEncryption }
          : {}),
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
          ...(this.options.checksumMode === "metadata"
            ? {}
            : { ChecksumMode: "ENABLED" }),
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
    const storedChecksum =
      this.options.checksumMode === "metadata"
        ? result.Metadata?.["hayasend-sha256"]
        : result.ChecksumSHA256;
    const expectedChecksum =
      this.options.checksumMode === "metadata"
        ? reference.checksum_sha256
        : attachmentChecksumBase64(reference.checksum_sha256);
    if (
      result.ContentLength !== reference.size_bytes ||
      storedChecksum !== expectedChecksum
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
        ...(this.options.checksumMode === "metadata"
          ? {}
          : { ChecksumMode: "ENABLED" }),
      }),
    );
    const content = await result.Body?.transformToByteArray();
    if (!content) {
      throw new Error(`Stored attachment ${reference.object_key} is empty.`);
    }
    validateAttachmentContent(reference, content);
    return content;
  }
}

export class MemoryAttachmentStorage implements AttachmentStorage {
  private readonly objects = new Map<string, Uint8Array>();

  async checkReadiness(): Promise<void> {}

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
      validateAttachmentContent(reference, stored);
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
    validateAttachmentContent(reference, stored);
    return Uint8Array.from(stored);
  }
}

export class DisabledAttachmentStorage implements AttachmentStorage {
  async checkReadiness(): Promise<void> {}

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
