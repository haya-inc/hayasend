import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { AppError, UnauthorizedError, ValidationError } from "./core/errors.js";
import { secretsEqual } from "./core/crypto.js";
import type { EmailRecord } from "./core/types.js";
import {
  batchEmailSchema,
  domainSchema,
  paginationSchema,
  sendEmailSchema,
  updateEmailSchema,
  webhookSchema,
} from "./schemas.js";
import type { DomainService } from "./services/domain-service.js";
import type { EmailService } from "./services/email-service.js";
import type { WebhookService } from "./services/webhook-service.js";

export interface AppServices {
  apiKey: string;
  domainService: DomainService;
  emailService: EmailService;
  webhookService: WebhookService;
}

function validationCallback(
  result: { success: boolean; error?: { issues?: unknown[] } },
) {
  if (!result.success) {
    throw new ValidationError(
      `Request validation failed: ${JSON.stringify(result.error?.issues ?? [])}`,
    );
  }
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
  return error ? { ...email, error } : email;
}

export function createApp(services: AppServices) {
  const app = new Hono();

  app.use("*", async (context, next) => {
    const requestId =
      context.req.header("x-request-id")?.slice(0, 128) ?? randomUUID();
    context.header("x-request-id", requestId);
    context.header("x-content-type-options", "nosniff");
    context.header("cache-control", "no-store");

    if (context.req.path === "/healthz") {
      await next();
      return;
    }

    const authorization = context.req.header("authorization");
    const key = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!key || !secretsEqual(key, services.apiKey)) {
      throw new UnauthorizedError();
    }
    await next();
  });

  app.get("/healthz", (context) =>
    context.json({
      ok: true,
      service: "hayasend",
      version: "0.1.0",
    }),
  );

  app.post(
    "/emails",
    zValidator("json", sendEmailSchema, validationCallback),
    async (context) => {
      const input = context.req.valid("json");
      const result = await services.emailService.create(
        input,
        context.req.header("idempotency-key"),
      );
      return context.json({ id: result.record.id });
    },
  );

  app.post(
    "/emails/batch",
    zValidator("json", batchEmailSchema, validationCallback),
    async (context) => {
      const results = await services.emailService.createBatch(
        context.req.valid("json"),
        context.req.header("idempotency-key"),
      );
      return context.json({
        data: results.map(({ record }) => ({ id: record.id })),
      });
    },
  );

  app.get(
    "/emails",
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.emailService.list(limit, after);
      return context.json({
        object: "list",
        ...page,
        data: page.data.map(publicEmail),
      });
    },
  );

  app.get("/emails/:id", async (context) =>
    context.json(publicEmail(await services.emailService.get(context.req.param("id")))),
  );

  app.patch(
    "/emails/:id",
    zValidator("json", updateEmailSchema, validationCallback),
    async (context) => {
      const record = await services.emailService.reschedule(
        context.req.param("id"),
        context.req.valid("json").scheduled_at,
      );
      return context.json({ id: record.id });
    },
  );

  app.post("/emails/:id/cancel", async (context) => {
    const record = await services.emailService.cancel(context.req.param("id"));
    return context.json({ id: record.id });
  });

  app.post(
    "/domains",
    zValidator("json", domainSchema, validationCallback),
    async (context) =>
      context.json(
        await services.domainService.create(context.req.valid("json").name),
      ),
  );

  app.get(
    "/domains",
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.domainService.list(limit, after);
      return context.json({ object: "list", ...page });
    },
  );

  app.get("/domains/:id", async (context) =>
    context.json(await services.domainService.get(context.req.param("id"))),
  );

  app.post("/domains/:id/verify", async (context) =>
    context.json(await services.domainService.verify(context.req.param("id"))),
  );

  app.delete("/domains/:id", async (context) => {
    const id = context.req.param("id");
    await services.domainService.delete(id);
    return context.json({ object: "domain", id, deleted: true });
  });

  app.post(
    "/webhooks",
    zValidator("json", webhookSchema, validationCallback),
    async (context) => {
      const result = await services.webhookService.create(
        context.req.valid("json"),
      );
      return context.json({
        ...result.webhook,
        signing_secret: result.signing_secret,
      });
    },
  );

  app.get(
    "/webhooks",
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.webhookService.list(limit, after);
      return context.json({ object: "list", ...page });
    },
  );

  app.get("/webhooks/:id", async (context) =>
    context.json(await services.webhookService.get(context.req.param("id"))),
  );

  app.delete("/webhooks/:id", async (context) => {
    const id = context.req.param("id");
    await services.webhookService.delete(id);
    return context.json({ object: "webhook", id, deleted: true });
  });

  app.notFound((context) =>
    context.json(
      {
        statusCode: 404,
        name: "not_found",
        message: "The requested endpoint was not found.",
      },
      404,
    ),
  );

  app.onError((error, context) => {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(500, "application_error", "Internal server error.");
    console.error(
      JSON.stringify({
        level: "error",
        request_id: context.req.header("x-request-id"),
        method: context.req.method,
        path: context.req.path,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return context.json(
      {
        statusCode: appError.status,
        name: appError.name,
        message: appError.message,
      },
      appError.status as 400,
    );
  });

  return app;
}
