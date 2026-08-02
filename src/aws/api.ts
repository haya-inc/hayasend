import { handle } from "hono/aws-lambda";
import { createSecretValueProvider } from "../adapters/secrets-manager.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createConsoleAuthProvider } from "../console-auth-runtime.js";
import { createAwsRuntime } from "../runtime.js";

const config = loadConfig();
if (!config.apiKeySecretArn) {
  throw new Error("HAYASEND_API_KEY_SECRET_ARN is required in AWS mode.");
}
const consoleAuth =
  config.consoleAuthOrigin &&
  config.consoleAuthGoogleClientId &&
  config.consoleAuthAllowedEmails &&
  config.consoleAuthSecretArn
    ? createConsoleAuthProvider({
        origin: config.consoleAuthOrigin,
        googleClientId: config.consoleAuthGoogleClientId,
        allowedEmails: config.consoleAuthAllowedEmails,
        credentials: createSecretValueProvider(config.consoleAuthSecretArn),
      })
    : undefined;
const app = createApp(
  createAwsRuntime(
    config,
    createSecretValueProvider(config.apiKeySecretArn),
  ),
  consoleAuth ? { consoleAuth } : {},
);

export const handler = handle(app);
