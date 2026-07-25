import { ValidationError } from "./core/errors.js";

export interface Config {
  mode: "local" | "aws";
  apiKey?: string;
  apiKeySecretArn?: string;
  port: number;
  region: string;
  tableName?: string;
  queueUrl?: string;
  payloadBucket?: string;
  configurationSet?: string;
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
  const port = Number(env.HAYASEND_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ValidationError(
      "HAYASEND_PORT must be an integer between 1 and 65535.",
    );
  }

  return {
    mode,
    port,
    region: env.AWS_REGION ?? "ap-northeast-1",
    ...(mode === "local" && apiKey ? { apiKey } : {}),
    ...(apiKeySecretArn ? { apiKeySecretArn } : {}),
    ...(env.HAYASEND_TABLE_NAME
      ? { tableName: env.HAYASEND_TABLE_NAME }
      : {}),
    ...(env.HAYASEND_QUEUE_URL
      ? { queueUrl: env.HAYASEND_QUEUE_URL }
      : {}),
    ...(env.HAYASEND_PAYLOAD_BUCKET
      ? { payloadBucket: env.HAYASEND_PAYLOAD_BUCKET }
      : {}),
    ...(env.HAYASEND_CONFIGURATION_SET
      ? { configurationSet: env.HAYASEND_CONFIGURATION_SET }
      : {}),
  };
}
