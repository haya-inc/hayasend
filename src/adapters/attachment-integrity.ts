import { createHash } from "node:crypto";
import type { AttachmentObjectReference } from "../core/types.js";

export const ATTACHMENT_UPLOAD_URL_TTL_SECONDS = 15 * 60;

export function attachmentChecksumBase64(checksumHex: string) {
  return Buffer.from(checksumHex, "hex").toString("base64");
}

export function attachmentChecksumHex(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

export function validateAttachmentContent(
  reference: AttachmentObjectReference,
  content: Uint8Array,
) {
  if (
    content.byteLength !== reference.size_bytes ||
    attachmentChecksumHex(content) !== reference.checksum_sha256
  ) {
    throw new Error(
      `Stored attachment ${reference.object_key} failed integrity verification.`,
    );
  }
}
