import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { ConsoleAuthProvider } from "./console-auth.js";
import { PREVIEW_CSS, PREVIEW_HTML, PREVIEW_JS } from "./preview.js";
import {
  OPERATOR_CONSOLE_CSS,
  OPERATOR_CONSOLE_JS,
  OPERATOR_CONSOLE_PREVIEW_HTML,
  OPERATOR_CONSOLE_PREVIEW_NONCE,
} from "./operator-console.js";
import { renderOperatorConsole } from "./operator-console-view.js";
import {
  AppError,
  ForbiddenError,
  PreconditionFailedError,
  UnauthorizedError,
  ValidationError,
} from "./core/errors.js";
import { safeErrorCategory } from "./core/error-telemetry.js";
import type {
  ApiScope,
  AuthenticatedPrincipal,
  EmailRecord,
} from "./core/types.js";
import { emitCountMetric } from "./core/metrics.js";
import {
  apiKeySchema,
  attachmentUploadSchema,
  batchEmailSchema,
  createTemplateSchema,
  domainSchema,
  emailPaginationSchema,
  paginationSchema,
  receivedEmailQuerySchema,
  renderTemplateSchema,
  sendEmailSchema,
  suppressionSchema,
  templatePaginationSchema,
  updateTemplateSchema,
  updateEmailSchema,
  webhookSchema,
  webhookUpdateSchema,
} from "./schemas.js";
import type { ApiKeyService } from "./services/api-key-service.js";
import {
  MAX_ATTACHMENT_BYTES,
  type AttachmentService,
} from "./services/attachment-service.js";
import type { DomainService } from "./services/domain-service.js";
import type { EmailService } from "./services/email-service.js";
import type { ReceivedEmailService } from "./services/received-email-service.js";
import type { RecoveryDiagnosticsService } from "./services/recovery-diagnostics-service.js";
import { HAYASEND_VERSION } from "./version.js";
import type { SuppressionService } from "./services/suppression-service.js";
import type { WebhookService } from "./services/webhook-service.js";
import type { TemplateService } from "./services/template-service.js";
import type { TransportEventIngress } from "./ports/transport-event-ingress.js";

interface AppEnv {
  Variables: {
    principal: AuthenticatedPrincipal;
    requestId: string;
    consoleIdentity:
      | { email: string; image?: string | undefined }
      | undefined;
  };
}

export interface AppServices {
  apiKeyService: ApiKeyService;
  attachmentService: AttachmentService;
  domainService: DomainService;
  emailService: EmailService;
  receivedEmailService: ReceivedEmailService;
  recoveryDiagnosticsService: RecoveryDiagnosticsService;
  suppressionService: SuppressionService;
  templateService: TemplateService;
  webhookService: WebhookService;
}

export interface AppOptions {
  consoleAuth?: ConsoleAuthProvider | undefined;
  localPreview?: boolean;
  readiness?: (() => Promise<void>) | undefined;
  providerEventIngress?:
    | {
        secret: string;
        ingress: TransportEventIngress<
          unknown,
          { received_at?: string | undefined },
          { validation_response?: string | undefined }
        >;
      }
    | undefined;
  sendGridEventIngress?:
    | TransportEventIngress<
        Uint8Array,
        {
          signature?: string | undefined;
          timestamp?: string | undefined;
          received_at?: string | undefined;
        }
      >
    | undefined;
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

function validationCallback(result: {
  success: boolean;
  error?: { issues?: unknown[] };
}) {
  if (!result.success) {
    throw new ValidationError(
      `Request validation failed: ${JSON.stringify(result.error?.issues ?? [])}`,
    );
  }
}

function parseTemplateVersionMatch(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const match = /^"(tmplv_[a-f0-9]{32})"$/.exec(value);
  if (!match?.[1]) {
    throw new ValidationError(
      "If-Match must contain a quoted HayaSend template version ID.",
    );
  }
  return match[1];
}

function parseIdempotencyKey(value: string | undefined) {
  if (value !== undefined && (value.length === 0 || [...value].length > 256)) {
    throw new ValidationError(
      "Idempotency-Key must contain between 1 and 256 characters.",
    );
  }
  return value;
}

function templateVersionId(value: string) {
  if (!/^tmplv_[a-f0-9]{32}$/.test(value)) {
    throw new ValidationError(
      "Template version ID must contain a HayaSend template version ID.",
    );
  }
  return value;
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
  const publicAttachments = email.attachments?.map((attachment) => ({
    ...(attachment.attachment_id
      ? { attachment_id: attachment.attachment_id }
      : {}),
    filename: attachment.filename,
    ...(attachment.content_type
      ? { content_type: attachment.content_type }
      : {}),
    ...(attachment.content_id ? { content_id: attachment.content_id } : {}),
    ...(attachment.content_disposition
      ? { content_disposition: attachment.content_disposition }
      : {}),
  }));
  const safeEmail = {
    ...email,
    ...(email.provider_id ? { message_id: email.provider_id } : {}),
    ...(publicAttachments ? { attachments: publicAttachments } : {}),
  };
  return error ? { ...safeEmail, error } : safeEmail;
}

async function readBodyWithLimit(request: Request, limit: number) {
  if (!request.body) {
    throw new ValidationError("Attachment content is required.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new ValidationError(
        `Attachment content must not exceed ${limit} bytes.`,
      );
    }
    chunks.push(value);
  }
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

async function readJsonBodyWithLimit(request: Request, limit: number) {
  if (!request.body) {
    throw new ValidationError("Provider event content is required.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new ValidationError(
        `Provider event content must not exceed ${limit} bytes.`,
      );
    }
    chunks.push(value);
  }
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(content)) as unknown;
  } catch {
    throw new ValidationError("Malformed JSON in provider event body.");
  }
}

