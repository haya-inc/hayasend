import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertApiServerConfig,
  assertPortableWorkerConfig,
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

  it("loads complete Better Auth console settings and rejects partial or plaintext AWS credentials", () => {
    const awsBase = {
      HAYASEND_MODE: "aws",
      HAYASEND_API_KEY_SECRET_ARN:
        "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:bootstrap",
      HAYASEND_CONSOLE_AUTH_ORIGIN: "https://mail.example.com",
      HAYASEND_CONSOLE_AUTH_GOOGLE_CLIENT_ID:
        "client.apps.googleusercontent.com",
      HAYASEND_CONSOLE_AUTH_ALLOWED_EMAILS:
        "Operator@Example.com,second@example.com",
      HAYASEND_CONSOLE_AUTH_SECRET_ARN:
        "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:console-auth",
    };
    expect(loadConfig(awsBase)).toMatchObject({
      consoleAuthOrigin: "https://mail.example.com",
      consoleAuthGoogleClientId: "client.apps.googleusercontent.com",
      consoleAuthAllowedEmails: [
        "operator@example.com",
        "second@example.com",
      ],
      consoleAuthSecretArn:
        "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:console-auth",
    });

    expect(() =>
      loadConfig({
        ...awsBase,
        HAYASEND_CONSOLE_AUTH_ALLOWED_EMAILS: undefined,
      }),
    ).toThrow("Console authentication requires");
    expect(() =>
      loadConfig({
        ...awsBase,
        HAYASEND_CONSOLE_AUTH_SECRET_ARN: undefined,
        HAYASEND_CONSOLE_AUTH_CREDENTIALS: JSON.stringify({
          better_auth_secret: "x".repeat(48),
          google_client_secret: "google-secret",
        }),
      }),
    ).toThrow("not supported in AWS mode");
  });

  it("supports mounted Better Auth credentials outside AWS", () => {
    expect(
      loadConfig({
        HAYASEND_CONSOLE_AUTH_ORIGIN: "http://127.0.0.1:8787",
        HAYASEND_CONSOLE_AUTH_GOOGLE_CLIENT_ID:
          "client.apps.googleusercontent.com",
        HAYASEND_CONSOLE_AUTH_ALLOWED_EMAILS: "operator@example.com",
        HAYASEND_CONSOLE_AUTH_CREDENTIALS: JSON.stringify({
          better_auth_secret: "x".repeat(48),
          google_client_secret: "google-secret",
        }),
      }),
    ).toMatchObject({
      consoleAuthOrigin: "http://127.0.0.1:8787",
      consoleAuthAllowedEmails: ["operator@example.com"],
    });
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
      portableRuntimeProfile: "portable-postgres",
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
      portableQueueWakeup: "disabled",
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
    ).toThrow(
      "HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending",
    );
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HAYASEND_MODE: "portable",
        HAYASEND_DATABASE_URL:
          "postgresql://database.internal/hayasend",
        HAYASEND_API_KEY: "re_portable_bootstrap_key",
        HAYASEND_TRANSPORT: "console",
        HAYASEND_CONSOLE_PROOF_CONFIRM: "sending-disabled",
      }),
    ).toThrow(
      "HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending",
    );
    expect(
      loadConfig({
        NODE_ENV: "production",
        HAYASEND_MODE: "portable",
        HAYASEND_DATABASE_URL:
          "postgresql://database.internal/hayasend",
        HAYASEND_API_KEY: "re_portable_bootstrap_key",
        HAYASEND_TRANSPORT: "console",
        HAYASEND_CONSOLE_PROOF_CONFIRM: "isolated-non-sending",
      }).portableTransport,
    ).toBe("console");
  });

  it("validates an exact hosted runtime and transport combination", () => {
    const base = {
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL:
        "postgresql://database.internal/hayasend?sslmode=require",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "sendgrid",
      SENDGRID_API_KEY:
        "SG.sendgrid-scoped-api-key-with-at-least-32-characters",
    };
    expect(
      loadConfig({
        ...base,
        HAYASEND_RUNTIME_PROFILE: "vercel-serverless",
        HAYASEND_DEPLOYMENT_PROFILE: "vercel-sendgrid",
      }),
    ).toMatchObject({
      portableRuntimeProfile: "vercel-serverless",
      portableDeploymentProfile: "vercel-sendgrid",
    });
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_RUNTIME_PROFILE: "portable-postgres",
        HAYASEND_DEPLOYMENT_PROFILE: "vercel-sendgrid",
      }),
    ).toThrow("does not match");
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_RUNTIME_PROFILE: "vercel-serverless",
        HAYASEND_DEPLOYMENT_PROFILE: "cloud-run-sendgrid",
      }),
    ).toThrow("does not match");
  });

  it("separates Pub/Sub publisher and subscriber process settings", () => {
    const base = {
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL:
        "postgresql://database.internal/hayasend?sslmode=require",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "aws-ses",
      HAYASEND_QUEUE_WAKEUP: "gcp-pubsub",
    };
    const apiConfig = loadConfig({
      ...base,
      HAYASEND_GCP_PUBSUB_TOPIC:
        "projects/hayasend-test/topics/hayasend-wakeup",
    });
    expect(apiConfig).toMatchObject({
      portableQueueWakeup: "gcp-pubsub",
      gcpPubSubTopic:
        "projects/hayasend-test/topics/hayasend-wakeup",
    });
    expect(() => assertApiServerConfig(apiConfig)).not.toThrow();
    expect(() => assertPortableWorkerConfig(apiConfig)).toThrow(
      "worker process requires only",
    );

    const workerConfig = loadConfig({
      ...base,
      HAYASEND_GCP_PUBSUB_SUBSCRIPTION:
        "projects/hayasend-test/subscriptions/hayasend-wakeup",
    });
    expect(workerConfig).toMatchObject({
      portableQueueWakeup: "gcp-pubsub",
      gcpPubSubSubscription:
        "projects/hayasend-test/subscriptions/hayasend-wakeup",
    });
    expect(() => assertPortableWorkerConfig(workerConfig)).not.toThrow();
    expect(() => assertApiServerConfig(workerConfig)).toThrow(
      "API process requires only",
    );
  });

  it("rejects ambiguous or unsafe Pub/Sub wake-up settings", () => {
    const base = {
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL:
        "postgresql://database.internal/hayasend?sslmode=require",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "aws-ses",
    };
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_GCP_PUBSUB_TOPIC:
          "projects/hayasend-test/topics/hayasend-wakeup",
      }),
    ).toThrow("require HAYASEND_QUEUE_WAKEUP");
    expect(() =>
      loadConfig({
        ...base,
        HAYASEND_QUEUE_WAKEUP: "gcp-pubsub",
        HAYASEND_GCP_PUBSUB_TOPIC:
          "projects/hayasend-test/topics/../private",
      }),
    ).toThrow("fully qualified");
    const ambiguous = loadConfig({
      ...base,
      HAYASEND_QUEUE_WAKEUP: "gcp-pubsub",
      HAYASEND_GCP_PUBSUB_TOPIC:
        "projects/hayasend-test/topics/hayasend-wakeup",
      HAYASEND_GCP_PUBSUB_SUBSCRIPTION:
        "projects/hayasend-test/subscriptions/hayasend-wakeup",
    });
    expect(() => assertApiServerConfig(ambiguous)).toThrow(
      "requires only",
    );
    expect(() => assertPortableWorkerConfig(ambiguous)).toThrow(
      "requires only",
    );
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

  it("loads a SendGrid transport while keeping webhook verification on the API process", () => {
    const base = {
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL:
        "postgresql://database.internal/hayasend?sslmode=require",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "sendgrid",
      SENDGRID_API_KEY:
        "SG.sendgrid-scoped-api-key-with-at-least-32-characters",
      SENDGRID_API_BASE_URL: "https://api.eu.sendgrid.com",
    };
    const workerConfig = loadConfig(base);
    expect(workerConfig).toMatchObject({
      portableTransport: "sendgrid",
      sendGridApiKey:
        "SG.sendgrid-scoped-api-key-with-at-least-32-characters",
      sendGridApiBaseUrl: "https://api.eu.sendgrid.com",
    });
    expect(workerConfig.sendGridEventWebhookPublicKey).toBeUndefined();
    expect(() => assertApiServerConfig(workerConfig)).toThrow(
      "SendGrid API process requires",
    );

    const apiConfig = loadConfig({
      ...base,
      SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY:
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==",
    });
    expect(() => assertApiServerConfig(apiConfig)).not.toThrow();
  });

  it("fails closed on incomplete or unsafe SendGrid settings", () => {
    const base = {
      HAYASEND_MODE: "portable",
      HAYASEND_DATABASE_URL:
        "postgresql://database.internal/hayasend?sslmode=require",
      HAYASEND_API_KEY: "re_portable_bootstrap_key",
      HAYASEND_TRANSPORT: "sendgrid",
    };
    expect(() => loadConfig(base)).toThrow("SENDGRID_API_KEY");
    expect(() =>
      loadConfig({
        ...base,
        SENDGRID_API_KEY: "SG.too-short",
      }),
    ).toThrow("32 to 512");
    expect(() =>
      loadConfig({
        ...base,
        SENDGRID_API_KEY:
          "SG.sendgrid-scoped-api-key-with-at-least-32-characters",
        SENDGRID_API_BASE_URL: "https://attacker.example",
      }),
    ).toThrow("global or EU SendGrid API origin");
    expect(() =>
      loadConfig({
        ...base,
        SENDGRID_API_KEY:
          "SG.sendgrid-scoped-api-key-with-at-least-32-characters",
        SENDGRID_API_BASE_URL:
          "https://api.sendgrid.com.attacker.example",
      }),
    ).toThrow("global or EU SendGrid API origin");
    expect(() =>
      loadConfig({
        ...base,
        SENDGRID_API_KEY:
          "SG.sendgrid-scoped-api-key-with-at-least-32-characters",
        SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: "not-a-key",
      }),
    ).toThrow("base64 or PEM");
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
