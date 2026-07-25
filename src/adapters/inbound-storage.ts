import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "../core/errors.js";
import type {
  DownloadTarget,
  ReceivedEmailContent,
} from "../core/types.js";
import type { InboundStorage } from "../ports/inbound-storage.js";

const DOWNLOAD_TTL_SECONDS = 15 * 60;
type Presigner = typeof getSignedUrl;

function contentDisposition(filename: string) {
  const ascii = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\\r\n]/g, "_")
    .slice(0, 180);
  return `attachment; filename="${ascii || "download"}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export class S3InboundStorage implements InboundStorage {
  constructor(
    private readonly bucket: string,
    private readonly client = new S3Client({}),
    private readonly presign: Presigner = getSignedUrl,
  ) {}

  async readRaw(objectKey: string): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
    );
    const content = await result.Body?.transformToByteArray();
    if (!content) {
      throw new Error(`Inbound object ${objectKey} is empty.`);
    }
    return content;
  }

  async writeContent(
    objectKey: string,
    content: ReceivedEmailContent,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: JSON.stringify(content),
        ContentType: "application/json",
      }),
    );
  }

  async readContent(objectKey: string): Promise<ReceivedEmailContent> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
    );
    const raw = await result.Body?.transformToString();
    if (!raw) {
      throw new Error(`Inbound content ${objectKey} is empty.`);
    }
    return JSON.parse(raw) as ReceivedEmailContent;
  }

  async writeAttachment(
    objectKey: string,
    content: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: content,
        ContentType: contentType,
      }),
    );
  }

  async readAttachment(objectKey: string): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
    );
    const content = await result.Body?.transformToByteArray();
    if (!content) {
      throw new Error(`Inbound attachment ${objectKey} is empty.`);
    }
    return content;
  }

  async createDownloadTarget(
    objectKey: string,
    filename: string,
    contentType: string,
  ): Promise<DownloadTarget> {
    const expiresAt = new Date(
      Date.now() + DOWNLOAD_TTL_SECONDS * 1_000,
    ).toISOString();
    const downloadUrl = await this.presign(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ResponseContentType: contentType,
        ResponseContentDisposition: contentDisposition(filename),
      }),
      { expiresIn: DOWNLOAD_TTL_SECONDS },
    );
    return { download_url: downloadUrl, expires_at: expiresAt };
  }
}

export class MemoryInboundStorage implements InboundStorage {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly contents = new Map<string, ReceivedEmailContent>();

  seedRaw(objectKey: string, content: Uint8Array | string) {
    this.objects.set(
      objectKey,
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : Uint8Array.from(content),
    );
  }

  async readRaw(objectKey: string): Promise<Uint8Array> {
    const content = this.objects.get(objectKey);
    if (!content) {
      throw new Error(`Inbound object ${objectKey} was not found.`);
    }
    return Uint8Array.from(content);
  }

  async writeContent(
    objectKey: string,
    content: ReceivedEmailContent,
  ): Promise<void> {
    this.contents.set(objectKey, structuredClone(content));
  }

  async readContent(objectKey: string): Promise<ReceivedEmailContent> {
    const content = this.contents.get(objectKey);
    if (!content) {
      throw new Error(`Inbound content ${objectKey} was not found.`);
    }
    return structuredClone(content);
  }

  async writeAttachment(
    objectKey: string,
    content: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    this.objects.set(objectKey, Uint8Array.from(content));
  }

  async readAttachment(objectKey: string): Promise<Uint8Array> {
    const content = this.objects.get(objectKey);
    if (!content) {
      throw new Error(`Inbound attachment ${objectKey} was not found.`);
    }
    return Uint8Array.from(content);
  }

  async createDownloadTarget(
    objectKey: string,
    filename: string,
    _contentType: string,
  ): Promise<DownloadTarget> {
    if (!this.objects.has(objectKey)) {
      throw new Error(`Inbound object ${objectKey} was not found.`);
    }
    return {
      download_url: `https://local.hayasend.invalid/inbound/${encodeURIComponent(objectKey)}?filename=${encodeURIComponent(filename)}`,
      expires_at: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1_000).toISOString(),
    };
  }
}

export class DisabledInboundStorage implements InboundStorage {
  private unavailable(): never {
    throw new AppError(
      503,
      "inbound_not_configured",
      "Inbound receiving is not enabled for this deployment.",
    );
  }

  async readRaw(_objectKey: string): Promise<Uint8Array> {
    return this.unavailable();
  }

  async writeContent(
    _objectKey: string,
    _content: ReceivedEmailContent,
  ): Promise<void> {
    return this.unavailable();
  }

  async readContent(
    _objectKey: string,
  ): Promise<ReceivedEmailContent> {
    return this.unavailable();
  }

  async writeAttachment(
    _objectKey: string,
    _content: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    return this.unavailable();
  }

  async readAttachment(_objectKey: string): Promise<Uint8Array> {
    return this.unavailable();
  }

  async createDownloadTarget(
    _objectKey: string,
    _filename: string,
    _contentType: string,
  ): Promise<DownloadTarget> {
    return this.unavailable();
  }
}
