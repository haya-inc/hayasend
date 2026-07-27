/// <reference path="../../worker-configuration.d.ts" />

import { utf8ByteLength } from "../core/bytes.js";
import { secretsEqual } from "../core/crypto.js";
import {
  AppError,
  UnauthorizedError,
  ValidationError,
} from "../core/errors.js";
import { safeErrorCategory } from "../core/error-telemetry.js";
import type {
  EmailRecord,
  Job,
  SendEmailInput,
} from "../core/types.js";
import { D1DeliveryStore } from "../adapters/cloudflare/d1-delivery-store.js";
import {
  consumeCloudflareEmailEventBatch,
} from "../adapters/cloudflare/email-sending-events.js";
import {
  assertCloudflareEmailPreflight,
  CloudflareEmailSendingTransport,
} from "../adapters/cloudflare/email-sending-transport.js";
import { CloudflareInlineAttachmentService } from "../adapters/cloudflare/inline-attachment-service.js";
import { CloudflareQueueEmailScheduler } from "../adapters/cloudflare/queue-email-scheduler.js";
import {
  CloudflareJobQueue,
  consumeCloudflareQueueBatch,
  recoverCloudflareDeadLetterBatch,
  type CloudflareJobEnvelope,
} from "../adapters/cloudflare/queues-job-queue.js";
import { R2PayloadStorage } from "../adapters/cloudflare/r2-payload-storage.js";
import { CLOUDFLARE_EMAIL_CAPABILITIES } from "../adapters/cloudflare/cloudflare-email-capabilities.js";
import {
  batchEmailSchema,
  paginationSchema,
  sendEmailSchema,
} from "../schemas.js";
import { EmailService } from "../services/email-service.js";
import { OutboxReconciler } from "../services/outbox-reconciler.js";
import { SuppressionService } from "../services/suppression-service.js";
import { HAYASEND_VERSION } from "../version.js";
import { CLOUDFLARE_WORKER_CAPABILITY } from "../cloudflare-worker-capability.js";

export { CLOUDFLARE_WORKER_CAPABILITY } from "../cloudflare-worker-capability.js";

const MAX_REQUEST_BYTES = 9 * 1024 * 1024;

export interface HayaSendCloudflareEnv {
  DB: D1Database;
  PAYLOADS: R2Bucket;
  PRIMARY_QUEUE: Queue<CloudflareJobEnvelope>;
  EMAIL: {
    send(message: EmailMessageBuilder): Promise<EmailSendResult>;
  };
  HAYASEND_API_KEY: string;
  HAYASEND_DEPLOYMENT_ID: string;
  HAYASEND_PROVIDER: "cloudflare-email";
  HAYASEND_HEALTH_MODE: "ready" | "fail";
  PRIMARY_QUEUE_NAME: string;
  DLQ_QUEUE_NAME: string;
  EMAIL_EVENTS_QUEUE_NAME: string;
}

const noOpWebhooks = {
  async publish(): Promise<void> {},
};

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=UTF-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function publicEmail(record: EmailRecord) {
  const {
    request_hash: _requestHash,
    attempts: _attempts,
    send_lease_until: _sendLeaseUntil,
    payload_ref: _payloadRef,
    error,
    ...email
  } = record;
  const attachments = email.attachments?.map((attachment) => ({
    filename: attachment.filename,
    ...(attachment.content_type
      ? { content_type: attachment.content_type }
      : {}),
    ...(attachment.content_id
      ? { content_id: attachment.content_id }
      : {}),
    ...(attachment.content_disposition
      ? { content_disposition: attachment.content_disposition }
      : {}),
  }));
  return {
    ...email,
    ...(email.provider_id ? { message_id: email.provider_id } : {}),
    ...(attachments ? { attachments } : {}),
    ...(error ? { error } : {}),
  };
}

function parseIdempotencyKey(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  if (value.length === 0 || [...value].length > 256) {
    throw new ValidationError(
      "Idempotency-Key must contain between 1 and 256 characters.",
    );
  }
  return value;
}

