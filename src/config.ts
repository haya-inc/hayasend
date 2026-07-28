import { ValidationError } from "./core/errors.js";

export interface Config {
  mode: "local" | "aws" | "portable";
  apiKey?: string;
  apiKeySecretArn?: string;
  host: string;
  port: number;
  region: string;
  tableName?: string;
  queueUrl?: string;
  queueArn?: string;
  deliveryDeadLetterQueueUrl?: string;
  schedulerDeadLetterQueueUrl?: string;
  inboundDeadLetterQueueUrl?: string;
  payloadBucket?: string;
  configurationSet?: string;
  schedulerGroupName?: string;
  schedulerRoleArn?: string;
  schedulerDeadLetterQueueArn?: string;
  inboundBucket?: string;
  inboundRawPrefix: string;
  inboundRetentionDays: number;
  inboundMaxMessageBytes: number;
  webhookDeliveryRetentionDays: number;
  templateHistoryRetentionDays: number;
  templateHistoryLimit: number;
  databaseUrl?: string;
  portableTransport?: "console" | "aws-ses";
  postgresPoolMax?: number;
  postgresIdleTimeoutMs?: number;
  postgresConnectionTimeoutMs?: number;
  postgresMaxLifetimeSeconds?: number;
  workerConcurrency?: number;
  workerLeaseSeconds?: number;
  workerPollIntervalMs?: number;
  workerRetryDelaySeconds?: number;
  workerOutboxIntervalMs?: number;
  jobMaxAttempts?: number;
  jobRetentionDays?: number;
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(env[name] ?? fallback);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ValidationError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function loadConfig(env = process.env): Config {
  const requestedMode = env.HAYASEND_MODE ?? "local";
  if (!["local", "aws", "portable"].includes(requestedMode)) {
    throw new ValidationError(
      "HAYASEND_MODE must be local, aws, or portable.",
    );
  }
  const mode = requestedMode as Config["mode"];
  const apiKey =
    env.HAYASEND_API_KEY ??
    (mode === "local" ? "re_hayasend_dev" : undefined);
  const apiKeySecretArn = env.HAYASEND_API_KEY_SECRET_ARN;
  if (mode === "aws" && !apiKeySecretArn) {
    throw new ValidationError(
      "HAYASEND_API_KEY_SECRET_ARN is required in AWS mode.",
    );
  }
  if (mode === "aws" && apiKey) {
    throw new ValidationError(
      "HAYASEND_API_KEY is not supported in AWS mode; use Secrets Manager.",
    );
  }
  const databaseUrl = env.HAYASEND_DATABASE_URL;
  if (mode === "portable") {
    if (!databaseUrl) {
      throw new ValidationError(
        "HAYASEND_DATABASE_URL is required in portable mode.",
      );
    }
    let protocol = "";
    try {
      protocol = new URL(databaseUrl).protocol;
    } catch {
      // The public error deliberately excludes the credential-bearing value.
    }
    if (!["postgres:", "postgresql:"].includes(protocol)) {
      throw new ValidationError(
        "HAYASEND_DATABASE_URL must be a PostgreSQL connection URL.",
      );
    }
    if (
      !apiKey ||
      apiKey.length < 16 ||
      apiKey.length > 512 ||
      !apiKey.startsWith("re_")
    ) {
      throw new ValidationError(
        "HAYASEND_API_KEY must be a 16 to 512 character re_ key in portable mode.",
      );
    }
  }
  const portableTransport = env.HAYASEND_TRANSPORT;
  if (
    mode === "portable" &&
    !["console", "aws-ses"].includes(portableTransport ?? "")
  ) {
    throw new ValidationError(
      "HAYASEND_TRANSPORT must be console or aws-ses in portable mode.",
    );
  }
  if (
    mode === "portable" &&
    portableTransport === "console" &&
    env.NODE_ENV === "production"
  ) {
    throw new ValidationError(
      "The console transport is not supported in production portable mode.",
    );
  }
  const host =
    env.HAYASEND_HOST ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0");
  if (
    host.length < 1 ||
    host.length > 253 ||
    /[\s/\\]/.test(host)
  ) {
    throw new ValidationError(
      "HAYASEND_HOST must be a valid host name or IP address.",
    );
  }
  const port = Number(env.HAYASEND_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ValidationError(
      "HAYASEND_PORT must be an integer between 1 and 65535.",
    );
  }
  const inboundRetentionDays = Number(
    env.HAYASEND_INBOUND_RETENTION_DAYS ?? 7,
  );
  if (
    !Number.isInteger(inboundRetentionDays) ||
    inboundRetentionDays < 1 ||
    inboundRetentionDays > 30
  ) {
    throw new ValidationError(
      "HAYASEND_INBOUND_RETENTION_DAYS must be an integer between 1 and 30.",
    );
  }
  const inboundMaxMessageBytes = Number(
    env.HAYASEND_INBOUND_MAX_MESSAGE_BYTES ?? 25 * 1024 * 1024,
  );
  if (
    !Number.isInteger(inboundMaxMessageBytes) ||
    inboundMaxMessageBytes < 1 ||
    inboundMaxMessageBytes > 40 * 1024 * 1024
  ) {
    throw new ValidationError(
      "HAYASEND_INBOUND_MAX_MESSAGE_BYTES must be an integer between 1 and 41943040.",
    );
  }
  const inboundRawPrefix =
    env.HAYASEND_INBOUND_RAW_PREFIX ?? "inbound/raw/";
  if (
    inboundRawPrefix.length < 1 ||
    inboundRawPrefix.length > 62 ||
    inboundRawPrefix.includes("..") ||
    /[^a-zA-Z0-9!_.*'()/-]/.test(inboundRawPrefix)
  ) {
    throw new ValidationError(
      "HAYASEND_INBOUND_RAW_PREFIX must be a safe S3 prefix of at most 62 characters.",
    );
  }
  const webhookDeliveryRetentionDays = Number(
    env.HAYASEND_WEBHOOK_DELIVERY_RETENTION_DAYS ?? 7,
  );
  if (
    !Number.isInteger(webhookDeliveryRetentionDays) ||
    webhookDeliveryRetentionDays < 1 ||
    webhookDeliveryRetentionDays > 30
  ) {
    throw new ValidationError(
      "HAYASEND_WEBHOOK_DELIVERY_RETENTION_DAYS must be an integer between 1 and 30.",
    );
  }
  const templateHistoryRetentionDays = Number(
    env.HAYASEND_TEMPLATE_HISTORY_RETENTION_DAYS ?? 90,
  );
  if (
    !Number.isInteger(templateHistoryRetentionDays) ||
    templateHistoryRetentionDays < 1 ||
    templateHistoryRetentionDays > 365
  ) {
    throw new ValidationError(
      "HAYASEND_TEMPLATE_HISTORY_RETENTION_DAYS must be an integer between 1 and 365.",
    );
  }
  const templateHistoryLimit = Number(
    env.HAYASEND_TEMPLATE_HISTORY_LIMIT ?? 50,
  );
  if (
    !Number.isInteger(templateHistoryLimit) ||
    templateHistoryLimit < 1 ||
    templateHistoryLimit > 50
  ) {
    throw new ValidationError(
      "HAYASEND_TEMPLATE_HISTORY_LIMIT must be an integer between 1 and 50.",
    );
  }

  const portableSettings =
    mode === "portable"
      ? {
          databaseUrl: databaseUrl as string,
          portableTransport: portableTransport as "console" | "aws-ses",
          postgresPoolMax: integerSetting(
            env,
            "HAYASEND_POSTGRES_POOL_MAX",
            10,
            1,
            100,
          ),
          postgresIdleTimeoutMs: integerSetting(
            env,
            "HAYASEND_POSTGRES_IDLE_TIMEOUT_MS",
            10_000,
            0,
            600_000,
          ),
          postgresConnectionTimeoutMs: integerSetting(
            env,
            "HAYASEND_POSTGRES_CONNECTION_TIMEOUT_MS",
            5_000,
            1,
            60_000,
          ),
          postgresMaxLifetimeSeconds: integerSetting(
            env,
            "HAYASEND_POSTGRES_MAX_LIFETIME_SECONDS",
            3_600,
            0,
            86_400,
          ),
          workerConcurrency: integerSetting(
            env,
            "HAYASEND_WORKER_CONCURRENCY",
            4,
            1,
            32,
          ),
          workerLeaseSeconds: integerSetting(
            env,
            "HAYASEND_WORKER_LEASE_SECONDS",
            60,
            5,
            900,
          ),
          workerPollIntervalMs: integerSetting(
            env,
            "HAYASEND_WORKER_POLL_INTERVAL_MS",
            500,
            50,
            60_000,
          ),
          workerRetryDelaySeconds: integerSetting(
            env,
            "HAYASEND_WORKER_RETRY_DELAY_SECONDS",
            30,
            0,
            3_600,
          ),
          workerOutboxIntervalMs: integerSetting(
            env,
            "HAYASEND_WORKER_OUTBOX_INTERVAL_MS",
            1_000,
            100,
            60_000,
          ),
          jobMaxAttempts: integerSetting(
            env,
            "HAYASEND_JOB_MAX_ATTEMPTS",
            10,
            1,
            100,
          ),
          jobRetentionDays: integerSetting(
            env,
            "HAYASEND_JOB_RETENTION_DAYS",
            7,
            1,
            30,
          ),
        }
      : {};

  return {
    mode,
    host,
    port,
    region: env.AWS_REGION ?? "ap-northeast-1",
    inboundRawPrefix,
    inboundRetentionDays,
    inboundMaxMessageBytes,
    webhookDeliveryRetentionDays,
    templateHistoryRetentionDays,
    templateHistoryLimit,
    ...((mode === "local" || mode === "portable") && apiKey
      ? { apiKey }
      : {}),
    ...portableSettings,
    ...(apiKeySecretArn ? { apiKeySecretArn } : {}),
    ...(env.HAYASEND_TABLE_NAME
      ? { tableName: env.HAYASEND_TABLE_NAME }
      : {}),
    ...(env.HAYASEND_QUEUE_URL
      ? { queueUrl: env.HAYASEND_QUEUE_URL }
      : {}),
    ...(env.HAYASEND_QUEUE_ARN
      ? { queueArn: env.HAYASEND_QUEUE_ARN }
      : {}),
    ...(env.HAYASEND_DLQ_URL
      ? { deliveryDeadLetterQueueUrl: env.HAYASEND_DLQ_URL }
      : {}),
    ...(env.HAYASEND_SCHEDULER_DLQ_URL
      ? {
          schedulerDeadLetterQueueUrl:
            env.HAYASEND_SCHEDULER_DLQ_URL,
        }
      : {}),
    ...(env.HAYASEND_INBOUND_DLQ_URL
      ? { inboundDeadLetterQueueUrl: env.HAYASEND_INBOUND_DLQ_URL }
      : {}),
    ...(env.HAYASEND_PAYLOAD_BUCKET
      ? { payloadBucket: env.HAYASEND_PAYLOAD_BUCKET }
      : {}),
    ...(env.HAYASEND_CONFIGURATION_SET
      ? { configurationSet: env.HAYASEND_CONFIGURATION_SET }
      : {}),
    ...(env.HAYASEND_SCHEDULER_GROUP_NAME
      ? { schedulerGroupName: env.HAYASEND_SCHEDULER_GROUP_NAME }
      : {}),
    ...(env.HAYASEND_SCHEDULER_ROLE_ARN
      ? { schedulerRoleArn: env.HAYASEND_SCHEDULER_ROLE_ARN }
      : {}),
    ...(env.HAYASEND_SCHEDULER_DLQ_ARN
      ? {
          schedulerDeadLetterQueueArn:
            env.HAYASEND_SCHEDULER_DLQ_ARN,
        }
      : {}),
    ...(env.HAYASEND_INBOUND_BUCKET
      ? { inboundBucket: env.HAYASEND_INBOUND_BUCKET }
      : {}),
  };
}
