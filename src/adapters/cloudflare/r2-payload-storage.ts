import { utf8Bytes } from "../../core/bytes.js";
import { sha256Bytes } from "../../core/crypto.js";
import { ConflictError, ValidationError } from "../../core/errors.js";
import type {
  AttachmentObjectReference,
  AttachmentUploadRecord,
  AttachmentUploadTarget,
  EmailRecord,
} from "../../core/types.js";
import type { AttachmentStorage } from "../../ports/attachment-storage.js";
import {
  injectCloudflareFault,
  type CloudflareFaultInjector,
} from "./fault-injection.js";

const DEFAULT_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_ORPHAN_RETENTION_SECONDS = 24 * 60 * 60;
const MANAGED_METADATA = "hayasend-managed";
const KIND_METADATA = "hayasend-kind";
const SHA256_METADATA = "hayasend-sha256";
const RETAIN_UNTIL_METADATA = "hayasend-retain-until";

interface EmailPayload {
  html?: string | undefined;
  text?: string | undefined;
  attachments?: EmailRecord["attachments"] | undefined;
}

export interface R2PayloadStorageOptions {
  max_payload_bytes?: number | undefined;
  orphan_retention_seconds?: number | undefined;
  fault_injector?: CloudflareFaultInjector | undefined;
}

