import {
  base64ToBytes,
  isCanonicalBase64,
} from "../../core/bytes.js";
import { ValidationError } from "../../core/errors.js";
import type {
  EmailAttachment,
  EmailAttachmentInput,
} from "../../core/types.js";

const MAX_INLINE_ATTACHMENT_BYTES = 3_800_000;

export class CloudflareInlineAttachmentService {
  async resolve(
    attachments: EmailAttachmentInput[] | undefined,
    _bodyBytes: number,
  ): Promise<EmailAttachment[] | undefined> {
    if (!attachments) {
      return undefined;
    }
    let totalBytes = 0;
    const resolved = attachments.map((attachment) => {
      if ("attachment_id" in attachment) {
        throw new ValidationError(
          "Uploaded attachment references are unavailable in the Cloudflare Beta runtime; use inline canonical base64 content.",
        );
      }
      if (!attachment.content || !isCanonicalBase64(attachment.content)) {
        throw new ValidationError(
          `Attachment ${attachment.filename} content must be canonical base64.`,
        );
      }
      const sizeBytes = base64ToBytes(attachment.content).byteLength;
      totalBytes += sizeBytes;
      return {
        ...attachment,
        size_bytes: sizeBytes,
      };
    });
    if (totalBytes > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new ValidationError(
        `Cloudflare inline attachments must not exceed ${MAX_INLINE_ATTACHMENT_BYTES} decoded bytes.`,
      );
    }
    return resolved;
  }

  async read(attachment: EmailAttachment): Promise<Uint8Array> {
    if (!attachment.content || !isCanonicalBase64(attachment.content)) {
      throw new ValidationError(
        `Attachment ${attachment.filename} content is unavailable.`,
      );
    }
    return base64ToBytes(attachment.content);
  }
}
