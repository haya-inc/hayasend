import { describe, expect, it } from "vitest";
import {
  DisabledAttachmentStorage,
  S3AttachmentStorage,
} from "../src/adapters/attachment-storage.js";
import { AzureBlobAttachmentStorage } from "../src/adapters/azure-blob-attachment-storage.js";
import { GoogleCloudStorageAttachmentStorage } from "../src/adapters/google-cloud-storage-attachment-storage.js";
import { createPortableAttachmentStorage } from "../src/adapters/portable-attachment-storage.js";
import { loadConfig } from "../src/config.js";

const base = {
  HAYASEND_MODE: "portable",
  HAYASEND_DATABASE_URL: "postgresql://database.internal/hayasend",
  HAYASEND_API_KEY: "re_portable_bootstrap_key",
  HAYASEND_TRANSPORT: "aws-ses",
};

describe("createPortableAttachmentStorage", () => {
  it("keeps direct uploads disabled unless explicitly selected", () => {
    expect(
      createPortableAttachmentStorage(loadConfig(base)),
    ).toBeInstanceOf(DisabledAttachmentStorage);
  });

  it("binds every portable provider to the shared storage port", () => {
    expect(
      createPortableAttachmentStorage(
        loadConfig({
          ...base,
          HAYASEND_OBJECT_STORAGE: "s3",
          HAYASEND_OBJECT_STORAGE_BUCKET: "portable-attachments",
          HAYASEND_S3_ENDPOINT: "https://objects.example.com",
        }),
      ),
    ).toBeInstanceOf(S3AttachmentStorage);

    expect(
      createPortableAttachmentStorage(
        loadConfig({
          ...base,
          HAYASEND_OBJECT_STORAGE: "gcs",
          HAYASEND_OBJECT_STORAGE_BUCKET: "portable-attachments",
        }),
      ),
    ).toBeInstanceOf(GoogleCloudStorageAttachmentStorage);

    expect(
      createPortableAttachmentStorage(
        loadConfig({
          ...base,
          HAYASEND_OBJECT_STORAGE: "azure-blob",
          HAYASEND_OBJECT_STORAGE_BUCKET: "attachments",
          AZURE_STORAGE_ACCOUNT_NAME: "portableaccount",
        }),
      ),
    ).toBeInstanceOf(AzureBlobAttachmentStorage);
  });
});