async function readProviderEventBodyWithLimit(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  if (!request.body) {
    throw new ValidationError("Provider event content is required.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new ValidationError(
        `Provider event content must not exceed ${limit} bytes.`,
      );
    }
    chunks.push(value);
  }
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function matchesSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  let mismatch = actualBytes.byteLength ^ expectedBytes.byteLength;
  for (let index = 0; index < expectedBytes.byteLength; index += 1) {
    mismatch |= (actualBytes[index] ?? 0) ^ expectedBytes[index]!;
  }
  return mismatch === 0;
}

function previewSummary(record: EmailRecord) {
  return {
    id: record.id,
    status: record.status,
    last_event: record.last_event,
    from: record.from,
    to: record.to,
    subject: record.subject,
    created_at: record.created_at,
    updated_at: record.updated_at,
    has_html: Boolean(record.html),
    has_text: Boolean(record.text),
    attachment_count: record.attachments?.length ?? 0,
  };
}

function setPreviewSecurityHeaders(
  context: {
    header(name: string, value: string): void;
  },
  contentSecurityPolicy?: string,
) {
  context.header("cross-origin-opener-policy", "same-origin");
  context.header("cross-origin-resource-policy", "same-origin");
  context.header("referrer-policy", "no-referrer");
  context.header("x-frame-options", "DENY");
  if (contentSecurityPolicy) {
    context.header("content-security-policy", contentSecurityPolicy);
  }
}

function setOperatorConsoleSecurityHeaders(
  context: {
    header(name: string, value: string): void;
  },
  contentSecurityPolicy?: string,
  frameOptions = "DENY",
) {
  context.header("cross-origin-opener-policy", "same-origin");
  context.header("cross-origin-resource-policy", "same-origin");
  context.header("referrer-policy", "no-referrer");
  context.header("x-frame-options", frameOptions);
  if (contentSecurityPolicy) {
    context.header("content-security-policy", contentSecurityPolicy);
  }
}

function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const requestOrigin = new URL(request.url).origin;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    origin !== requestOrigin ||
    (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    throw new ForbiddenError(
      "Cookie-authenticated console mutations require a same-origin request.",
    );
  }
}

