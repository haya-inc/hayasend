import { handle } from "hono/aws-lambda";
import { createSecretValueProvider } from "../adapters/secrets-manager.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createAwsRuntime } from "../runtime.js";

const config = loadConfig();
if (!config.apiKeySecretArn) {
  throw new Error("HAYASEND_API_KEY_SECRET_ARN is required in AWS mode.");
}
const app = createApp(
  createAwsRuntime(
    config,
    createSecretValueProvider(config.apiKeySecretArn),
  ),
);

export const handler = handle(app);
