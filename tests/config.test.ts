import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertApiServerConfig,
  loadConfig,
} from "../src/config.js";

describe("loadConfig", () => {
  it("uses a development bootstrap key in local mode", () => {
    expect(loadConfig({})).toMatchObject({
      mode: "local",
      apiKey: "re_hayasend_dev",
      host: "127.0.0.1",
      port: 8787,
      inboundRawPrefix: "inbound/raw/",
      inboundRetentionDays: 7,
      inboundMaxMessageBytes: 25 * 1024 * 1024,
      webhookDeliveryRetentionDays: 7,
    });
  });

  it("supports an explicit container bind address", () => {
    expect(loadConfig({ HAYASEND_HOST: "0.0.0.0" }).host).toBe(
      "0.0.0.0",
    );
    expect(() => loadConfig({ HAYASEND_HOST: "bad host" })).toThrow(
      "HAYASEND_HOST",
    );
  });

  it("requires a Secrets Manager ARN in AWS mode", () => {
    expect(() => loadConfig({ HAYASEND_MODE: "aws" })).toThrow(
      "HAYASEND_API_KEY_SECRET_ARN is required in AWS mode.",
    );
  });

  it("rejects plaintext bootstrap keys in AWS mode", () => {
    expect(() =>
      loadConfig({
        HAYASEND_MODE: "aws",
        HAYASEND_API_KEY: "not-allowed-in-a-lambda-environment",
        HAYASEND_API_KEY_SECRET_ARN:
          "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:test",
      }),
    ).toThrow(
      "HAYASEND_API_KEY is not supported in AWS mode; use Secrets Manager.",
    );
  });

  it("accepts a Secrets Manager ARN without exposing a plaintext key", () => {
    const config = loadConfig({
      HAYASEND_MODE: "aws",
      HAYASEND_API_KEY_SECRET_ARN:
        "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:test",
    });

    expect(config.apiKeySecretArn).toContain(":secretsmanager:");
    expect(config.apiKey).toBeUndefined();
  });

  it("loads optional AWS queue diagnostic targets", () => {
    const config = loadConfig({
      HAYASEND_MODE: "aws",
      HAYASEND_API_KEY_SECRET_ARN:
        "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:test",
      HAYASEND_DLQ_URL: "https://sqs.example/delivery",
      HAYASEND_SCHEDULER_DLQ_URL:
        "https://sqs.example/scheduler",
      HAYASEND_INBOUND_DLQ_URL: "https://sqs.example/inbound",
    });

    expect(config).toMatchObject({
      deliveryDeadLetterQueueUrl: "https://sqs.example/delivery",
      schedulerDeadLetterQueueUrl:
        "https://sqs.example/scheduler",
      inboundDeadLetterQueueUrl: "https://sqs.example/inbound",
    });
  });

  it("requires explicit production-impacting settings in portable mode", () => {
    expect(() => loadConfig({ HAYASEND_MODE: "portable" })).toThrow(
      "HAYASEND_DATABASE_URL",
    );
    expect(() =>
      loadConfig({
        HAYASEND_MODE: "portable",
        HAYASEND_DATABASE_URL:
          "postgresql://database.internal/hayasend",
      }),
    ).toThrow("HAYASEND_API_KEY");
    expect(() =>
      loadConfig({
        HAYASEND_MODE: "portable",
        HAYASEND_DATABASE_URL:
          "postgresql://database.internal/hayasend",
        HAYASEND_API_KEY: "re_portable_bootstrap_key",
      }),
    ).toThrow("HAYASEND_TRANSPORT");
  });

  it("loads bounded portable API and worker settings", () => {
    const config = loadConfig({
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL:
        "postgresql://database.internal/hayasend?sslmode=require",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "aws-ses",
      HAYASEND_POSTGRES_POOL_MAX: "20",
      HAYASEND_WORKER_CONCURRENCY: "8",
    });

    expect(config).toMatchObject({
      mode: "portable",
      host: "0.0.0.0",
      databaseUrl:
        "postgresql://database.internal/hayasend?sslmode=require",
      apiKey: "re_portable_bootstrap_key",
      portableTransport: "aws-ses",
      postgresPoolMax: 20,
      postgresIdleTimeoutMs: 10_000,
      postgresConnectionTimeoutMs: 5_000,
      postgresMaxLifetimeSeconds: 3_600,
      workerConcurrency: 8,
      workerLeaseSeconds: 60,
      workerPollIntervalMs: 500,
      workerRetryDelaySeconds: 30,
      workerOutboxIntervalMs: 1_000,
      jobMaxAttempts: 10,
      jobRetentionDays: 7,
      portableObjectStorage: "disabled",
      s3ForcePathStyle: false,
    });
    expect(() =>
      loadConfig({
        HAYASEND_MODE: "portable",
        HAYASEND_DATABASE_URL:
          "postgresql://database.internal/hayasend",
        HAYASEND_API_KEY: "re_portable_bootstrap_key",
        HAYASEND_TRANSPORT: "console",
        HAYASEND_WORKER_CONCURRENCY: "33",
      }),
    ).toThrow("HAYASEND_WORKER_CONCURRENCY");
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HAYASEND_MODE: "portable",
        HAYASEND_DATABASE_URL:
          "postgresql://database.internal/hayasend",
        HAYASEND_API_KEY: "re_portable_bootstrap_key",
        HAYASEND_TRANSPORT: "console",
      }),
    ).toThrow("not supported in production");
  });

  it("loads provider-native portable object-storage settings", () => {
    const base = {
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL:
        "postgresql://database.internal/hayasend?sslmode=require",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "aws-ses",
    };

    expect(
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "s3",
        HAYASEND_OBJECT_STORAGE_BUCKET: "portable-attachments",
        HAYASEND_S3_ENDPOINT: "https://objects.example.com",
        HAYASEND_S3_FORCE_PATH_STYLE: "true",
      }),
    ).toMatchObject({
      portableObjectStorage: "s3",
      objectStorageBucket: "portable-attachments",
      s3Endpoint: "https://objects.example.com",
      s3ForcePathStyle: true,
    });

    expect(
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "gcs",
        HAYASEND_OBJECT_STORAGE_BUCKET: "portable-attachments",
        GOOGLE_CLOUD_PROJECT: "hayasend-test",
      }),
    ).toMatchObject({
      portableObjectStorage: "gcs",
      objectStorageBucket: "portable-attachments",
      gcsProjectId: "hayasend-test",
    });

    expect(
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "azure-blob",
        HAYASEND_OBJECT_STORAGE_BUCKET: "attachments",
        AZURE_STORAGE_ACCOUNT_NAME: "portableaccount",
      }),
    ).toMatchObject({
      portableObjectStorage: "azure-blob",
      objectStorageBucket: "attachments",
      azureStorageAccount: "portableaccount",
    });

    expect(
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "vercel-blob",
        BLOB_READ_WRITE_TOKEN:
          "vercel_blob_read_write_token_for_private_store_1234567890",
      }),
    ).toMatchObject({
      portableObjectStorage: "vercel-blob",
      vercelBlobToken:
        "vercel_blob_read_write_token_for_private_store_1234567890",
    });
  });

  it("loads an Azure Communication Services transport with isolated Event Grid authentication", () => {
    const config = loadConfig({
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL:
        "postgresql://database.internal/hayasend?sslmode=require",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "azure-communication-services",
      HAYASEND_REGION: "japaneast",
      AZURE_COMMUNICATION_EMAIL_ENDPOINT:
        "https://hayasend.communication.azure.com",
      AZURE_SUBSCRIPTION_ID: "00000000-0000-4000-8000-000000000000",
      AZURE_RESOURCE_GROUP: "hayasend-proof",
      AZURE_COMMUNICATION_SERVICE_NAME: "hayasend-communication",
      AZURE_EMAIL_SERVICE_NAME: "hayasend-email",
      AZURE_EMAIL_DOMAIN_RESOURCE_NAME: "example.com",
      HAYASEND_AZURE_EVENT_GRID_SECRET:
        "event-grid-secret-with-at-least-32-characters",
    });

    expect(config).toMatchObject({
      portableTransport: "azure-communication-services",
      region: "japaneast",
      azureCommunicationEmailEndpoint:
        "https://hayasend.communication.azure.com",
      azureSubscriptionId: "00000000-0000-4000-8000-000000000000",
      azureResourceGroup: "hayasend-proof",
      azureCommunicationServiceName: "hayasend-communication",
      azureEmailServiceName: "hayasend-email",
      azureEmailDomainResourceName: "example.com",
      azureEventGridSecret:
        "event-grid-secret-with-at-least-32-characters",
    });
  });

  it("fails closed on incomplete Azure Communication Services settings", () => {
    expect(() =>
      loadConfig({
        HAYASEND_MODE: "portable",
        HAYASEND_DATABASE_URL:
          "postgresql://database.internal/hayasend?sslmode=require",
        HAYASEND_API_KEY: "re_portable_bootstrap_key",
        HAYASEND_TRANSPORT: "azure-communication-services",
      }),
    ).toThrow("Azure Communication Services transport requires");
  });

  it("keeps the Event Grid secret on the API process only", () => {
    const config = loadConfig({
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL:
        "postgresql://database.internal/hayasend?sslmode=require",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "azure-communication-services",
      AZURE_COMMUNICATION_EMAIL_ENDPOINT:
        "https://hayasend.communication.azure.com",
      AZURE_SUBSCRIPTION_ID: "00000000-0000-4000-8000-000000000000",
      AZURE_RESOURCE_GROUP: "hayasend-proof",
      AZURE_COMMUNICATION_SERVICE_NAME: "hayasend-communication",
      AZURE_EMAIL_SERVICE_NAME: "hayasend-email",
      AZURE_EMAIL_DOMAIN_RESOURCE_NAME: "example.com",
    });

    expect(config.azureEventGridSecret).toBeUndefined();
    expect(() => assertApiServerConfig(config)).toThrow(
      "API process requires",
    );
  });

  it("fails closed on incomplete or unsafe object-storage settings", () => {
    const base = {
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL: "postgresql://database.internal/hayasend",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "aws-ses",
    };
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "gcs",
      }),
    ).toThrow("HAYASEND_OBJECT_STORAGE_BUCKET");
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE_BUCKET: "portable-attachments",
      }),
    ).toThrow("requires an enabled");
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "s3",
        HAYASEND_OBJECT_STORAGE_BUCKET: "portable-attachments",
        HAYASEND_S3_ENDPOINT: "http://objects.example.com",
      }),
    ).toThrow("HTTPS service origin");
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "azure-blob",
        HAYASEND_OBJECT_STORAGE_BUCKET: "Invalid_Container",
        AZURE_STORAGE_ACCOUNT_NAME: "portableaccount",
      }),
    ).toThrow("safe provider bucket");
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "azure-blob",
        HAYASEND_OBJECT_STORAGE_BUCKET: "attachments",
      }),
    ).toThrow("AZURE_STORAGE_ACCOUNT_NAME");
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "vercel-blob",
      }),
    ).toThrow("BLOB_READ_WRITE_TOKEN");
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_OBJECT_STORAGE: "vercel-blob",
        HAYASEND_OBJECT_STORAGE_BUCKET: "not-used",
        BLOB_READ_WRITE_TOKEN:
          "vercel_blob_read_write_token_for_private_store_1234567890",
      }),
    ).toThrow("HAYASEND_OBJECT_STORAGE_BUCKET is not used");
  });

  it("loads portable secrets from bounded mounted files", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "hayasend-config-secrets-"),
    );
    const databaseFile = join(directory, "database-url");
    const apiKeyFile = join(directory, "api-key");
    const oversizedFile = join(directory, "oversized");
    try {
      await writeFile(
        databaseFile,
        "postgresql://database.internal/hayasend?sslmode=require\n",
      );
      await writeFile(apiKeyFile, "re_portable_bootstrap_key\n");
      await writeFile(oversizedFile, "x".repeat(16 * 1024 + 1));

      expect(
        loadConfig({
          HAYASEND_MODE: "portable",
          HAYASEND_DATABASE_URL_FILE: databaseFile,
          HAYASEND_API_KEY_FILE: apiKeyFile,
          HAYASEND_TRANSPORT: "aws-ses",
        }),
      ).toMatchObject({
        databaseUrl:
          "postgresql://database.internal/hayasend?sslmode=require",
        apiKey: "re_portable_bootstrap_key",
      });

      expect(() =>
        loadConfig({
          HAYASEND_MODE: "portable",
          HAYASEND_DATABASE_URL:
            "postgresql://database.internal/hayasend",
          HAYASEND_DATABASE_URL_FILE: databaseFile,
          HAYASEND_API_KEY_FILE: apiKeyFile,
          HAYASEND_TRANSPORT: "aws-ses",
        }),
      ).toThrow("may not both be set");
      expect(() =>
        loadConfig({
          HAYASEND_MODE: "portable",
          HAYASEND_DATABASE_URL_FILE: databaseFile,
          HAYASEND_API_KEY_FILE: oversizedFile,
          HAYASEND_TRANSPORT: "aws-ses",
        }),
      ).toThrow("at most 16384 bytes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown runtime modes and credential-bearing non-PostgreSQL URLs", () => {
    expect(() => loadConfig({ HAYASEND_MODE: "unknown" })).toThrow(
      "local, aws, or portable",
    );
    expect(() =>
      loadConfig({
        HAYASEND_MODE: "portable",
        HAYASEND_DATABASE_URL:
          "https://private:secret@database.internal/hayasend",
        HAYASEND_API_KEY: "re_portable_bootstrap_key",
        HAYASEND_TRANSPORT: "console",
      }),
    ).toThrow("PostgreSQL connection URL");
  });

  it("rejects unsafe inbound retention and S3-prefix settings", () => {
    expect(() =>
      loadConfig({ HAYASEND_INBOUND_RETENTION_DAYS: "31" }),
    ).toThrow("HAYASEND_INBOUND_RETENTION_DAYS");
    expect(() =>
      loadConfig({ HAYASEND_INBOUND_RAW_PREFIX: "../mail/" }),
    ).toThrow("HAYASEND_INBOUND_RAW_PREFIX");
  });

  it("rejects unsafe webhook delivery retention", () => {
    expect(() =>
      loadConfig({
        HAYASEND_WEBHOOK_DELIVERY_RETENTION_DAYS: "31",
      }),
    ).toThrow("HAYASEND_WEBHOOK_DELIVERY_RETENTION_DAYS");
  });
});
