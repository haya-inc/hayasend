import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createPortableAttachmentStorage } from "./adapters/portable-attachment-storage.js";
import { createSecretValueProvider } from "./adapters/secrets-manager.js";
import { createApp } from "./app.js";
import {
  assertApiServerConfig,
  loadConfig,
  type Config,
} from "./config.js";
import { safeErrorCategory } from "./core/error-telemetry.js";
import { createRuntime } from "./runtime.js";

export async function startServer(config: Config = loadConfig()) {
  assertApiServerConfig(config);
  const bootstrapKey =
    config.mode === "aws" && config.apiKeySecretArn
      ? createSecretValueProvider(config.apiKeySecretArn)
      : config.apiKey;
  const runtime = createRuntime(
    config,
    bootstrapKey,
    config.mode === "portable"
      ? createPortableAttachmentStorage(config)
      : undefined,
  );
  try {
    await runtime.checkReadiness();
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const app = createApp(runtime, {
    localPreview: config.mode === "local",
    readiness: () => runtime.checkReadiness(),
    ...(runtime.transportEventIngress && config.azureEventGridSecret
      ? {
          providerEventIngress: {
            secret: config.azureEventGridSecret,
            ingress: runtime.transportEventIngress,
          },
        }
      : {}),
    ...(runtime.sendGridEventIngress
      ? { sendGridEventIngress: runtime.sendGridEventIngress }
      : {}),
  });
  let server: ReturnType<typeof serve>;
  try {
    server = await new Promise<ReturnType<typeof serve>>(
      (resolve, reject) => {
        const candidate = serve(
          {
            fetch: app.fetch,
            hostname: config.host,
            port: config.port,
          },
          () => resolve(candidate),
        );
        candidate.once("error", reject);
      },
    );
  } catch (error) {
    await runtime.close();
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } finally {
      await runtime.close();
    }
  };
  console.info(
    JSON.stringify({
      level: "info",
      message: "HayaSend listening",
      mode: config.mode,
      url: `http://${config.host}:${config.port}`,
      ...(config.mode === "local"
        ? { preview_url: `http://${config.host}:${config.port}/preview` }
        : {}),
    }),
  );
  return { server, runtime, close };
}

export async function runServerProcess(): Promise<void> {
  const running = await startServer();
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.info(
      JSON.stringify({
        level: "info",
        message: "HayaSend stopping",
        signal,
      }),
    );
    try {
      await running.close();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "HayaSend shutdown failed",
          error_type: safeErrorCategory(error),
        }),
      );
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });
  process.once("SIGINT", () => {
    void stop("SIGINT");
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runServerProcess().catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "HayaSend failed to start",
        error_type: safeErrorCategory(error),
      }),
    );
    process.exitCode = 1;
  });
}
