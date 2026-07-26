import { ValidationError } from "./core/errors.js";

export interface Config {
  mode: "local" | "aws";
  apiKey?: string;
  apiKeySecretArn?: string;
  host: string;
  port: number;
  region: string;
  tableName?: string;
  queueUrl?: string;
  queueArn?: string;
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
}

export function loadConfig(env = process.env): Config {
  const mode = env.HAYASEND_MODE === "aws" ? "aws" : "local";
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
    ...(mode === "local" && apiKey ? { apiKey } : {}),
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