function requireAuthentication(
  request: Request,
  env: HayaSendCloudflareEnv,
): void {
  const authorization = request.headers.get("authorization");
  const key = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (
    !key ||
    !env.HAYASEND_API_KEY ||
    !secretsEqual(key, env.HAYASEND_API_KEY)
  ) {
    throw new UnauthorizedError();
  }
}

async function requestJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (
    !Number.isFinite(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > MAX_REQUEST_BYTES
  ) {
    throw new ValidationError(
      `The serialized request must not exceed ${MAX_REQUEST_BYTES} bytes.`,
    );
  }
  const text = await request.text();
  if (utf8ByteLength(text) > MAX_REQUEST_BYTES) {
    throw new ValidationError(
      `The serialized request must not exceed ${MAX_REQUEST_BYTES} bytes.`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("Malformed JSON in request body.");
  }
}

function services(env: HayaSendCloudflareEnv) {
  if (env.HAYASEND_PROVIDER !== "cloudflare-email") {
    throw new AppError(
      503,
      "provider_unavailable",
      "The configured Cloudflare provider is unsupported.",
    );
  }
  const payloads = new R2PayloadStorage(env.PAYLOADS);
  const store = new D1DeliveryStore(env.DB, payloads);
  const queue = new CloudflareJobQueue(env.PRIMARY_QUEUE);
  const suppressions = new SuppressionService(store);
  const emailService = new EmailService(
    store,
    new CloudflareQueueEmailScheduler(queue),
    new CloudflareEmailSendingTransport(env.EMAIL),
    noOpWebhooks,
    suppressions,
    new CloudflareInlineAttachmentService(),
    undefined,
    {
      provider: {
        name: CLOUDFLARE_EMAIL_CAPABILITIES.provider,
        adapter_version:
          CLOUDFLARE_EMAIL_CAPABILITIES.adapter_version,
        capability_version:
          CLOUDFLARE_EMAIL_CAPABILITIES.schema_version,
      },
      pre_commit_validator: assertCloudflareEmailPreflight,
    },
  );
  const outbox = new OutboxReconciler(store, queue, {
    owner: `worker:${env.HAYASEND_DEPLOYMENT_ID}:${crypto.randomUUID()}`,
  });
  return {
    emailService,
    outbox,
    payloads,
    queue,
    store,
    suppressions,
  };
}

async function route(
  request: Request,
  env: HayaSendCloudflareEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/healthz" && request.method === "GET") {
    const ready = env.HAYASEND_HEALTH_MODE !== "fail";
    return json(
      {
        service: "hayasend",
        version: HAYASEND_VERSION,
        runtime: CLOUDFLARE_WORKER_CAPABILITY.runtime,
        status: ready ? "ready" : "failure-drill",
        production_ready: false,
        deployment_id: env.HAYASEND_DEPLOYMENT_ID,
        capability_digest:
          CLOUDFLARE_WORKER_CAPABILITY.capability_digest,
      },
      ready ? 200 : 503,
    );
  }
  if (pathname === "/capabilities" && request.method === "GET") {
    return json(CLOUDFLARE_WORKER_CAPABILITY);
  }
  requireAuthentication(request, env);
  const runtime = services(env);
  if (pathname === "/emails" && request.method === "POST") {
    const parsed = sendEmailSchema.safeParse(await requestJson(request));
    if (!parsed.success) {
      throw new ValidationError(
        `Request validation failed: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    const result = await runtime.emailService.create(
      parsed.data as SendEmailInput,
      parseIdempotencyKey(request.headers.get("idempotency-key")),
    );
    return json({ id: result.record.id });
  }
  if (pathname === "/emails/batch" && request.method === "POST") {
    const parsed = batchEmailSchema.safeParse(await requestJson(request));
    if (!parsed.success) {
      throw new ValidationError(
        `Request validation failed: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    const results = await runtime.emailService.createBatch(
      parsed.data as SendEmailInput[],
      parseIdempotencyKey(request.headers.get("idempotency-key")),
    );
    return json({
      data: results.map(({ record }) => ({ id: record.id })),
    });
  }
  if (pathname === "/emails" && request.method === "GET") {
    const parsed = paginationSchema.safeParse({
      limit: url.searchParams.get("limit") ?? undefined,
      after: url.searchParams.get("after") ?? undefined,
    });
    if (!parsed.success) {
      throw new ValidationError(
        `Request validation failed: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    const page = await runtime.emailService.list(
      parsed.data.limit,
      parsed.data.after,
    );
    return json({
      object: "list",
      ...page,
      data: page.data.map(publicEmail),
    });
  }
  const emailMatch = /^\/emails\/(email_[a-f0-9]{32})$/.exec(pathname);
  if (emailMatch?.[1] && request.method === "GET") {
    return json(
      publicEmail(await runtime.emailService.get(emailMatch[1])),
    );
  }
  return json(
    {
      statusCode: 404,
      name: "not_found",
      message: "The requested endpoint is unavailable in this Beta proof.",
    },
    404,
  );
}

async function processJob(
  job: Job,
  attempt: number,
  env: HayaSendCloudflareEnv,
): Promise<void> {
  const runtime = services(env);
  if (job.type === "send_email") {
    await runtime.emailService.processSend(job.email_id, attempt);
    return;
  }
  if (job.type === "reconcile_outbox") {
    await runtime.outbox.sweep();
    return;
  }
  throw new ValidationError(
    `Job type ${job.type} is unavailable in the Cloudflare Beta runtime.`,
  );
}

export default {
  async fetch(
    request: Request,
    env: HayaSendCloudflareEnv,
  ): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(
              500,
              "application_error",
              "Internal server error.",
            );
      if (appError.status >= 500) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "Cloudflare request failed",
            error_type: safeErrorCategory(error),
          }),
        );
      }
      return json(
        {
          statusCode: appError.status,
          name: appError.name,
          message: appError.message,
        },
        appError.status,
      );
    }
  },

  async queue(
    batch: MessageBatch<unknown>,
    env: HayaSendCloudflareEnv,
  ): Promise<void> {
    if (batch.queue === env.PRIMARY_QUEUE_NAME) {
      await consumeCloudflareQueueBatch(
        batch as MessageBatch<CloudflareJobEnvelope>,
        async (job, _envelope, attempt) =>
          processJob(job, attempt, env),
      );
      return;
    }
    if (batch.queue === env.DLQ_QUEUE_NAME) {
      await recoverCloudflareDeadLetterBatch(
        batch as MessageBatch<CloudflareJobEnvelope>,
        env.PRIMARY_QUEUE,
      );
      return;
    }
    if (batch.queue === env.EMAIL_EVENTS_QUEUE_NAME) {
      const runtime = services(env);
      await consumeCloudflareEmailEventBatch(batch, {
        resolver: runtime.store,
        emailService: runtime.emailService,
        suppressionService: runtime.suppressions,
      });
      return;
    }
    for (const message of batch.messages) {
      message.ack();
    }
    console.error(
      JSON.stringify({
        level: "error",
        message: "Unknown Cloudflare Queue binding",
        error_type: "invalid_data",
      }),
    );
  },

  async scheduled(
    _controller: ScheduledController,
    env: HayaSendCloudflareEnv,
    context: ExecutionContext,
  ): Promise<void> {
    const runtime = services(env);
    context.waitUntil(
      Promise.all([
        runtime.outbox.sweep(),
        runtime.store
          .listReferencedPayloadKeys()
          .then((referencedKeys) =>
            runtime.payloads.sweepOrphans({
              referenced_keys: referencedKeys,
              now: new Date(),
            }),
          ),
      ]).then(() => undefined),
    );
  },
} satisfies ExportedHandler<HayaSendCloudflareEnv>;
