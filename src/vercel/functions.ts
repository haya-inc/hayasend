import { waitUntil } from "@vercel/functions";
import {
  handleCallback,
  send,
  type MessageMetadata,
} from "@vercel/queue";
import { Hono } from "hono";
import { createPortableAttachmentStorage } from "../adapters/portable-attachment-storage.js";
import { createApp } from "../app.js";
import { loadConfig, type Config } from "../config.js";
import {
  createId,
  secretsEqual,
} from "../core/crypto.js";
import { safeErrorCategory } from "../core/error-telemetry.js";
import {
  PortableWorker,
  portableWorkerOptions,
  type PortableWorkerTickResult,
} from "../portable/worker.js";
import {
  createPortableRuntime,
  type PortableRuntime,
} from "../runtime.js";

export const VERCEL_QUEUE_TOPIC = "hayasend-jobs-v1";
export const VERCEL_QUEUE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MUTATING_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const DEFAULT_MAX_TICKS = 8;
const MAX_BURST_MILLISECONDS = 240_000;

interface VercelDeployment {
  app: {
    fetch(request: Request): Response | Promise<Response>;
  };
  config: Config;
  runtime: PortableRuntime;
}

interface QueueWakeup {
  schema_version: 1;
  kind: "reconcile";
}

export interface VercelBurstResult {
  ticks: number;
  leased: number;
  completed: number;
  retried: number;
  failed: number;
  lost: number;
}

let deployment: VercelDeployment | undefined;

export function vercelMaximumTicks(env = process.env): number {
  const value = Number(
    env.HAYASEND_VERCEL_MAX_TICKS ?? DEFAULT_MAX_TICKS,
  );
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(
      "HAYASEND_VERCEL_MAX_TICKS must be an integer between 1 and 100.",
    );
  }
  return value;
}

function createDeployment(): VercelDeployment {
  const config = loadConfig();
  if (config.mode !== "portable") {
    throw new Error(
      "The Vercel runtime requires HAYASEND_MODE=portable.",
    );
  }
  const runtime = createPortableRuntime(
    config,
    undefined,
    createPortableAttachmentStorage(config),
  );
  const app = createApp(runtime, {
    readiness: () => runtime.checkReadiness(),
    ...(runtime.transportEventIngress && config.azureEventGridSecret
      ? {
          providerEventIngress: {
            secret: config.azureEventGridSecret,
            ingress: runtime.transportEventIngress,
          },
        }
      : {}),
  });
  return { app, config, runtime };
}

function getDeployment(): VercelDeployment {
  if (!deployment) {
    deployment = createDeployment();
  }
  return deployment;
}

function mergeTick(
  aggregate: VercelBurstResult,
  result: PortableWorkerTickResult,
): void {
  aggregate.ticks += 1;
  aggregate.leased += result.leased;
  aggregate.completed += result.completed;
  aggregate.retried += result.retried;
  aggregate.failed += result.failed;
  aggregate.lost += result.lost;
}

export async function runVercelWorkerBurst(
  options: {
    now?: (() => number) | undefined;
    maximum_ticks?: number | undefined;
  } = {},
): Promise<VercelBurstResult> {
  const deployment = getDeployment();
  const now = options.now ?? Date.now;
  const startedAt = now();
  const worker = new PortableWorker(
    deployment.runtime,
    deployment.runtime.jobQueue,
    {
      ...portableWorkerOptions(deployment.config),
      owner: createId("vercel"),
    },
  );
  const aggregate: VercelBurstResult = {
    ticks: 0,
    leased: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    lost: 0,
  };
  const limit = options.maximum_ticks ?? vercelMaximumTicks();
  while (
    aggregate.ticks < limit &&
    now() - startedAt < MAX_BURST_MILLISECONDS
  ) {
    const result = await worker.tick();
    mergeTick(aggregate, result);
    if (result.leased < (deployment.config.workerConcurrency ?? 1)) {
      break;
    }
  }
  return aggregate;
}

export async function publishVercelWakeup(
  idempotencyKey = createId("wake"),
): Promise<void> {
  const message: QueueWakeup = {
    schema_version: 1,
    kind: "reconcile",
  };
  await send(VERCEL_QUEUE_TOPIC, message, {
    idempotencyKey,
    retentionSeconds: VERCEL_QUEUE_RETENTION_SECONDS,
  });
}

export function isVercelQueueWakeup(
  value: unknown,
): value is QueueWakeup {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 2 &&
    "schema_version" in value &&
    value.schema_version === 1 &&
    "kind" in value &&
    value.kind === "reconcile"
  );
}

export async function processVercelQueueMessage(
  message: unknown,
): Promise<void> {
  if (!isVercelQueueWakeup(message)) {
    throw new Error("Invalid HayaSend Vercel queue wakeup.");
  }
  await runVercelWorkerBurst();
}

export function vercelQueueRetryDecision(
  error: unknown,
  metadata: MessageMetadata,
):
  | { acknowledge: true }
  | { afterSeconds: number } {
  console.error(
    JSON.stringify({
      level: "error",
      message: "HayaSend Vercel queue burst failed",
      delivery_count: metadata.deliveryCount,
      error_type: safeErrorCategory(error),
    }),
  );
  if (metadata.deliveryCount >= 10) {
    return { acknowledge: true };
  }
  return {
    afterSeconds: Math.min(
      300,
      5 * 2 ** Math.max(0, metadata.deliveryCount - 1),
    ),
  };
}

export function createVercelQueueHandler() {
  return handleCallback(processVercelQueueMessage, {
    visibilityTimeoutSeconds: 300,
    retry: vercelQueueRetryDecision,
  });
}

function scheduleWakeup(): void {
  const task = publishVercelWakeup().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "HayaSend Vercel queue wakeup failed",
        error_type: safeErrorCategory(error),
      }),
    );
  });
  waitUntil(task);
}

export function shouldPublishVercelWakeup(
  request: Request,
  response: Response,
): boolean {
  return (
    MUTATING_METHODS.has(request.method.toUpperCase()) &&
    response.status >= 200 &&
    response.status < 300
  );
}

export function createVercelApplication(): Hono {
  const current = getDeployment();
  const app = new Hono();
  app.all("*", async (context) => {
    const request = context.req.raw;
    const response = await current.app.fetch(request);
    if (shouldPublishVercelWakeup(request, response)) {
      scheduleWakeup();
    }
    return response;
  });
  return app;
}

function cronSecret(env = process.env): string {
  const secret = env.CRON_SECRET;
  if (!secret || secret.length < 32 || secret.length > 512) {
    throw new Error(
      "CRON_SECRET must contain 32 to 512 characters.",
    );
  }
  return secret;
}

export function isVercelCronRequestAuthorized(
  request: Request,
  env = process.env,
): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  return secretsEqual(authorization, `Bearer ${cronSecret(env)}`);
}

export async function handleVercelCronRequest(
  request: Request,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET" },
    });
  }
  if (!isVercelCronRequestAuthorized(request)) {
    return Response.json(
      { name: "authentication_error", message: "Unauthorized." },
      { status: 401 },
    );
  }
  const result = await runVercelWorkerBurst();
  return Response.json({
    ok: true,
    ticks: result.ticks,
    leased: result.leased,
    completed: result.completed,
    retried: result.retried,
    failed: result.failed,
    lost: result.lost,
  });
}
