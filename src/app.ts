import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  AppError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "./core/errors.js";
import type {
  ApiScope,
  AuthenticatedPrincipal,
  EmailRecord,
} from "./core/types.js";
import { emitCountMetric } from "./core/metrics.js";
import {
  apiKeySchema,
  batchEmailSchema,
  domainSchema,
  paginationSchema,
  sendEmailSchema,
  suppressionSchema,
  updateEmailSchema,
  webhookSchema,
} from "./schemas.js";
import type { ApiKeyService } from "./services/api-key-service.js";
import type { DomainService } from "./services/domain-service.js";
import type { EmailService } from "./services/email-service.js";
import type { SuppressionService } from "./services/suppression-service.js";
import type { WebhookService } from "./services/webhook-service.js";

interface AppEnv {
  Variables: {
    principal: AuthenticatedPrincipal;
  };
}

export interface AppServices {
  apiKeyService: ApiKeyService;
  domainService: DomainService;
  emailService: EmailService;
  suppressionService: SuppressionService;
  webhookService: WebhookService;
}

function hasScope(principal: AuthenticatedPrincipal, scope: ApiScope) {
  return principal.scopes.includes("*") || principal.scopes.includes(scope);
}

function requireScope(scope: ApiScope) {
  return createMiddleware<AppEnv>(async (context, next) => {
    if (!hasScope(context.get("principal"), scope)) {
      throw new ForbiddenError(`This operation requires the ${scope} scope.`);
    }
    await next();
  });
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
  const app = new Hono<AppEnv>();

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
    if (!key) {
      throw new UnauthorizedError();
    }
    context.set("principal", await services.apiKeyService.authenticate(key));
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
    requireScope("emails:send"),
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
    requireScope("emails:send"),
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
    requireScope("emails:read"),
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

  app.get(
    "/emails/:id",
    requireScope("emails:read"),
    async (context) =>
      context.json(
        publicEmail(
          await services.emailService.get(context.req.param("id")),
        ),
      ),
  );

  app.patch(
    "/emails/:id",
    requireScope("emails:send"),
    zValidator("json", updateEmailSchema, validationCallback),
    async (context) => {
      const record = await services.emailService.reschedule(
        context.req.param("id"),
        context.req.valid("json").scheduled_at,
      );
      return context.json({ id: record.id });
    },
  );

  app.post(
    "/emails/:id/cancel",
    requireScope("emails:send"),
    async (context) => {
      const record = await services.emailService.cancel(
        context.req.param("id"),
      );
      return context.json({ id: record.id });
    },
  );

  app.post(
    "/domains",
    requireScope("domains:write"),
    zValidator("json", domainSchema, validationCallback),
    async (context) =>
      context.json(
        await services.domainService.create(context.req.valid("json").name),
      ),
  );

  app.get(
    "/domains",
    requireScope("domains:read"),
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.domainService.list(limit, after);
      return context.json({ object: "list", ...page });
    },
  );

  app.get(
    "/domains/:id",
    requireScope("domains:read"),
    async (context) =>
      context.json(
        await services.domainService.get(context.req.param("id")),
      ),
  );

  app.post(
    "/domains/:id/verify",
    requireScope("domains:write"),
    async (context) =>
      context.json(
        await services.domainService.verify(context.req.param("id")),
      ),
  );

  app.delete(
    "/domains/:id",
    requireScope("domains:write"),
    async (context) => {
      const id = context.req.param("id");
      await services.domainService.delete(id);
      return context.json({ object: "domain", id, deleted: true });
    },
  );

  app.post(
    "/webhooks",
    requireScope("webhooks:write"),
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
    requireScope("webhooks:read"),
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.webhookService.list(limit, after);
      return context.json({ object: "list", ...page });
    },
  );

  app.get(
    "/webhooks/:id",
    requireScope("webhooks:read"),
    async (context) =>
      context.json(
        await services.webhookService.get(context.req.param("id")),
      ),
  );

  app.delete(
    "/webhooks/:id",
    requireScope("webhooks:write"),
    async (context) => {
      const id = context.req.param("id");
      await services.webhookService.delete(id);
      return context.json({ object: "webhook", id, deleted: true });
    },
  );

  app.post(
    "/suppressions",
    requireScope("suppressions:write"),
    zValidator("json", suppressionSchema, validationCallback),
    async (context) =>
      context.json(
        await services.suppressionService.put(context.req.valid("json")),
      ),
  );

  app.get(
    "/suppressions",
    requireScope("suppressions:read"),
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.suppressionService.list(limit, after);
      return context.json({ object: "list", ...page });
    },
  );

  app.get(
    "/suppressions/:email",
    requireScope("suppressions:read"),
    async (context) =>
      context.json(
        await services.suppressionService.get(
          decodeURIComponent(context.req.param("email")),
        ),
      ),
  );

  app.delete(
    "/suppressions/:email",
    requireScope("suppressions:write"),
    async (context) => {
      const email = decodeURIComponent(context.req.param("email"));
      await services.suppressionService.delete(email);
      return context.json({ object: "suppression", email, deleted: true });
    },
  );

  app.post(
    "/api-keys",
    requireScope("api_keys:write"),
    zValidator("json", apiKeySchema, validationCallback),
    async (context) => {
      const input = context.req.valid("json");
      const principal = context.get("principal");
      if (
        !principal.scopes.includes("*") &&
        input.scopes.some((scope) => !principal.scopes.includes(scope))
      ) {
        throw new ForbiddenError(
          "An API key cannot delegate scopes it does not have.",
        );
      }
      const result = await services.apiKeyService.create(input);
      return context.json({ ...result.api_key, token: result.token });
    },
  );

  app.get(
    "/api-keys",
    requireScope("api_keys:read"),
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.apiKeyService.list(limit, after);
      return context.json({ object: "list", ...page });
    },
  );

  app.get(
    "/api-keys/:id",
    requireScope("api_keys:read"),
    async (context) =>
      context.json(
        await services.apiKeyService.get(context.req.param("id")),
      ),
  );

  app.delete(
    "/api-keys/:id",
    requireScope("api_keys:write"),
    async (context) => {
      const revoked = await services.apiKeyService.revoke(
        context.req.param("id"),
      );
      return context.json({ ...revoked, revoked: true });
    },
  );

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
    if (appError.status >= 500) {
      emitCountMetric("ApiErrors");
    }
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