export interface R2OrphanSweepInput {
  referenced_keys: ReadonlySet<string>;
  now: Date;
  prefix?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface R2OrphanSweepResult {
  scanned: number;
  deleted: string[];
  truncated: boolean;
  cursor?: string | undefined;
}

function checksumHex(checksum: ArrayBuffer | undefined): string | undefined {
  if (!checksum) {
    return undefined;
  }
  return [...new Uint8Array(checksum)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function emailPayload(record: EmailRecord): EmailPayload {
  return {
    html: record.html,
    text: record.text,
    attachments: record.attachments,
  };
}

function metadataRecord(record: EmailRecord, key: string): EmailRecord {
  const metadata = { ...record, payload_ref: key };
  delete metadata.html;
  delete metadata.text;
  delete metadata.attachments;
  return metadata;
}

export class R2PayloadStorage implements AttachmentStorage {
  private readonly maxPayloadBytes: number;
  private readonly orphanRetentionSeconds: number;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly options: R2PayloadStorageOptions = {},
  ) {
    this.maxPayloadBytes =
      options.max_payload_bytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.orphanRetentionSeconds =
      options.orphan_retention_seconds ??
      DEFAULT_ORPHAN_RETENTION_SECONDS;
    if (
      !Number.isSafeInteger(this.maxPayloadBytes) ||
      this.maxPayloadBytes <= 0
    ) {
      throw new Error("R2 payload size limit must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(this.orphanRetentionSeconds) ||
      this.orphanRetentionSeconds < 0
    ) {
      throw new Error(
        "R2 orphan retention must be a non-negative integer.",
      );
    }
  }

  async externalizeEmail(record: EmailRecord): Promise<EmailRecord> {
    const key = `emails/${record.id}/${crypto.randomUUID()}.json`;
    const content = utf8Bytes(JSON.stringify(emailPayload(record)));
    await this.putManagedObject({
      key,
      content,
      content_type: "application/json",
      kind: "email-payload",
      retain_until: new Date(
        Date.parse(record.created_at) +
          this.orphanRetentionSeconds * 1_000,
      ).toISOString(),
      operation: "email-put",
    });
    return metadataRecord(record, key);
  }

  async hydrateEmail(record: EmailRecord): Promise<EmailRecord> {
    if (!record.payload_ref) {
      return structuredClone(record);
    }
    await injectCloudflareFault(this.options.fault_injector, {
      component: "r2",
      operation: "email-get",
      target: record.payload_ref,
    });
    const object = await this.bucket.get(record.payload_ref);
    if (!object) {
      throw new Error(`Email payload ${record.payload_ref} was not found.`);
    }
    const content = new Uint8Array(await object.arrayBuffer());
    this.assertObjectIntegrity(
      record.payload_ref,
      object,
      content,
      object.customMetadata?.[SHA256_METADATA],
    );
    const payload = JSON.parse(
      new TextDecoder().decode(content),
    ) as EmailPayload;
    return { ...record, ...payload };
  }

  async createUploadTarget(
    record: AttachmentUploadRecord,
    uploadToken: string,
    apiBaseUrl: string,
  ): Promise<AttachmentUploadTarget> {
    return {
      method: "PUT",
      url: `${apiBaseUrl}/attachments/${record.id}/content?token=${encodeURIComponent(uploadToken)}`,
      headers: {
        "content-type": record.content_type,
        "x-hayasend-content-sha256": record.checksum_sha256,
      },
      expires_at: record.upload_expires_at,
    };
  }

  async upload(
    record: AttachmentUploadRecord,
    content: Uint8Array,
    contentType: string,
  ): Promise<void> {
    if (
      contentType !== record.content_type ||
      content.byteLength !== record.size_bytes ||
      sha256Bytes(content) !== record.checksum_sha256
    ) {
      throw new ValidationError(
        "Attachment size, type, or checksum does not match its declaration.",
      );
    }
    await this.putManagedObject({
      key: record.object_key,
      content,
      content_type: record.content_type,
      checksum_sha256: record.checksum_sha256,
      kind: "attachment",
      retain_until: record.expires_at,
      operation: "attachment-put",
    });
  }

  async verify(reference: AttachmentObjectReference): Promise<void> {
    await injectCloudflareFault(this.options.fault_injector, {
      component: "r2",
      operation: "attachment-head",
      target: reference.object_key,
    });
    const object = await this.bucket.head(reference.object_key);
    if (!object) {
      throw new ValidationError("Attachment content has not been uploaded.");
    }
    if (
      object.size !== reference.size_bytes ||
      object.customMetadata?.[SHA256_METADATA] !==
        reference.checksum_sha256 ||
      checksumHex(object.checksums.sha256) !== reference.checksum_sha256
    ) {
      throw new ValidationError(
        "Stored attachment size or checksum does not match its declaration.",
      );
    }
  }

  async read(reference: AttachmentObjectReference): Promise<Uint8Array> {
    await injectCloudflareFault(this.options.fault_injector, {
      component: "r2",
      operation: "attachment-get",
      target: reference.object_key,
    });
    const object = await this.bucket.get(reference.object_key);
    if (!object) {
      throw new Error(
        `Stored attachment ${reference.object_key} was not found.`,
      );
    }
    const content = new Uint8Array(await object.arrayBuffer());
    this.assertObjectIntegrity(
      reference.object_key,
      object,
      content,
      reference.checksum_sha256,
      reference.size_bytes,
    );
    return content;
  }

  async sweepOrphans(
    input: R2OrphanSweepInput,
  ): Promise<R2OrphanSweepResult> {
    const limit = input.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new Error("R2 orphan sweep limit must be between 1 and 1000.");
    }
    await injectCloudflareFault(this.options.fault_injector, {
      component: "r2",
      operation: "orphan-list",
      target: input.prefix ?? "",
    });
    const page = await this.bucket.list({
      prefix: input.prefix ?? "",
      limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      include: ["customMetadata"],
    });
    const cutoff =
      input.now.getTime() - this.orphanRetentionSeconds * 1_000;
    const deleted = page.objects
      .filter((object) => {
        const metadata = object.customMetadata;
        if (
          metadata?.[MANAGED_METADATA] !== "true" ||
          input.referenced_keys.has(object.key) ||
          object.uploaded.getTime() > cutoff
        ) {
          return false;
        }
        const retainUntil = Date.parse(
          metadata[RETAIN_UNTIL_METADATA] ?? "",
        );
        return !Number.isFinite(retainUntil) ||
          retainUntil <= input.now.getTime();
      })
      .map((object) => object.key);
    for (const [index, key] of deleted.entries()) {
      await injectCloudflareFault(this.options.fault_injector, {
        component: "r2",
        operation: "orphan-delete",
        target: key,
        index,
      });
    }
    if (deleted.length > 0) {
      await this.bucket.delete(deleted);
    }
    return {
      scanned: page.objects.length,
      deleted,
      truncated: page.truncated,
      ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  private async putManagedObject(input: {
    key: string;
    content: Uint8Array;
    content_type: string;
    kind: "attachment" | "email-payload";
    retain_until: string;
    operation: string;
    checksum_sha256?: string | undefined;
  }): Promise<void> {
    if (input.content.byteLength > this.maxPayloadBytes) {
      throw new ValidationError(
        `Cloudflare payloads must not exceed ${this.maxPayloadBytes} bytes.`,
      );
    }
    const checksum = input.checksum_sha256 ?? sha256Bytes(input.content);
    await injectCloudflareFault(this.options.fault_injector, {
      component: "r2",
      operation: input.operation,
      target: input.key,
    });
    const stored = await this.bucket.put(input.key, input.content, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: input.content_type },
      customMetadata: {
        [MANAGED_METADATA]: "true",
        [KIND_METADATA]: input.kind,
        [SHA256_METADATA]: checksum,
        [RETAIN_UNTIL_METADATA]: input.retain_until,
      },
      sha256: checksum,
    });
    if (stored) {
      return;
    }
    const existing = await this.bucket.head(input.key);
    if (
      !existing ||
      existing.size !== input.content.byteLength ||
      existing.customMetadata?.[SHA256_METADATA] !== checksum ||
      checksumHex(existing.checksums.sha256) !== checksum
    ) {
      throw new ConflictError(
        `R2 object ${input.key} already exists with different content.`,
      );
    }
  }

  private assertObjectIntegrity(
    key: string,
    object: R2Object,
    content: Uint8Array,
    expectedChecksum: string | undefined,
    expectedSize = content.byteLength,
  ): void {
    const actualChecksum = sha256Bytes(content);
    if (
      content.byteLength !== expectedSize ||
      object.size !== expectedSize ||
      expectedChecksum === undefined ||
      actualChecksum !== expectedChecksum ||
      object.customMetadata?.[SHA256_METADATA] !== expectedChecksum ||
      checksumHex(object.checksums.sha256) !== expectedChecksum
    ) {
      throw new Error(`Stored object ${key} failed integrity verification.`);
    }
  }
}
