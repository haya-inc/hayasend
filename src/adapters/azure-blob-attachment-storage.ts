import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  type UserDelegationKey,
} from "@azure/storage-blob";
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

const CHECKSUM_METADATA_KEY = "hayasend_sha256";
const CHECKSUM_HEADER = `x-ms-meta-${CHECKSUM_METADATA_KEY}`;
const DELEGATION_KEY_TTL_MS = 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

function isNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404
  );
}

interface CachedDelegationKey {
  key: UserDelegationKey;
  expiresAt: number;
}

export class AzureBlobAttachmentStorage implements AttachmentStorage {
  private delegationKey: CachedDelegationKey | undefined;

  constructor(
    private readonly accountName: string,
    private readonly containerName: string,
    private readonly client = new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    ),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async checkReadiness(): Promise<void> {
    await this.client
      .getContainerClient(this.containerName)
      .getProperties();
  }

  private async getDelegationKey(requiredUntil: Date) {
    const now = this.now();
    if (
      this.delegationKey &&
      this.delegationKey.expiresAt >=
        requiredUntil.getTime() + CLOCK_SKEW_MS
    ) {
      return this.delegationKey.key;
    }
    const startsOn = new Date(now.getTime() - CLOCK_SKEW_MS);
    const expiresOn = new Date(now.getTime() + DELEGATION_KEY_TTL_MS);
    const key = await this.client.getUserDelegationKey(startsOn, expiresOn);
    this.delegationKey = {
      key,
      expiresAt: expiresOn.getTime(),
    };
    return key;
  }

  async createUploadTarget(
    record: AttachmentUploadRecord,
    _uploadToken: string,
    _apiBaseUrl: string,
  ): Promise<AttachmentUploadTarget> {
    const expiresOn = new Date(record.upload_expires_at);
    const startsOn = new Date(this.now().getTime() - CLOCK_SKEW_MS);
    const delegationKey = await this.getDelegationKey(expiresOn);
    const sas = generateBlobSASQueryParameters(
      {
        blobName: record.object_key,
        containerName: this.containerName,
        permissions: BlobSASPermissions.parse("cw"),
        protocol: SASProtocol.Https,
        startsOn,
        expiresOn,
      },
      delegationKey,
      this.accountName,
    ).toString();
    const blob = this.client
      .getContainerClient(this.containerName)
      .getBlockBlobClient(record.object_key);
    return {
      method: "PUT",
      url: `${blob.url}?${sas}`,
      headers: {
        "content-type": record.content_type,
        "if-none-match": "*",
        "x-ms-blob-type": "BlockBlob",
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
      .getContainerClient(this.containerName)
      .getBlockBlobClient(record.object_key)
      .uploadData(content, {
        blobHTTPHeaders: {
          blobContentType: contentType,
        },
        metadata: {
          [CHECKSUM_METADATA_KEY]: record.checksum_sha256,
        },
        conditions: {
          ifNoneMatch: "*",
        },
      });
  }

  async verify(reference: AttachmentObjectReference): Promise<void> {
    let properties;
    try {
      properties = await this.client
        .getContainerClient(this.containerName)
        .getBlockBlobClient(reference.object_key)
        .getProperties();
    } catch (error) {
      if (isNotFound(error)) {
        throw new ValidationError("Attachment content has not been uploaded.");
      }
      throw error;
    }
    if (
      properties.contentLength !== reference.size_bytes ||
      properties.metadata?.[CHECKSUM_METADATA_KEY] !==
        reference.checksum_sha256
    ) {
      throw new ValidationError(
        "Stored attachment size or checksum does not match its declaration.",
      );
    }
  }

  async read(reference: AttachmentObjectReference): Promise<Uint8Array> {
    const content = await this.client
      .getContainerClient(this.containerName)
      .getBlockBlobClient(reference.object_key)
      .downloadToBuffer();
    validateAttachmentContent(reference, content);
    return new Uint8Array(content);
  }
}
