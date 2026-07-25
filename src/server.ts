import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createSecretValueProvider } from "./adapters/secrets-manager.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

export function startServer() {
  const config = loadConfig();
  const bootstrapKey =
    config.mode === "aws" && config.apiKeySecretArn
      ? createSecretValueProvider(config.apiKeySecretArn)
      : config.apiKey;
  const app = createApp(createRuntime(config, bootstrapKey));
  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });
  console.info(
    JSON.stringify({
      level: "info",
      message: "HayaSend listening",
      mode: config.mode,
      url: `http://localhost:${config.port}`,
    }),
  );
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