export function createApp(services: AppServices, options: AppOptions = {}) {
  const app = new Hono<AppEnv>();
  const localPreview = options.localPreview === true;

  app.use("*", async (context, next) => {
    const requestId = crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    context.header("x-content-type-options", "nosniff");
    context.header("cache-control", "no-store");

    const attachmentUploadPath = /^\/attachments\/[^/]+\/content$/.test(
      context.req.path,
    );
    const localPreviewPath =
      localPreview &&
      (context.req.path === "/" ||
        context.req.path === "/favicon.ico" ||
        context.req.path === "/preview" ||
        context.req.path.startsWith("/preview/"));
    const operatorConsolePath =
      context.req.method === "GET" &&
      [
        "/console",
        "/console/",
        "/console/app.css",
        "/console/app.js",
        "/console/preview",
      ].includes(context.req.path);
    const consoleAuthPath =
      options.consoleAuth !== undefined &&
      context.req.path.startsWith("/api/auth/");
    const providerEventPath =
      ((options.providerEventIngress !== undefined &&
        context.req.path === "/events/azure-email") ||
        (options.sendGridEventIngress !== undefined &&
          context.req.path === "/events/sendgrid")) &&
      context.req.method === "POST";
    if (
      context.req.path === "/healthz" ||
      context.req.path === "/readyz" ||
      operatorConsolePath ||
      consoleAuthPath ||
      localPreviewPath ||
      providerEventPath ||
      (attachmentUploadPath && ["PUT", "OPTIONS"].includes(context.req.method))
    ) {
      await next();
      return;
    }

    const authorization = context.req.header("authorization");
    const key = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (key) {
      context.set("principal", await services.apiKeyService.authenticate(key));
      await next();
      return;
    }
    if (options.consoleAuth) {
      const session = await (await options.consoleAuth()).getSession(
        context.req.raw.headers,
      );
      if (session) {
        if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
          requireSameOrigin(context.req.raw);
        }
        context.set("principal", session.principal);
        context.set("consoleIdentity", {
          email: session.email,
          ...(session.image ? { image: session.image } : {}),
        });
        await next();
        return;
      }
    }
    throw new UnauthorizedError();
  });

  app.get("/healthz", (context) =>
    context.json({
      ok: true,
      service: "hayasend",
      version: HAYASEND_VERSION,
    }),
  );

  app.get("/readyz", async (context) => {
    try {
      await options.readiness?.();
      return context.json({
        ok: true,
        service: "hayasend",
        version: HAYASEND_VERSION,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "HayaSend readiness check failed",
          error_type: safeErrorCategory(error),
        }),
      );
      return context.json(
        {
          ok: false,
          service: "hayasend",
          version: HAYASEND_VERSION,
        },
        503,
      );
    }
  });

  app.get("/console", (context) => {
    setOperatorConsoleSecurityHeaders(
      context,
      "default-src 'none'; script-src 'self'; style-src 'self'; " +
        "connect-src 'self'; img-src 'self' data:; frame-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    return context.html(
      renderOperatorConsole({
        betterAuthEnabled: options.consoleAuth !== undefined,
      }),
    );
  });

  app.get("/console/", (context) => context.redirect("/console", 308));

  app.get("/console/app.css", (context) => {
    setOperatorConsoleSecurityHeaders(context);
    return context.body(OPERATOR_CONSOLE_CSS, 200, {
      "content-type": "text/css; charset=utf-8",
    });
  });

  app.get("/console/app.js", (context) => {
    setOperatorConsoleSecurityHeaders(context);
    return context.body(OPERATOR_CONSOLE_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
    });
  });

  app.get("/console/preview", (context) => {
    setOperatorConsoleSecurityHeaders(
      context,
      `default-src 'none'; script-src 'nonce-${OPERATOR_CONSOLE_PREVIEW_NONCE}'; style-src 'unsafe-inline'; ` +
        "connect-src 'none'; img-src data: cid:; font-src 'none'; media-src 'none'; " +
        "frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "SAMEORIGIN",
    );
    return context.html(OPERATOR_CONSOLE_PREVIEW_HTML);
  });

  if (options.consoleAuth) {
    const consoleAuth = options.consoleAuth;
    app.on(["GET", "POST"], "/api/auth/*", async (context) =>
      (await consoleAuth()).handler(context.req.raw),
    );
  }

  app.get("/auth/session", (context) => {
    const principal = context.get("principal");
    const identity = context.get("consoleIdentity");
    return context.json({
      object: "authenticated_session",
      principal: {
        id: principal.id,
        name: principal.name,
        scopes: principal.scopes,
        bootstrap: principal.bootstrap,
      },
      ...(identity
        ? { authentication: "better-auth", identity }
        : { authentication: "api-key" }),
    });
  });

  if (options.providerEventIngress) {
    const providerEventIngress = options.providerEventIngress;
    app.post("/events/azure-email", async (context) => {
      if (
        !matchesSecret(
          context.req.header("x-hayasend-event-grid-secret"),
          providerEventIngress.secret,
        )
      ) {
        throw new UnauthorizedError();
      }
      const input = await readJsonBodyWithLimit(
        context.req.raw,
        1024 * 1024,
      );
      const result = await providerEventIngress.ingress.receive(input, {
        received_at: new Date().toISOString(),
      });
      return result.validation_response
        ? context.json({
            validationResponse: result.validation_response,
          })
        : context.json({ accepted: true });
    });
  }

  if (options.sendGridEventIngress) {
    const sendGridEventIngress = options.sendGridEventIngress;
    app.post("/events/sendgrid", async (context) => {
      const rawBody = await readProviderEventBodyWithLimit(
        context.req.raw,
        2 * 1024 * 1024,
      );
      await sendGridEventIngress.receive(rawBody, {
        signature: context.req.header(
          "x-twilio-email-event-webhook-signature",
        ),
        timestamp: context.req.header(
          "x-twilio-email-event-webhook-timestamp",
        ),
        received_at: new Date().toISOString(),
      });
      return context.json({ accepted: true }, 202);
    });
  }

  app.get(
    "/diagnostics/recovery",
    requireScope("diagnostics:read"),
    async (context) =>
      context.json(await services.recoveryDiagnosticsService.get()),
  );

  if (localPreview) {
    app.get("/", (context) => context.redirect("/preview", 302));
    app.get("/favicon.ico", (context) => {
      setPreviewSecurityHeaders(context);
      return context.body(null, 204);
    });
    app.get("/preview", (context) => {
      setPreviewSecurityHeaders(
        context,
        "default-src 'none'; script-src 'self'; style-src 'self'; " +
          "connect-src 'self'; img-src 'self' data:; frame-src 'self'; " +
          "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      return context.html(PREVIEW_HTML);
    });
    app.get("/preview/app.css", (context) => {
      setPreviewSecurityHeaders(context);
      return context.body(PREVIEW_CSS, 200, {
        "content-type": "text/css; charset=utf-8",
      });
    });
    app.get("/preview/app.js", (context) => {
      setPreviewSecurityHeaders(context);
      return context.body(PREVIEW_JS, 200, {
        "content-type": "text/javascript; charset=utf-8",
      });
    });
    app.get(
      "/preview/api/emails",
      zValidator("query", paginationSchema, validationCallback),
      async (context) => {
        setPreviewSecurityHeaders(context);
        const { limit, after } = context.req.valid("query");
        const page = await services.emailService.list(limit, after);
        return context.json({
          object: "list",
          ...page,
          data: page.data.map(previewSummary),
        });
      },
    );
    app.get("/preview/api/emails/:id", async (context) => {
      setPreviewSecurityHeaders(context);
      return context.json(
        publicEmail(await services.emailService.get(context.req.param("id"))),
      );
    });
  }

  app.post(
    "/attachments",
    requireScope("emails:send"),
    zValidator("json", attachmentUploadSchema, validationCallback),
    async (context) =>
      context.json(
        await services.attachmentService.create(
          context.req.valid("json"),
          new URL(context.req.url).origin,
        ),
      ),
  );

  app.options("/attachments/:id/content", (context) => {
    context.header("access-control-allow-origin", "*");
    context.header("access-control-allow-methods", "PUT, OPTIONS");
    context.header("access-control-allow-headers", "content-type");
    context.header("access-control-max-age", "300");
    return context.body(null, 204);
  });

  app.put("/attachments/:id/content", async (context) => {
    const rawContentLength = context.req.header("content-length");
    const contentLength =
      rawContentLength === undefined ? undefined : Number(rawContentLength);
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > MAX_ATTACHMENT_BYTES)
    ) {
      throw new ValidationError("Invalid attachment content length.");
    }
    const record = await services.attachmentService.authorizeProxyUpload(
      context.req.param("id"),
      context.req.query("token") ?? "",
      contentLength,
    );
    const content = await readBodyWithLimit(context.req.raw, record.size_bytes);
    await services.attachmentService.upload(
      record,
      content,
      context.req.header("content-type") ?? "",
    );
    context.header("access-control-allow-origin", "*");
    return context.body(null, 204);
  });

  app.post(
    "/emails",
    requireScope("emails:send"),
    zValidator("json", sendEmailSchema, validationCallback),
    async (context) => {
      const input = context.req.valid("json");
      const result = await services.emailService.create(
        input,
        parseIdempotencyKey(context.req.header("idempotency-key")),
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
        parseIdempotencyKey(context.req.header("idempotency-key")),
      );
      return context.json({
        data: results.map(({ record }) => ({ id: record.id })),
      });
    },
  );

  app.post(
    "/templates",
    requireScope("templates:write"),
    zValidator("json", createTemplateSchema, validationCallback),
    async (context) =>
      context.json(
        await services.templateService.create(context.req.valid("json")),
      ),
  );

  app.get(
    "/templates",
    requireScope("templates:read"),
    zValidator("query", templatePaginationSchema, validationCallback),
    async (context) => {
      const { limit, after, before } = context.req.valid("query");
      const page = await services.templateService.list(limit, after, before);
      return context.json({ object: "list", ...page });
    },
  );

  app.get(
    "/templates/:identifier",
    requireScope("templates:read"),
    async (context) => {
      const template = await services.templateService.get(
        context.req.param("identifier"),
      );
      context.header("etag", `"${template.current_version_id}"`);
      return context.json(template);
    },
  );

  app.patch(
    "/templates/:identifier",
    requireScope("templates:write"),
    zValidator("json", updateTemplateSchema, validationCallback),
    async (context) =>
      context.json(
        await services.templateService.update(
          context.req.param("identifier"),
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/templates/:identifier/render",
    requireScope("templates:read"),
    zValidator("json", renderTemplateSchema, validationCallback),
    async (context) => {
      const rendered = await services.templateService.renderDraft(
        context.req.param("identifier"),
        context.req.valid("json"),
      );
      context.header("etag", `"${rendered.version_id}"`);
      return context.json(rendered);
    },
  );

  app.post(
    "/templates/:identifier/publish",
    requireScope("templates:write"),
    async (context) => {
      const expectedVersion = parseTemplateVersionMatch(
        context.req.header("if-match"),
      );
      return context.json(
        await services.templateService.publish(
          context.req.param("identifier"),
          new Date(),
          expectedVersion,
          {
            actor: {
              id: context.get("principal").id,
              name: context.get("principal").name,
            },
            source:
              context.req.header("x-hayasend-source") === "cli"
                ? "cli"
                : "api",
          },
        ),
      );
    },
  );

  app.get(
    "/templates/:identifier/versions",
    requireScope("templates:read"),
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.templateService.listVersions(
        context.req.param("identifier"),
        limit,
        after,
      );
      return context.json({ object: "list", ...page });
    },
  );

  app.get(
    "/templates/:identifier/versions/:versionId",
    requireScope("templates:read"),
    async (context) =>
      context.json(
        await services.templateService.getVersion(
          context.req.param("identifier"),
          templateVersionId(context.req.param("versionId")),
        ),
      ),
  );

  app.post(
    "/templates/:identifier/versions/:versionId/render",
    requireScope("templates:read"),
    zValidator("json", renderTemplateSchema, validationCallback),
    async (context) => {
      const rendered = await services.templateService.renderVersion(
        context.req.param("identifier"),
        templateVersionId(context.req.param("versionId")),
        context.req.valid("json"),
      );
      context.header("etag", `"${rendered.version_id}"`);
      return context.json(rendered);
    },
  );

  app.post(
    "/templates/:identifier/versions/:versionId/restore",
    requireScope("templates:write"),
    async (context) => {
      const expectedVersion = parseTemplateVersionMatch(
        context.req.header("if-match"),
      );
      if (!expectedVersion) {
        throw new PreconditionFailedError(
          "If-Match with the current draft version ID is required for restore.",
        );
      }
      return context.json(
        await services.templateService.restoreVersion(
          context.req.param("identifier"),
          templateVersionId(context.req.param("versionId")),
          expectedVersion,
        ),
      );
    },
  );

  app.post(
    "/templates/:identifier/duplicate",
    requireScope("templates:write"),
    async (context) =>
      context.json(
        await services.templateService.duplicate(
          context.req.param("identifier"),
        ),
      ),
  );

  app.delete(
    "/templates/:identifier",
    requireScope("templates:write"),
    async (context) =>
      context.json(
        await services.templateService.delete(context.req.param("identifier")),
      ),
  );

  app.get(
    "/emails",
    requireScope("emails:read"),
    zValidator("query", emailPaginationSchema, validationCallback),
    async (context) => {
      const { limit, after, view } = context.req.valid("query");
      const page = await services.emailService.list(limit, after);
      return context.json({
        object: "list",
        ...page,
        data: page.data.map(view === "summary" ? previewSummary : publicEmail),
      });
    },
  );

  app.get(
    "/emails/receiving",
    requireScope("emails:read"),
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.receivedEmailService.list(limit, after);
      return context.json({ object: "list", ...page });
    },
  );

  app.get(
    "/emails/receiving/:id",
    requireScope("emails:read"),
    zValidator("query", receivedEmailQuerySchema, validationCallback),
    async (context) =>
      context.json(
        await services.receivedEmailService.get(
          context.req.param("id"),
          context.req.valid("query").html_format,
        ),
      ),
  );

  app.get(
    "/emails/receiving/:id/attachments",
    requireScope("emails:read"),
    async (context) =>
      context.json(
        await services.receivedEmailService.listAttachments(
          context.req.param("id"),
        ),
      ),
  );

  app.get(
    "/emails/receiving/:id/attachments/:attachmentId",
    requireScope("emails:read"),
    async (context) =>
      context.json(
        await services.receivedEmailService.getAttachment(
          context.req.param("id"),
          context.req.param("attachmentId"),
        ),
      ),
  );

  app.get(
    "/emails/:id/recipients",
    requireScope("emails:read"),
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      return context.json({
        object: "list",
        ...(await services.emailService.listRecipientSummaries(
          context.req.param("id"),
          limit,
          after,
        )),
      });
    },
  );

  app.get("/emails/:id", requireScope("emails:read"), async (context) =>
    context.json(
      publicEmail(await services.emailService.get(context.req.param("id"))),
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

  app.get("/domains/:id", requireScope("domains:read"), async (context) =>
    context.json(await services.domainService.get(context.req.param("id"))),
  );

  app.post(
    "/domains/:id/verify",
    requireScope("domains:write"),
    async (context) =>
      context.json(
        await services.domainService.verify(context.req.param("id")),
      ),
  );

  app.delete("/domains/:id", requireScope("domains:write"), async (context) => {
    const id = context.req.param("id");
    await services.domainService.delete(id);
    return context.json({ object: "domain", id, deleted: true });
  });

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

  app.get("/webhooks/:id", requireScope("webhooks:read"), async (context) =>
    context.json(await services.webhookService.get(context.req.param("id"))),
  );

  app.get(
    "/webhooks/:id/deliveries",
    requireScope("webhooks:read"),
    zValidator("query", paginationSchema, validationCallback),
    async (context) => {
      const { limit, after } = context.req.valid("query");
      const page = await services.webhookService.listDeliveries(
        context.req.param("id"),
        limit,
        after,
      );
      return context.json({ object: "list", ...page });
    },
  );

  app.get(
    "/webhooks/:id/deliveries/:deliveryId",
    requireScope("webhooks:read"),
    async (context) =>
      context.json({
        object: "webhook_delivery",
        ...(await services.webhookService.getDelivery(
          context.req.param("id"),
          context.req.param("deliveryId"),
        )),
      }),
  );

  app.post(
    "/webhooks/:id/deliveries/:deliveryId/replay",
    requireScope("webhooks:write"),
    async (context) =>
      context.json(
        await services.webhookService.replay(
          context.req.param("id"),
          context.req.param("deliveryId"),
        ),
      ),
  );

  app.patch(
    "/webhooks/:id",
    requireScope("webhooks:write"),
    zValidator("json", webhookUpdateSchema, validationCallback),
    async (context) => {
      const id = context.req.param("id");
      await services.webhookService.update(id, context.req.valid("json"));
      return context.json({ object: "webhook", id });
    },
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
          context.req.param("email"),
        ),
      ),
  );

  app.delete(
    "/suppressions/:email",
    requireScope("suppressions:write"),
    async (context) => {
      const email = context.req.param("email");
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

  app.get("/api-keys/:id", requireScope("api_keys:read"), async (context) =>
    context.json(await services.apiKeyService.get(context.req.param("id"))),
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
        : error instanceof HTTPException &&
            error.status === 400 &&
            error.message === "Malformed JSON in request body"
          ? new ValidationError(error.message)
        : new AppError(500, "application_error", "Internal server error.");
    if (appError.status >= 500) {
      emitCountMetric("ApiErrors");
      console.error(
        JSON.stringify({
          level: "error",
          message: "API request failed",
          request_id: context.get("requestId"),
          method: context.req.method,
          error_type: safeErrorCategory(error),
        }),
      );
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
