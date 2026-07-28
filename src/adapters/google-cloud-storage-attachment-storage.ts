import { Storage } from "@google-cloud/storage";
import { ValidationError } from "../core/errors.js";
import type {
  AttachmentObjectReference,
  AttachmentUploadRecord,
  AttachmentUploadTarget,
} from "../core/types.js";
import type { AttachmentStorage } from "../ports/attachment-storage.js";
import {
  validateAttachmentContent,
} from "./attachment-integrity.js";

const CHECKSUM_METADATA_KEY = "hayasend-sha256";
const CHECKSUM_HEADER = `x-goog-meta-${CHECKSUM_METADATA_KEY}`;

function isNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String(error.code) === "404"
  );
}

export class GoogleCloudStorageAttachmentStorage
  implements AttachmentStorage
{
  constructor(
    private readonly bucketName: string,
    private readonly client = new Storage(),
  ) {}

  async checkReadiness(): Promise<void> {
    await this.client
      .bucket(this.bucketName)
      .file("attachments/.hayasend-readiness")
      .exists();
  }

  async createUploadTarget(
    record: AttachmentUploadRecord,
    _uploadToken: string,
    _apiBaseUrl: string,
  ): Promise<AttachmentUploadTarget> {
    const [url] = await this.client
      .bucket(this.bucketName)
      .file(record.object_key)
      .getSignedUrl({
        version: "v4",
        action: "write",
        expires: new Date(record.upload_expires_at),
        contentType: record.content_type,
        extensionHeaders: {
          [CHECKSUM_HEADER]: record.checksum_sha256,
        },
        queryParams: {
          ifGenerationMatch: "0",
        },
      });
    return {
      method: "PUT",
      url,
      headers: {
        "content-type": record.content_type,
        [CHECKSUM_HEADER]: record.checksum_sha256,
      },
      expires_at: record.upload_expires_at,
    };
  }

  async upload(
    record: AttachmentUploadRecord,
    content: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client
      .bucket(this.bucketName)
      .file(record.object_key)
      .save(Buffer.from(content), {
        resumable: false,
        validation: "crc32c",
        contentType,
        metadata: {
          contentType,
          metadata: {
            [CHECKSUM_METADATA_KEY]: record.checksum_sha256,
          },
        },
        preconditionOpts: {
          ifGenerationMatch: 0,
        },
      });
  }

  async verify(reference: AttachmentObjectReference): Promise<void> {
    let metadata;
    try {
      [metadata] = await this.client
        .bucket(this.bucketName)
        .file(reference.object_key)
        .getMetadata();
    } catch (error) {
      if (isNotFound(error)) {
        throw new ValidationError("Attachment content has not been uploaded.");
      }
      throw error;
    }
    if (
      Number(metadata.size) !== reference.size_bytes ||
      metadata.metadata?.[CHECKSUM_METADATA_KEY] !==
        reference.checksum_sha256
    ) {
      throw new ValidationError(
        "Stored attachment size or checksum does not match its declaration.",
      );
    }
  }

  async read(reference: AttachmentObjectReference): Promise<Uint8Array> {
    const [content] = await this.client
      .bucket(this.bucketName)
      .file(reference.object_key)
      .download();
    validateAttachmentContent(reference, content);
    return new Uint8Array(content);
  }
}
