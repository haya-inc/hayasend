import {
  BlobNotFoundError,
  get,
  issueSignedToken,
  list,
  presignUrl,
  put,
} from "@vercel/blob";
import { ValidationError } from "../core/errors.js";
import type {
  AttachmentObjectReference,
  AttachmentUploadRecord,
  AttachmentUploadTarget,
} from "../core/types.js";
import type { AttachmentStorage } from "../ports/attachment-storage.js";
import { validateAttachmentContent } from "./attachment-integrity.js";

export interface VercelBlobClient {
  issueSignedToken: typeof issueSignedToken;
  presignUrl: typeof presignUrl;
  put: typeof put;
  get: typeof get;
  list: typeof list;
}

const defaultClient: VercelBlobClient = {
  issueSignedToken,
  presignUrl,
  put,
  get,
  list,
};

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > expectedBytes) {
        await reader.cancel();
        throw new ValidationError(
          "Stored attachment size or checksum does not match its declaration.",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedBytes) {
    throw new ValidationError(
      "Stored attachment size or checksum does not match its declaration.",
    );
  }
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

export class VercelBlobAttachmentStorage implements AttachmentStorage {
  constructor(
    private readonly token: string,
    private readonly client: VercelBlobClient = defaultClient,
  ) {}

  async checkReadiness(): Promise<void> {
    await this.client.list({
      limit: 1,
      prefix: "attachments/.hayasend-readiness",
      token: this.token,
    });
  }

  async createUploadTarget(
    record: AttachmentUploadRecord,
    _uploadToken: string,
    _apiBaseUrl: string,
  ): Promise<AttachmentUploadTarget> {
    const validUntil = new Date(record.upload_expires_at).getTime();
    const constraints = {
      pathname: record.object_key,
      validUntil,
      allowedContentTypes: [record.content_type],
      maximumSizeInBytes: record.size_bytes,
    };
    const signedToken = await this.client.issueSignedToken({
      ...constraints,
      operations: ["put"],
      token: this.token,
    });
    const { presignedUrl } = await this.client.presignUrl(signedToken, {
      ...constraints,
      access: "private",
      operation: "put",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
    });
    return {
      method: "PUT",
      url: presignedUrl,
      headers: {
        "content-type": record.content_type,
      },
      expires_at: record.upload_expires_at,
    };
  }

  async upload(
    record: AttachmentUploadRecord,
    content: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.put(record.object_key, Buffer.from(content), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
      contentType,
      token: this.token,
    });
  }

  async verify(reference: AttachmentObjectReference): Promise<void> {
    await this.read(reference);
  }

  async read(
    reference: AttachmentObjectReference,
  ): Promise<Uint8Array> {
    let result;
    try {
      result = await this.client.get(reference.object_key, {
        access: "private",
        token: this.token,
      });
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        throw new ValidationError(
          "Attachment content has not been uploaded.",
        );
      }
      throw error;
    }
    if (
      !result ||
      result.statusCode !== 200 ||
      !result.stream ||
      result.blob.size !== reference.size_bytes
    ) {
      throw new ValidationError(
        "Stored attachment size or checksum does not match its declaration.",
      );
    }
    const content = await readBounded(
      result.stream,
      reference.size_bytes,
    );
    validateAttachmentContent(reference, content);
    return content;
  }
}
