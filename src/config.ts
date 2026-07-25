import { ValidationError } from "./core/errors.js";

export interface Config {
  mode: "local" | "aws";
  apiKey: string;
  port: number;
  region: string;
  tableName?: string;
  queueUrl?: string;
  payloadBucket?: string;
  configurationSet?: string;
}

function required(
  env: NodeJS.ProcessEnv,
  name: string,
  mode: Config["mode"],
) {
  const value = env[name];
  if (!value && mode === "aws") {
    throw new ValidationError(`${name} is required in AWS mode.`);
  }
  return value;
}

export function loadConfig(env = process.env): Config {
  const mode = env.HAYASEND_MODE === "aws" ? "aws" : "local";
  const apiKey =
    required(env, "HAYASEND_API_KEY", mode) ?? "re_hayasend_dev";
  const port = Number(env.HAYASEND_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ValidationError(
      "HAYASEND_PORT must be an integer between 1 and 65535.",
    );
  }

  return {
    mode,
    apiKey,
    port,
    region: env.AWS_REGION ?? "ap-northeast-1",
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
