import { S3Client } from "@aws-sdk/client-s3";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { Storage } from "@google-cloud/storage";
import type { Config } from "../config.js";
import type { AttachmentStorage } from "../ports/attachment-storage.js";
import {
  DisabledAttachmentStorage,
  S3AttachmentStorage,
} from "./attachment-storage.js";
import { AzureBlobAttachmentStorage } from "./azure-blob-attachment-storage.js";
import { GoogleCloudStorageAttachmentStorage } from "./google-cloud-storage-attachment-storage.js";

function requiredBucket(
  config: Config,
): string {
  if (!config.objectStorageBucket) {
    throw new Error("Portable object-storage settings are incomplete.");
  }
  return config.objectStorageBucket;
}

export function createPortableAttachmentStorage(
  config: Config,
): AttachmentStorage {
  switch (config.portableObjectStorage) {
    case "disabled":
    case undefined:
      return new DisabledAttachmentStorage();
    case "s3": {
      const client = new S3Client({
        region: config.region,
        ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
        forcePathStyle: config.s3ForcePathStyle ?? false,
      });
      return new S3AttachmentStorage(
        requiredBucket(config),
        client,
        undefined,
        {
          checksumMode: "metadata",
        },
      );
    }
    case "gcs": {
      const client = new Storage({
        ...(config.gcsProjectId
          ? { projectId: config.gcsProjectId }
          : {}),
      });
      return new GoogleCloudStorageAttachmentStorage(
        requiredBucket(config),
        client,
      );
    }
    case "azure-blob": {
      if (!config.azureStorageAccount) {
        throw new Error("Azure Blob storage settings are incomplete.");
      }
      const endpoint =
        config.azureBlobEndpoint ??
        `https://${config.azureStorageAccount}.blob.core.windows.net`;
      const client = new BlobServiceClient(
        endpoint,
        new DefaultAzureCredential(),
      );
      return new AzureBlobAttachmentStorage(
        config.azureStorageAccount,
        requiredBucket(config),
        client,
      );
    }
    default:
      throw new Error("Unsupported portable object-storage provider.");
  }
}
