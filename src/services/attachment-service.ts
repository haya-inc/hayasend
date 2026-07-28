import {
  base64ToBytes,
  isCanonicalBase64,
} from "../core/bytes.js";
import {
  createId,
  createRandomToken,
  secretsEqual,
  sha256,
  sha256Bytes,
} from "../core/crypto.js";
import { ValidationError } from "../core/errors.js";
import type {
  AttachmentUploadRecord,
  EmailAttachment,
  EmailAttachmentInput,
} from "../core/types.js";
import type { AttachmentStorage } from "../ports/attachment-storage.js";
import type { Store } from "../ports/store.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const UPLOAD_URL_TTL_MS = 15 * 60 * 1_000;
const ATTACHMENT_REFERENCE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_ESTIMATED_MESSAGE_BYTES = 39 * 1024 * 1024;
const MIME_BASE64_EXPANSION = 1.37;
const MIME_ATTACHMENT_OVERHEAD_BYTES = 2_048;

export interface CreateAttachmentUploadInput {
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
}

export interface CreatedAttachmentUpload {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  upload_url: string;
  upload_method: "PUT";
  upload_headers: Record<string, string>;
  expires_at: string;
  attachment_expires_at: string;
}

function isUploadedAttachment(
  attachment: EmailAttachmentInput,
): attachment is EmailAttachmentInput & { attachment_id: string } {
  return (
    "attachment_id" in attachment &&
    typeof attachment.attachment_id === "string"
  );
}

function objectReference(record: AttachmentUploadRecord) {
  return {
    object_key: record.object_key,
    size_bytes: record.size_bytes,
    checksum_sha256: record.checksum_sha256,
  };
}

export class AttachmentService {
  constructor(
    private readonly store: Store,
    private readonly storage: AttachmentStorage,
  ) {}

  async create(
    input: CreateAttachmentUploadInput,
    apiBaseUrl: string,
    now = new Date(),
  ): Promise<CreatedAttachmentUpload> {
    this.storage.assertConfigured?.();
    const id = createId("att");
    const uploadToken = createRandomToken();
    const uploadExpiresAt = new Date(
      now.getTime() + UPLOAD_URL_TTL_MS,
    ).toISOString();
    const expiresAt = new Date(
      now.getTime() + ATTACHMENT_REFERENCE_TTL_MS,
    ).toISOString();
    const record: AttachmentUploadRecord = {
      id,
      filename: input.filename,
      content_type: input.content_type,
      size_bytes: input.size_bytes,
      checksum_sha256: input.checksum_sha256.toLowerCase(),
      object_key: `attachments/${id}/content`,
      upload_token_hash: sha256(uploadToken),
      created_at: now.toISOString(),
      upload_expires_at: uploadExpiresAt,
      expires_at: expiresAt,
    };
    await this.store.putAttachmentUpload(record);
    const target = await this.storage.createUploadTarget(
      record,
      uploadToken,
      apiBaseUrl,
    );
    return {
      id: record.id,
      filename: record.filename,
      content_type: record.content_type,
      size_bytes: record.size_bytes,
      checksum_sha256: record.checksum_sha256,
      upload_url: target.url,
      upload_method: target.method,
      upload_headers: target.headers,
      expires_at: target.expires_at,
      attachment_expires_at: record.expires_at,
    };
  }

  async authorizeProxyUpload(
    id: string,
    token: string,
    contentLength: number | undefined,
    now = new Date(),
  ): Promise<AttachmentUploadRecord> {
    const record = await this.store.getAttachmentUpload(id);
    if (
      !record ||
      !secretsEqual(sha256(token), record.upload_token_hash) ||
      new Date(record.upload_expires_at).getTime() <= now.getTime()
    ) {
      throw new ValidationError(
        "The attachment upload URL is invalid or expired.",
      );
    }
    if (contentLength !== undefined && contentLength !== record.size_bytes) {
      throw new ValidationError(
        `Attachment content length must be exactly ${record.size_bytes} bytes.`,
      );
    }
    return record;
  }

  async upload(
    record: AttachmentUploadRecord,
    content: Uint8Array,
    contentType: string,
  ): Promise<void> {
    if (content.byteLength !== record.size_bytes) {
      throw new ValidationError(
        `Attachment content length must be exactly ${record.size_bytes} bytes.`,
      );
    }
    if (contentType !== record.content_type) {
      throw new ValidationError(
        `Attachment content type must be ${record.content_type}.`,
      );
    }
    const actualChecksum = sha256Bytes(content);
    if (actualChecksum !== record.checksum_sha256) {
      throw new ValidationError("Attachment checksum does not match.");
    }
    await this.storage.upload(record, content, contentType);
    await this.storage.verify(objectReference(record));
  }

  async resolve(
    attachments: EmailAttachmentInput[] | undefined,
    bodyBytes: number,
    now = new Date(),
  ): Promise<EmailAttachment[] | undefined> {
    if (!attachments) {
      return undefined;
    }
    const resolved = await Promise.all(
      attachments.map(async (attachment) => {
        if (!isUploadedAttachment(attachment)) {
          if (!attachment.content || !isCanonicalBase64(attachment.content)) {
            throw new ValidationError(
              `Attachment ${attachment.filename} content must be canonical base64.`,
            );
          }
          return {
            ...attachment,
            size_bytes: base64ToBytes(attachment.content).byteLength,
          };
        }

        const record = await this.store.getAttachmentUpload(
          attachment.attachment_id,
        );
        if (
          !record ||
          new Date(record.expires_at).getTime() <= now.getTime()
        ) {
          throw new ValidationError(
            `Attachment ${attachment.attachment_id} is invalid or expired.`,
          );
        }
        await this.storage.verify(objectReference(record));
        return {
          attachment_id: record.id,
          filename: attachment.filename ?? record.filename,
          content_type: attachment.content_type ?? record.content_type,
          ...(attachment.content_id
            ? { content_id: attachment.content_id }
            : {}),
          ...(attachment.content_disposition
            ? { content_disposition: attachment.content_disposition }
            : {}),
          object_key: record.object_key,
          size_bytes: record.size_bytes,
          checksum_sha256: record.checksum_sha256,
        };
      }),
    );

    const attachmentBytes = resolved.reduce(
      (total, attachment) => total + (attachment.size_bytes ?? 0),
      0,
    );
    if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
      throw new ValidationError(
        "Decoded attachment content must not exceed 25 MiB.",
      );
    }
    const estimatedMessageBytes =
      (bodyBytes + attachmentBytes) * MIME_BASE64_EXPANSION +
      resolved.length * MIME_ATTACHMENT_OVERHEAD_BYTES;
    if (estimatedMessageBytes > MAX_ESTIMATED_MESSAGE_BYTES) {
      throw new ValidationError(
        "The estimated MIME message size must remain below 39 MiB.",
      );
    }
    return resolved;
  }

  async read(attachment: EmailAttachment): Promise<Uint8Array> {
    if (attachment.content) {
      return base64ToBytes(attachment.content);
    }
    if (
      !attachment.object_key ||
      attachment.size_bytes === undefined ||
      !attachment.checksum_sha256
    ) {
      throw new Error(
        `Attachment ${attachment.filename} has no readable content.`,
      );
    }
    return this.storage.read({
      object_key: attachment.object_key,
      size_bytes: attachment.size_bytes,
      checksum_sha256: attachment.checksum_sha256,
    });
  }
}
