#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { bootstrapAws } from "./cli-aws-bootstrap.js";
import {
  cleanupAws,
  defaultCommandRunner,
  deployAws,
  statusAws,
  type CommandRunner,
} from "./cli-aws-deploy.js";
import {
  cleanupCloudflare,
  deployCloudflare,
  doctorCloudflare,
  doctorCloudflareEmailEvents,
  rollbackCloudflare,
} from "./cli-cloudflare-deploy.js";
import { domainCommand } from "./cli-domains.js";
import { emailCommand } from "./cli-emails.js";
import { parseAttachmentUploadOrigins } from "./cli-send-attachments.js";
import { resendMigrationCommand } from "./cli-resend-migration.js";
import { readStandardInput, sendEmail } from "./cli-send.js";
import {
  loadTemplateManifest,
  parseRemoteTemplate,
  parseTemplateVariables,
  templatesMatch,
  type DesiredTemplate,
  type RemoteTemplate,
} from "./cli-templates.js";
import { suppressionCommand } from "./cli-suppressions.js";
import { webhookCommand } from "./cli-webhooks.js";
import {
  deploymentCapabilityDocument,
  deploymentCapabilityDocumentDigest,
} from "./deployment-capability-registry.js";
import { providerCapabilityDocumentDigest } from "./provider-capability-registry.js";
import {
  runtimeCapabilityDocument,
  runtimeCapabilityDocumentDigest,
} from "./runtime-capability-registry.js";
import { apiKeySchema, publicApiKeySchema } from "./schemas.js";
import { runServerProcess } from "./server.js";
import { HAYASEND_VERSION } from "./version.js";

const REQUEST_TIMEOUT_MS = 5_000;

interface CliIo {
  log(message: string): void;
  error(message: string): void;
}

interface CliDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  io: CliIo;
  readStdin(maximumBytes: number): Promise<Uint8Array>;
  runCommand: CommandRunner;
  sleep(milliseconds: number): Promise<void>;
}

const defaultDependencies: CliDependencies = {
  cwd: process.cwd(),
  env: process.env,
  fetch,
  io: console,
  readStdin: readStandardInput,
  runCommand: defaultCommandRunner,
  sleep: (milliseconds) =>
    new Promise((resolvePromise) => {
      setTimeout(resolvePromise, milliseconds);
    }),
};

function flags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) {
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    values.push(value);
  }
  return values;
}

function flag(args: string[], name: string): string | undefined {
  const values = flags(args, name);
  if (values.length > 1) {
    throw new Error(`Option --${name} may be provided only once.`);
  }
  return values[0];
}

function hasFlag(args: string[], name: string) {
  return args.includes(`--${name}`);
}

function positional(args: string[], index: number, label: string) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

interface OptionSpecification {
  values?: string[];
  booleans?: string[];
  repeatable?: string[];
  positionals?: number;
}

function validateOptions(
  args: string[],
  {
    values = [],
    booleans = [],
    repeatable = [],
    positionals = 0,
  }: OptionSpecification,
) {
  const seen = new Set<string>();
  let positionalCount = 0;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (!option?.startsWith("--")) {
      if (positionalCount >= positionals) {
        throw new Error(`Unexpected argument: ${option ?? ""}`);
      }
      positionalCount += 1;
      continue;
    }
    const name = option.slice(2);
    if (booleans.includes(name)) {
      if (seen.has(name)) {
        throw new Error(`Option --${name} may be provided only once.`);
      }
      seen.add(name);
      continue;
    }
    if (![...values, ...repeatable].includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (seen.has(name) && !repeatable.includes(name)) {
      throw new Error(`Option --${name} may be provided only once.`);
    }
    seen.add(name);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    index += 1;
  }
  if (positionalCount < positionals) {
    throw new Error("A required argument is missing.");
  }
}

class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}: ${JSON.stringify(redactHttpErrorBody(body))}`);
  }
}

function redactHttpErrorBody(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactHttpErrorBody);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      const sensitive =
        normalized.includes("secret") ||
        normalized.includes("token") ||
        normalized.includes("apikey") ||
        normalized.includes("idempotencykey") ||
        normalized.includes("authorization");
      return [key, sensitive ? "[REDACTED]" : redactHttpErrorBody(entry)];
    }),
  );
}

function isLoopbackHostname(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function normalizeEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The HayaSend endpoint must be an absolute URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("The HayaSend endpoint must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "The HayaSend endpoint must not include credentials, query parameters, or a fragment.",
    );
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      "Plain HTTP is allowed only for localhost endpoints because the API key would be exposed.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function endpoint(args: string[], env: NodeJS.ProcessEnv) {
  return normalizeEndpoint(
    flag(args, "endpoint") ?? env.HAYASEND_BASE_URL ?? "http://localhost:8787",
  );
}

function apiKey(env: NodeJS.ProcessEnv) {
  return env.HAYASEND_API_KEY ?? "re_hayasend_dev";
}

async function readJsonResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `Expected a JSON response from HayaSend (HTTP ${response.status}).`,
    );
  }
  return response.json() as Promise<unknown>;
}

async function request(
  path: string,
  args: string[],
  dependencies: CliDependencies,
  init?: RequestInit,
) {
  const response = await dependencies.fetch(
    `${endpoint(args, dependencies.env)}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey(dependencies.env)}`,
        "content-type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const body = await readJsonResponse(response);
  if (!response.ok) {
    throw new HttpResponseError(response.status, body);
  }
  return body;
}

function idFromResponse(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0
  ) {
    throw new Error("HayaSend did not return a valid identifier.");
  }
  return value.id;
}

const API_KEY_ID_PATTERN = /^key_[a-f0-9]{32}$/;
const API_KEY_TOKEN_PATTERN = /^re_hs_key_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/;
const createdApiKeySchema = publicApiKeySchema
  .extend({
    token: z.string().regex(API_KEY_TOKEN_PATTERN),
  })
  .strict();
const apiKeyListSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(publicApiKeySchema),
    has_more: z.boolean(),
    next_cursor: z.string().regex(API_KEY_ID_PATTERN).optional(),
  })
  .strict();
const revokedApiKeySchema = publicApiKeySchema
  .extend({ revoked: z.literal(true) })
  .strict();

function apiKeyPath(identifier: string) {
  if (!API_KEY_ID_PATTERN.test(identifier)) {
    throw new Error("API key ID is invalid.");
  }
  return `/api-keys/${encodeURIComponent(identifier)}`;
}

function apiKeyPayload(args: string[]) {
  const name = flag(args, "name");
  const expiresAt = flag(args, "expires-at");
  const payload = {
    name: name ?? "",
    scopes: [...new Set(flags(args, "scope"))],
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
  const parsed = apiKeySchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `API key input is invalid: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  if (
    parsed.data.expires_at &&
    new Date(parsed.data.expires_at).getTime() <= Date.now()
  ) {
    throw new Error("--expires-at must be in the future.");
  }
  return parsed.data;
}

function createdApiKey(value: unknown) {
  const parsed = createdApiKeySchema.safeParse(value);
  if (
    !parsed.success ||
    !parsed.data.token.startsWith(`re_hs_${parsed.data.id}.`)
  ) {
    throw new Error("HayaSend did not return a valid API key and token.");
  }
  const { token, ...metadata } = parsed.data;
  return { metadata, token };
}

function apiKeyResponse<T>(value: unknown, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("HayaSend did not return valid API key metadata.");
  }
  return parsed.data;
}

async function createApiKey(args: string[], dependencies: CliDependencies) {
  const payload = apiKeyPayload(args);
  const output = flag(args, "token-out");
  if (!output) {
    throw new Error("keys create requires --token-out.");
  }
  endpoint(args, dependencies.env);
  const tokenPath = resolve(dependencies.cwd, output);
  if (tokenPath === parse(tokenPath).root) {
    throw new Error("Refusing to write an API key token to a filesystem root.");
  }

  let tokenFile;
  try {
    tokenFile = await open(tokenPath, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing file: ${tokenPath}`);
    }
    throw error;
  }

  let metadata: Record<string, unknown> = {};
  try {
    const created = createdApiKey(
      await request("/api-keys", args, dependencies, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    metadata = created.metadata;
    await tokenFile.writeFile(created.token, "utf8");
    await tokenFile.sync();
    await tokenFile.close();
  } catch (error) {
    await tokenFile.close().catch(() => undefined);
    await unlink(tokenPath).catch(() => undefined);
    throw error;
  }
  dependencies.io.log(
    JSON.stringify(
      {
        ...metadata,
        token_file: tokenPath,
        token_written: true,
      },
      null,
      2,
    ),
  );
}

async function apiKeyCommand(args: string[], dependencies: CliDependencies) {
  const command = args[0] ?? "help";
  switch (command) {
    case "create":
      validateOptions(args, {
        values: ["name", "expires-at", "token-out", "endpoint"],
        repeatable: ["scope"],
      });
      await createApiKey(args, dependencies);
      break;
    case "list": {
      validateOptions(args, {
        values: ["limit", "after", "endpoint"],
      });
      const limit = flag(args, "limit");
      if (
        limit &&
        (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
      ) {
        throw new Error("--limit must be an integer between 1 and 100.");
      }
      const parameters = new URLSearchParams();
      for (const name of ["limit", "after"]) {
        const value = flag(args, name);
        if (value) {
          if (name === "after" && !API_KEY_ID_PATTERN.test(value)) {
            throw new Error("--after must be a valid API key ID.");
          }
          parameters.set(name, value);
        }
      }
      const query = parameters.size > 0 ? `?${parameters}` : "";
      dependencies.io.log(
        JSON.stringify(
          apiKeyResponse(
            await request(`/api-keys${query}`, args, dependencies),
            apiKeyListSchema,
          ),
          null,
          2,
        ),
      );
      break;
    }
    case "get":
      validateOptions(args, {
        values: ["endpoint"],
        positionals: 1,
      });
      dependencies.io.log(
        JSON.stringify(
          apiKeyResponse(
            await request(
              apiKeyPath(positional(args, 1, "API key ID")),
              args,
              dependencies,
            ),
            publicApiKeySchema,
          ),
          null,
          2,
        ),
      );
      break;
    case "revoke":
      validateOptions(args, {
        values: ["endpoint"],
        positionals: 1,
      });
      dependencies.io.log(
        JSON.stringify(
          apiKeyResponse(
            await request(
              apiKeyPath(positional(args, 1, "API key ID")),
              args,
              dependencies,
              { method: "DELETE" },
            ),
            revokedApiKeySchema,
          ),
          null,
          2,
        ),
      );
      break;
    default:
      throw new Error(`Unknown keys command: ${command}. Run hayasend help.`);
  }
}

function templatePath(identifier: string) {
  return `/templates/${encodeURIComponent(identifier)}`;
}

function templatePayload(template: DesiredTemplate) {
  return {
    alias: template.alias,
    name: template.name,
    html: template.html,
    text: template.text,
    from: template.from,
    subject: template.subject,
    reply_to: template.reply_to,
    variables: template.variables,
  };
}

interface TemplatePlan {
  desired: DesiredTemplate;
  remote?: RemoteTemplate;
  actions: Array<"create" | "update" | "publish">;
}

async function planTemplatePush(
  args: string[],
  dependencies: CliDependencies,
  templates: DesiredTemplate[],
  publish: boolean,
) {
  const plans: TemplatePlan[] = [];
  for (const desired of templates) {
    let remote: RemoteTemplate | undefined;
    try {
      remote = parseRemoteTemplate(
        await request(templatePath(desired.alias), args, dependencies),
      );
    } catch (error) {
      if (!(error instanceof HttpResponseError) || error.status !== 404) {
        throw error;
      }
    }
    const actions: TemplatePlan["actions"] = [];
    if (!remote) {
      actions.push("create");
    } else if (!templatesMatch(desired, remote)) {
      actions.push("update");
    }
    if (
      publish &&
      (!remote ||
        actions.includes("update") ||
        remote.status !== "published" ||
        remote.has_unpublished_versions)
    ) {
      actions.push("publish");
    }
    plans.push({ desired, ...(remote ? { remote } : {}), actions });
  }
  return plans;
}

async function pushTemplates(args: string[], dependencies: CliDependencies) {
  const manifest = await loadTemplateManifest(
    dependencies.cwd,
    flag(args, "file"),
  );
  const publish = hasFlag(args, "publish");
  const dryRun = hasFlag(args, "dry-run");
  const plans = await planTemplatePush(
    args,
    dependencies,
    manifest.templates,
    publish,
  );
  const results: Array<{
    alias: string;
    id: string | null;
    actions: TemplatePlan["actions"];
  }> = [];
  for (const plan of plans) {
    let id = plan.remote?.id;
    let versionId = plan.remote?.current_version_id;
    if (!dryRun && plan.actions.includes("create")) {
      id = idFromResponse(
        await request("/templates", args, dependencies, {
          method: "POST",
          body: JSON.stringify(templatePayload(plan.desired)),
        }),
      );
    }
    if (!dryRun && plan.actions.includes("update")) {
      id = idFromResponse(
        await request(
          templatePath(plan.remote?.id ?? plan.desired.alias),
          args,
          dependencies,
          {
            method: "PATCH",
            body: JSON.stringify(templatePayload(plan.desired)),
          },
        ),
      );
    }
    if (!dryRun && plan.actions.includes("publish")) {
      if (plan.actions.includes("create") || plan.actions.includes("update")) {
        const reviewed = parseRemoteTemplate(
          await request(templatePath(plan.desired.alias), args, dependencies),
        );
        if (!templatesMatch(plan.desired, reviewed)) {
          throw new Error(
            `Template ${plan.desired.alias} changed during reconciliation; refusing to publish it.`,
          );
        }
        id = reviewed.id;
        versionId = reviewed.current_version_id;
      }
      id = idFromResponse(
        await request(
          `${templatePath(id ?? plan.desired.alias)}/publish`,
          args,
          dependencies,
          {
            method: "POST",
            headers: {
              "x-hayasend-source": "cli",
              ...(versionId ? { "if-match": `"${versionId}"` } : {}),
            },
          },
        ),
      );
    }
    results.push({
      alias: plan.desired.alias,
      id: id ?? null,
      actions: plan.actions,
    });
  }
  const count = (action: TemplatePlan["actions"][number]) =>
    results.filter((result) => result.actions.includes(action)).length;
  dependencies.io.log(
    JSON.stringify(
      {
        ok: true,
        file: manifest.path,
        dry_run: dryRun,
        publish,
        summary: {
          created: count("create"),
          updated: count("update"),
          published: count("publish"),
          unchanged: results.filter((result) => result.actions.length === 0)
            .length,
        },
        templates: results,
      },
      null,
      2,
    ),
  );
}

async function templateCommand(args: string[], dependencies: CliDependencies) {
  const command = args[0] ?? "help";
  switch (command) {
    case "push":
      validateOptions(args, {
        values: ["file", "endpoint"],
        booleans: ["publish", "dry-run"],
      });
      await pushTemplates(args, dependencies);
      break;
    case "list": {
      validateOptions(args, {
        values: ["limit", "after", "before", "endpoint"],
      });
      if (flag(args, "after") && flag(args, "before")) {
        throw new Error("--after and --before cannot be combined.");
      }
      const parameters = new URLSearchParams();
      for (const name of ["limit", "after", "before"]) {
        const value = flag(args, name);
        if (value) {
          parameters.set(name, value);
        }
      }
      const query = parameters.size > 0 ? `?${parameters}` : "";
      dependencies.io.log(
        JSON.stringify(
          await request(`/templates${query}`, args, dependencies),
          null,
          2,
        ),
      );
      break;
    }
    case "get":
      validateOptions(args, {
        values: ["endpoint"],
        positionals: 1,
      });
      dependencies.io.log(
        JSON.stringify(
          await request(
            templatePath(positional(args, 1, "Template ID or alias")),
            args,
            dependencies,
          ),
          null,
          2,
        ),
      );
      break;
    case "publish":
      validateOptions(args, {
        values: ["version", "endpoint"],
        positionals: 1,
      });
      {
        const version = flag(args, "version");
        if (version && !/^tmplv_[a-f0-9]{32}$/.test(version)) {
          throw new Error(
            "--version must contain a HayaSend template version ID.",
          );
        }
        dependencies.io.log(
          JSON.stringify(
            await request(
              `${templatePath(
                positional(args, 1, "Template ID or alias"),
              )}/publish`,
              args,
              dependencies,
              {
                method: "POST",
                headers: {
                  "x-hayasend-source": "cli",
                  ...(version ? { "if-match": `"${version}"` } : {}),
                },
              },
            ),
            null,
            2,
          ),
        );
      }
      break;
    case "render": {
      validateOptions(args, {
        values: ["from", "subject", "endpoint"],
        repeatable: ["var"],
        positionals: 1,
      });
      const from = flag(args, "from");
      const subject = flag(args, "subject");
      dependencies.io.log(
        JSON.stringify(
          await request(
            `${templatePath(
              positional(args, 1, "Template ID or alias"),
            )}/render`,
            args,
            dependencies,
            {
              method: "POST",
              body: JSON.stringify({
                variables: parseTemplateVariables(flags(args, "var")),
                ...(from ? { from } : {}),
                ...(subject ? { subject } : {}),
              }),
            },
          ),
          null,
          2,
        ),
      );
      break;
    }
    case "versions": {
      validateOptions(args, {
        values: ["limit", "after", "endpoint"],
        positionals: 1,
      });
      const parameters = new URLSearchParams();
      for (const name of ["limit", "after"]) {
        const value = flag(args, name);
        if (value) {
          parameters.set(name, value);
        }
      }
      const query = parameters.size > 0 ? `?${parameters}` : "";
      dependencies.io.log(
        JSON.stringify(
          await request(
            `${templatePath(
              positional(args, 1, "Template ID or alias"),
            )}/versions${query}`,
            args,
            dependencies,
          ),
          null,
          2,
        ),
      );
      break;
    }
    case "inspect-version": {
      validateOptions(args, {
        values: ["endpoint"],
        positionals: 2,
      });
      const version = positional(args, 2, "Template version ID");
      if (!/^tmplv_[a-f0-9]{32}$/.test(version)) {
        throw new Error("Template version ID is invalid.");
      }
      dependencies.io.log(
        JSON.stringify(
          await request(
            `${templatePath(
              positional(args, 1, "Template ID or alias"),
            )}/versions/${encodeURIComponent(version)}`,
            args,
            dependencies,
          ),
          null,
          2,
        ),
      );
      break;
    }
    case "render-version": {
      validateOptions(args, {
        values: ["from", "subject", "endpoint"],
        repeatable: ["var"],
        positionals: 2,
      });
      const version = positional(args, 2, "Template version ID");
      if (!/^tmplv_[a-f0-9]{32}$/.test(version)) {
        throw new Error("Template version ID is invalid.");
      }
      const from = flag(args, "from");
      const subject = flag(args, "subject");
      dependencies.io.log(
        JSON.stringify(
          await request(
            `${templatePath(
              positional(args, 1, "Template ID or alias"),
            )}/versions/${encodeURIComponent(version)}/render`,
            args,
            dependencies,
            {
              method: "POST",
              body: JSON.stringify({
                variables: parseTemplateVariables(flags(args, "var")),
                ...(from ? { from } : {}),
                ...(subject ? { subject } : {}),
              }),
            },
          ),
          null,
          2,
        ),
      );
      break;
    }
    case "restore-version": {
      validateOptions(args, {
        values: ["endpoint"],
        positionals: 2,
      });
      const identifier = positional(args, 1, "Template ID or alias");
      const version = positional(args, 2, "Template version ID");
      if (!/^tmplv_[a-f0-9]{32}$/.test(version)) {
        throw new Error("Template version ID is invalid.");
      }
      const current = parseRemoteTemplate(
        await request(templatePath(identifier), args, dependencies),
      );
      dependencies.io.log(
        JSON.stringify(
          await request(
            `${templatePath(
              identifier,
            )}/versions/${encodeURIComponent(version)}/restore`,
            args,
            dependencies,
            {
              method: "POST",
              headers: {
                "if-match": `"${current.current_version_id}"`,
              },
            },
          ),
          null,
          2,
        ),
      );
      break;
    }
    default:
      throw new Error(
        `Unknown templates command: ${command}. Run hayasend help.`,
      );
  }
}

const queueDepthSchema = z.object({
  visible: z.number().int().nonnegative(),
  in_flight: z.number().int().nonnegative(),
  delayed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const runtimeCapabilityDiagnosticsSchema = z.object({
  runtime: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  adapter_version: z.string(),
  capability_version: z.string(),
  checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  document_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const deploymentCapabilityDiagnosticsSchema = z.object({
  deployment: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  adapter_version: z.string(),
  capability_version: z.string(),
  checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runtime: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  maturity: z.enum(["experimental", "beta", "production"]),
  production_ready: z.boolean(),
  document_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const recoveryDiagnosticsSchema = z.object({
  object: z.literal("recovery_diagnostics"),
  generated_at: z.iso.datetime({ offset: true }),
  outbox: z.object({
    due: z.number().int().nonnegative(),
    leased: z.number().int().nonnegative(),
    stuck_leases: z.number().int().nonnegative(),
    undispatched: z.number().int().nonnegative(),
    oldest_due_age_seconds: z.number().int().nonnegative(),
    publish_failures_total: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  queues: z.object({
    provider: z.enum(["memory", "aws-sqs", "postgresql"]),
    primary: queueDepthSchema,
    dead_letters: z.object({
      delivery: queueDepthSchema.nullable(),
      scheduler: queueDepthSchema.nullable(),
      inbound: queueDepthSchema.nullable(),
    }),
  }),
  provider_events: z.object({
    latest_received_at: z.iso.datetime({ offset: true }).nullable(),
    lag_seconds: z.number().int().nonnegative().nullable(),
  }),
  capability: z.object({
    provider: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    adapter_version: z.string(),
    capability_version: z.string(),
    checked_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    document_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  runtime_capability: runtimeCapabilityDiagnosticsSchema.optional(),
  deployment_capability: deploymentCapabilityDiagnosticsSchema.optional(),
});

type ParsedRecoveryDiagnostics = z.infer<typeof recoveryDiagnosticsSchema>;

type DoctorRecoveryDiagnostics = Omit<
  ParsedRecoveryDiagnostics,
  "capability" | "runtime_capability" | "deployment_capability"
> & {
  capability: ParsedRecoveryDiagnostics["capability"] & {
    drift: boolean | null;
  };
  runtime_capability?: NonNullable<
    ParsedRecoveryDiagnostics["runtime_capability"]
  > & {
    drift: boolean | null;
  };
  deployment_capability?: NonNullable<
    ParsedRecoveryDiagnostics["deployment_capability"]
  > & {
    drift: boolean | null;
  };
};

async function doctor(args: string[], dependencies: CliDependencies) {
  const baseUrl = endpoint(args, dependencies.env);
  const healthResponse = await dependencies.fetch(`${baseUrl}/healthz`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const health = (await readJsonResponse(healthResponse)) as {
    ok?: boolean;
    service?: string;
    version?: string;
  };
  if (
    !healthResponse.ok ||
    health.ok !== true ||
    health.service !== "hayasend"
  ) {
    throw new Error(
      "The endpoint responded, but it did not identify itself as HayaSend.",
    );
  }

  await request("/emails?limit=1", args, dependencies);
  const recoveryResponse = await dependencies.fetch(
    `${baseUrl}/diagnostics/recovery`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey(dependencies.env)}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  let recoveryCheck: "pass" | "not_authorized" | "not_supported";
  let recovery: DoctorRecoveryDiagnostics | undefined;
  if (recoveryResponse.status === 403) {
    recoveryCheck = "not_authorized";
  } else if (recoveryResponse.status === 404) {
    recoveryCheck = "not_supported";
  } else if (recoveryResponse.ok) {
    const parsed = recoveryDiagnosticsSchema.safeParse(
      await readJsonResponse(recoveryResponse),
    );
    if (!parsed.success) {
      throw new Error("HayaSend returned invalid recovery diagnostics.");
    }
    const expectedDigest = providerCapabilityDocumentDigest(
      parsed.data.capability.provider,
    );
    const expectedRuntimeDigest = parsed.data.runtime_capability
      ? runtimeCapabilityDocumentDigest(parsed.data.runtime_capability.runtime)
      : undefined;
    const expectedRuntime = parsed.data.runtime_capability
      ? runtimeCapabilityDocument(parsed.data.runtime_capability.runtime)
      : undefined;
    const expectedDeploymentDigest = parsed.data.deployment_capability
      ? deploymentCapabilityDocumentDigest(
          parsed.data.deployment_capability.deployment,
        )
      : undefined;
    const expectedDeployment = parsed.data.deployment_capability
      ? deploymentCapabilityDocument(
          parsed.data.deployment_capability.deployment,
        )
      : undefined;
    recoveryCheck = "pass";
    const {
      capability,
      runtime_capability: runtimeCapability,
      deployment_capability: deploymentCapability,
      ...recoveryDiagnostics
    } = parsed.data;
    recovery = {
      ...recoveryDiagnostics,
      capability: {
        ...capability,
        drift: expectedDigest
          ? capability.document_sha256 !== expectedDigest
          : null,
      },
      ...(runtimeCapability
        ? {
            runtime_capability: {
              ...runtimeCapability,
              drift:
                expectedRuntimeDigest && expectedRuntime
                  ? runtimeCapability.document_sha256 !==
                      expectedRuntimeDigest ||
                    runtimeCapability.adapter_version !==
                      expectedRuntime.adapter_version ||
                    runtimeCapability.capability_version !==
                      expectedRuntime.schema_version ||
                    runtimeCapability.checked_at !== expectedRuntime.checked_at
                  : null,
            },
          }
        : {}),
      ...(deploymentCapability
        ? {
            deployment_capability: {
              ...deploymentCapability,
              drift:
                expectedDeploymentDigest && expectedDeployment
                  ? deploymentCapability.document_sha256 !==
                      expectedDeploymentDigest ||
                    deploymentCapability.adapter_version !==
                      expectedDeployment.adapter_version ||
                    deploymentCapability.capability_version !==
                      expectedDeployment.schema_version ||
                    deploymentCapability.checked_at !==
                      expectedDeployment.checked_at ||
                    deploymentCapability.runtime !==
                      expectedDeployment.runtime.profile ||
                    deploymentCapability.provider !==
                      expectedDeployment.transport.provider ||
                    deploymentCapability.maturity !==
                      expectedDeployment.maturity.combination ||
                    deploymentCapability.production_ready !==
                      expectedDeployment.production_ready ||
                    deploymentCapability.runtime !==
                      runtimeCapability?.runtime ||
                    deploymentCapability.provider !== capability.provider
                  : null,
            },
          }
        : {}),
    };
  } else {
    throw new Error(
      `HayaSend recovery diagnostics failed (HTTP ${recoveryResponse.status}).`,
    );
  }
  const previewResponse = await dependencies.fetch(`${baseUrl}/preview`, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  dependencies.io.log(
    JSON.stringify(
      {
        ok: true,
        endpoint: baseUrl,
        version: health.version,
        checks: {
          health: "pass",
          identity: "pass",
          authentication: "pass",
          recovery: recoveryCheck,
          preview:
            previewResponse.status === 200 ? "available" : "not_available",
        },
        ...(recovery ? { recovery } : {}),
      },
      null,
      2,
    ),
  );
}

interface InitFile {
  name: string;
  content: string;
  mode: number;
}

async function packageVersion() {
  const packagePath = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    version?: unknown;
  };
  if (
    typeof packageJson.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)
  ) {
    throw new Error("package.json does not contain a supported version.");
  }
  return packageJson.version;
}

function initFiles(version: string): InitFile[] {
  return [
    {
      name: "compose.hayasend.yaml",
      mode: 0o644,
      content: `name: hayasend-local
services:
  hayasend:
    image: ghcr.io/haya-inc/hayasend:${version}
    ports:
      - "127.0.0.1:8787:8787"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    init: true
`,
    },
    {
      name: ".env.hayasend.example",
      mode: 0o644,
      content: `HAYASEND_BASE_URL=http://localhost:8787
HAYASEND_API_KEY=re_hayasend_dev
`,
    },
  ];
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function initProject(args: string[], dependencies: CliDependencies) {
  const target = resolve(
    dependencies.cwd,
    flag(args, "dir") ?? dependencies.cwd,
  );
  if (target === parse(target).root) {
    throw new Error("Refusing to initialize a filesystem root.");
  }
  await mkdir(target, { recursive: true });

  const files = initFiles(await packageVersion());
  const conflicts: string[] = [];
  for (const file of files) {
    if (await fileExists(resolve(target, file.name))) {
      conflicts.push(file.name);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite existing files: ${conflicts.join(", ")}`,
    );
  }

  const created: string[] = [];
  try {
    for (const file of files) {
      const path = resolve(target, file.name);
      await writeFile(path, file.content, {
        encoding: "utf8",
        flag: "wx",
        mode: file.mode,
      });
      created.push(path);
    }
  } catch (error) {
    await Promise.all(
      created.map(async (path) => {
        await unlink(path).catch(() => undefined);
      }),
    );
    throw error;
  }

  dependencies.io.log(
    JSON.stringify(
      {
        ok: true,
        directory: target,
        created: files.map((file) => file.name),
        next: [
          "Copy .env.hayasend.example into your application's local environment.",
          "Run: docker compose -f compose.hayasend.yaml up -d",
          "Open: http://localhost:8787/preview",
          "Run: hayasend doctor",
        ],
      },
      null,
      2,
    ),
  );
}

function sendContext(args: string[], dependencies: CliDependencies) {
  return {
    baseUrl: endpoint(args, dependencies.env),
    cwd: dependencies.cwd,
    fetch: dependencies.fetch,
    allowedUploadOrigins: parseAttachmentUploadOrigins(
      dependencies.env.HAYASEND_ATTACHMENT_UPLOAD_ORIGINS,
    ),
    log: dependencies.io.log,
    readStdin: dependencies.readStdin,
    request: (path: string, init?: RequestInit) =>
      request(path, args, dependencies, init),
  };
}

async function testSend(args: string[], dependencies: CliDependencies) {
  const from = flag(args, "from");
  const to = flag(args, "to");
  if (!from || !to) {
    throw new Error(
      "test requires --from and --to. This command sends a real email outside local mode.",
    );
  }
  const subject =
    flag(args, "subject") ?? `HayaSend test ${new Date().toISOString()}`;
  const created = (await request("/emails", args, dependencies, {
    method: "POST",
    headers: {
      "idempotency-key": `hayasend-cli-${randomUUID()}`,
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text: "This message confirms that the HayaSend API accepted an end-to-end CLI test.",
    }),
  })) as { id?: unknown };
  if (typeof created.id !== "string" || !created.id.startsWith("email_")) {
    throw new Error("HayaSend did not return a valid email identifier.");
  }
  const retrieved = (await request(
    `/emails/${encodeURIComponent(created.id)}`,
    args,
    dependencies,
  )) as {
    id?: unknown;
    status?: unknown;
    subject?: unknown;
  };
  if (
    retrieved.id !== created.id ||
    retrieved.subject !== subject ||
    typeof retrieved.status !== "string"
  ) {
    throw new Error("The sent email could not be verified through retrieval.");
  }

  const baseUrl = endpoint(args, dependencies.env);
  dependencies.io.log(
    JSON.stringify(
      {
        ok: true,
        endpoint: baseUrl,
        email_id: created.id,
        status: retrieved.status,
        ...(isLoopbackHostname(new URL(baseUrl).hostname)
          ? {
              preview_url: `${baseUrl}/preview?email=${encodeURIComponent(created.id)}`,
            }
          : {}),
      },
      null,
      2,
    ),
  );
}

async function deployCommand(
  args: string[],
  dependencies: CliDependencies,
  operation: "deploy" | "upgrade" = "deploy",
) {
  const target = args[0] ?? "";
  if (target === "cloudflare" && operation === "deploy") {
    validateOptions(args, {
      values: [
        "account",
        "name",
        "email-domain",
        "deployment-id",
        "confirm-account",
        "health-mode",
      ],
      booleans: ["apply"],
      repeatable: ["allowed-recipient"],
    });
    const account = flag(args, "account");
    const name = flag(args, "name");
    const healthMode = flag(args, "health-mode");
    if (!account || !name) {
      throw new Error("deploy cloudflare requires --account and --name.");
    }
    if (
      healthMode !== undefined &&
      healthMode !== "ready" &&
      healthMode !== "fail"
    ) {
      throw new Error("--health-mode must be ready or fail.");
    }
    await deployCloudflare(
      {
        account,
        name,
        ...(flag(args, "email-domain")
          ? { emailDomain: flag(args, "email-domain") }
          : {}),
        apply: hasFlag(args, "apply"),
        ...(flag(args, "deployment-id")
          ? { deploymentId: flag(args, "deployment-id") }
          : {}),
        ...(flag(args, "confirm-account")
          ? { confirmAccount: flag(args, "confirm-account") }
          : {}),
        ...(healthMode ? { healthMode } : {}),
        allowedRecipients: flags(args, "allowed-recipient"),
      },
      {
        cwd: dependencies.cwd,
        env: dependencies.env,
        log: dependencies.io.log,
        runCommand: dependencies.runCommand,
      },
    );
    return;
  }
  if (target !== "aws") {
    throw new Error(
      `Unknown ${operation} target: ${
        target || "(missing)"
      }. Run hayasend help.`,
    );
  }
  validateOptions(args, {
    values: [
      "account",
      "region",
      "stack",
      "profile",
      "cloudformation-role-arn",
      "artifact-bucket",
      "bootstrap-secret-arn",
      "api-rate-limit",
      "api-burst-limit",
      "log-retention-days",
      "inbound-retention-days",
      "inbound-max-message-bytes",
      "inbound-recipient-suffixes",
      "inbound-tls-policy",
      "webhook-retention-days",
      "template-history-retention-days",
      "template-history-limit",
      "worker-reserved-concurrency",
      "worker-maximum-concurrency",
      "inbound-reserved-concurrency",
      "deployment-preference-type",
      "backup-retention-days",
      "payload-noncurrent-version-retention-days",
    ],
    booleans: [
      "apply",
      "allow-destructive-changes",
      "enable-inbound",
      "disable-inbound",
      "enable-backups",
      "disable-backups",
      "enable-restore-testing",
      "disable-restore-testing",
    ],
    repeatable: ["tag"],
  });
  const account = flag(args, "account");
  const enableInbound = hasFlag(args, "enable-inbound");
  const disableInbound = hasFlag(args, "disable-inbound");
  if (enableInbound && disableInbound) {
    throw new Error(
      "--enable-inbound and --disable-inbound cannot be combined.",
    );
  }
  const enableBackups = hasFlag(args, "enable-backups");
  const disableBackups = hasFlag(args, "disable-backups");
  if (enableBackups && disableBackups) {
    throw new Error(
      "--enable-backups and --disable-backups cannot be combined.",
    );
  }
  const enableRestoreTesting = hasFlag(args, "enable-restore-testing");
  const disableRestoreTesting = hasFlag(args, "disable-restore-testing");
  if (enableRestoreTesting && disableRestoreTesting) {
    throw new Error(
      "--enable-restore-testing and --disable-restore-testing cannot be combined.",
    );
  }
  if (enableRestoreTesting && disableBackups) {
    throw new Error(
      "--enable-restore-testing cannot be combined with --disable-backups.",
    );
  }
  const region = flag(args, "region");
  const stack = flag(args, "stack");
  const profile = flag(args, "profile");
  const cloudformationRoleArn = flag(args, "cloudformation-role-arn");
  const artifactBucket = flag(args, "artifact-bucket");
  const bootstrapSecretArn = flag(args, "bootstrap-secret-arn");
  const apiRateLimit = flag(args, "api-rate-limit");
  const apiBurstLimit = flag(args, "api-burst-limit");
  const logRetentionDays = flag(args, "log-retention-days");
  const inboundRetentionDays = flag(args, "inbound-retention-days");
  const inboundMaxMessageBytes = flag(args, "inbound-max-message-bytes");
  const inboundRecipientSuffixes = flag(args, "inbound-recipient-suffixes");
  const inboundTlsPolicy = flag(args, "inbound-tls-policy");
  const webhookRetentionDays = flag(args, "webhook-retention-days");
  const templateHistoryRetentionDays = flag(
    args,
    "template-history-retention-days",
  );
  const templateHistoryLimit = flag(args, "template-history-limit");
  const workerReservedConcurrency = flag(args, "worker-reserved-concurrency");
  const workerMaximumConcurrency = flag(args, "worker-maximum-concurrency");
  const inboundReservedConcurrency = flag(args, "inbound-reserved-concurrency");
  const deploymentPreferenceType = flag(args, "deployment-preference-type");
  const backupRetentionDays = flag(args, "backup-retention-days");
  const payloadNoncurrentVersionRetentionDays = flag(
    args,
    "payload-noncurrent-version-retention-days",
  );
  await deployAws(
    {
      ...(account ? { account } : {}),
      ...(region ? { region } : {}),
      ...(stack ? { stack } : {}),
      ...(profile ? { profile } : {}),
      ...(cloudformationRoleArn ? { cloudformationRoleArn } : {}),
      ...(artifactBucket ? { artifactBucket } : {}),
      operation,
      apply: hasFlag(args, "apply"),
      allowDestructiveChanges: hasFlag(args, "allow-destructive-changes"),
      ...(enableInbound
        ? { enableInbound: true }
        : disableInbound
          ? { enableInbound: false }
          : {}),
      ...(bootstrapSecretArn ? { bootstrapSecretArn } : {}),
      ...(apiRateLimit ? { apiRateLimit } : {}),
      ...(apiBurstLimit ? { apiBurstLimit } : {}),
      ...(logRetentionDays ? { logRetentionDays } : {}),
      ...(inboundRetentionDays ? { inboundRetentionDays } : {}),
      ...(inboundMaxMessageBytes ? { inboundMaxMessageBytes } : {}),
      ...(inboundRecipientSuffixes ? { inboundRecipientSuffixes } : {}),
      ...(inboundTlsPolicy ? { inboundTlsPolicy } : {}),
      ...(webhookRetentionDays ? { webhookRetentionDays } : {}),
      ...(templateHistoryRetentionDays ? { templateHistoryRetentionDays } : {}),
      ...(templateHistoryLimit ? { templateHistoryLimit } : {}),
      ...(workerReservedConcurrency !== undefined
        ? { workerReservedConcurrency }
        : {}),
      ...(workerMaximumConcurrency !== undefined
        ? { workerMaximumConcurrency }
        : {}),
      ...(inboundReservedConcurrency !== undefined
        ? { inboundReservedConcurrency }
        : {}),
      ...(deploymentPreferenceType ? { deploymentPreferenceType } : {}),
      ...(enableBackups
        ? { enableBackups: true }
        : disableBackups
          ? { enableBackups: false }
          : {}),
      ...(backupRetentionDays ? { backupRetentionDays } : {}),
      ...(payloadNoncurrentVersionRetentionDays
        ? { payloadNoncurrentVersionRetentionDays }
        : {}),
      ...(enableRestoreTesting
        ? { enableRestoreTesting: true }
        : disableRestoreTesting
          ? { enableRestoreTesting: false }
          : {}),
      tags: flags(args, "tag"),
    },
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      log: dependencies.io.log,
      runCommand: dependencies.runCommand,
    },
  );
}

async function bootstrapCommand(args: string[], dependencies: CliDependencies) {
  if (args[0] !== "aws") {
    throw new Error(
      `Unknown bootstrap target: ${args[0] || "(missing)"}. Run hayasend help.`,
    );
  }
  validateOptions(args, {
    values: [
      "account",
      "region",
      "profile",
      "stack",
      "application-stack-prefix",
      "permissions-boundary-arn",
      "artifact-retention-days",
      "confirm-account",
    ],
    booleans: ["apply", "allow-destructive-changes"],
  });
  const account = flag(args, "account");
  const region = flag(args, "region");
  const profile = flag(args, "profile");
  const stack = flag(args, "stack");
  const applicationStackPrefix = flag(args, "application-stack-prefix");
  const permissionsBoundaryArn = flag(args, "permissions-boundary-arn");
  const artifactRetentionDays = flag(args, "artifact-retention-days");
  const confirmAccount = flag(args, "confirm-account");
  await bootstrapAws(
    {
      ...(account ? { account } : {}),
      ...(region ? { region } : {}),
      ...(profile ? { profile } : {}),
      ...(stack ? { stack } : {}),
      ...(applicationStackPrefix ? { applicationStackPrefix } : {}),
      ...(permissionsBoundaryArn ? { permissionsBoundaryArn } : {}),
      ...(artifactRetentionDays ? { artifactRetentionDays } : {}),
      apply: hasFlag(args, "apply"),
      allowDestructiveChanges: hasFlag(args, "allow-destructive-changes"),
      ...(confirmAccount ? { confirmAccount } : {}),
    },
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      log: dependencies.io.log,
      runCommand: dependencies.runCommand,
    },
  );
}

async function statusAwsCommand(args: string[], dependencies: CliDependencies) {
  if (args[0] !== "aws") {
    throw new Error(
      `Unknown status target: ${args[0] || "(missing)"}. Run hayasend help.`,
    );
  }
  validateOptions(args, {
    values: ["account", "region", "stack", "profile"],
    booleans: ["detect-drift"],
  });
  const account = flag(args, "account");
  const region = flag(args, "region");
  const stack = flag(args, "stack");
  const profile = flag(args, "profile");
  await statusAws(
    {
      ...(account ? { account } : {}),
      ...(region ? { region } : {}),
      ...(stack ? { stack } : {}),
      ...(profile ? { profile } : {}),
      detectDrift: hasFlag(args, "detect-drift"),
    },
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      fetch: dependencies.fetch,
      log: dependencies.io.log,
      runCommand: dependencies.runCommand,
      sleep: dependencies.sleep,
    },
  );
}

async function upgradeCommand(args: string[], dependencies: CliDependencies) {
  if (args[0] === "aws") {
    await deployCommand(args, dependencies, "upgrade");
    return;
  }
  await upgradeCloudflareCommand(args, dependencies);
}

async function cleanupCommand(args: string[], dependencies: CliDependencies) {
  if (args[0] !== "aws") {
    await cleanupCloudflareCommand(args, dependencies);
    return;
  }
  validateOptions(args, {
    values: [
      "account",
      "region",
      "stack",
      "profile",
      "cloudformation-role-arn",
      "confirm-stack",
    ],
    booleans: [
      "apply",
      "disable-termination-protection",
      "purge-failed-create-resources",
    ],
  });
  const account = flag(args, "account");
  const region = flag(args, "region");
  const stack = flag(args, "stack");
  const profile = flag(args, "profile");
  const cloudformationRoleArn = flag(args, "cloudformation-role-arn");
  const confirmStack = flag(args, "confirm-stack");
  await cleanupAws(
    {
      ...(account ? { account } : {}),
      ...(region ? { region } : {}),
      ...(stack ? { stack } : {}),
      ...(profile ? { profile } : {}),
      ...(cloudformationRoleArn ? { cloudformationRoleArn } : {}),
      apply: hasFlag(args, "apply"),
      ...(confirmStack ? { confirmStack } : {}),
      disableTerminationProtection: hasFlag(
        args,
        "disable-termination-protection",
      ),
      purgeFailedCreateResources: hasFlag(
        args,
        "purge-failed-create-resources",
      ),
    },
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      log: dependencies.io.log,
      runCommand: dependencies.runCommand,
    },
  );
}

async function upgradeCloudflareCommand(
  args: string[],
  dependencies: CliDependencies,
) {
  if (args[0] !== "cloudflare") {
    throw new Error(
      `Unknown upgrade target: ${args[0] || "(missing)"}. Run hayasend help.`,
    );
  }
  validateOptions(args, {
    values: [
      "account",
      "name",
      "email-domain",
      "database-id",
      "deployment-id",
      "confirm-account",
      "health-mode",
    ],
    booleans: ["apply"],
    repeatable: ["allowed-recipient"],
  });
  const account = flag(args, "account");
  const name = flag(args, "name");
  const databaseId = flag(args, "database-id");
  const healthMode = flag(args, "health-mode");
  if (!account || !name || !databaseId) {
    throw new Error(
      "upgrade cloudflare requires --account, --name, and --database-id.",
    );
  }
  if (
    healthMode !== undefined &&
    healthMode !== "ready" &&
    healthMode !== "fail"
  ) {
    throw new Error("--health-mode must be ready or fail.");
  }
  await deployCloudflare(
    {
      account,
      name,
      ...(flag(args, "email-domain")
        ? { emailDomain: flag(args, "email-domain") }
        : {}),
      databaseId,
      apply: hasFlag(args, "apply"),
      ...(flag(args, "deployment-id")
        ? { deploymentId: flag(args, "deployment-id") }
        : {}),
      ...(flag(args, "confirm-account")
        ? { confirmAccount: flag(args, "confirm-account") }
        : {}),
      ...(healthMode ? { healthMode } : {}),
      allowedRecipients: flags(args, "allowed-recipient"),
    },
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      log: dependencies.io.log,
      runCommand: dependencies.runCommand,
    },
  );
}

async function rollbackCloudflareCommand(
  args: string[],
  dependencies: CliDependencies,
) {
  if (args[0] !== "cloudflare") {
    throw new Error(
      `Unknown rollback target: ${args[0] || "(missing)"}. Run hayasend help.`,
    );
  }
  validateOptions(args, {
    values: ["account", "name", "version-id", "confirm-account"],
    booleans: ["apply"],
  });
  const account = flag(args, "account");
  const name = flag(args, "name");
  const versionId = flag(args, "version-id");
  if (!account || !name || !versionId) {
    throw new Error(
      "rollback cloudflare requires --account, --name, and --version-id.",
    );
  }
  await rollbackCloudflare(
    {
      account,
      name,
      versionId,
      apply: hasFlag(args, "apply"),
      ...(flag(args, "confirm-account")
        ? { confirmAccount: flag(args, "confirm-account") }
        : {}),
    },
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      log: dependencies.io.log,
      runCommand: dependencies.runCommand,
    },
  );
}

async function cleanupCloudflareCommand(
  args: string[],
  dependencies: CliDependencies,
) {
  if (args[0] !== "cloudflare") {
    throw new Error(
      `Unknown cleanup target: ${args[0] || "(missing)"}. Run hayasend help.`,
    );
  }
  validateOptions(args, {
    values: ["account", "name", "confirm-account"],
    booleans: ["apply"],
  });
  const account = flag(args, "account");
  const name = flag(args, "name");
  if (!account || !name) {
    throw new Error("cleanup cloudflare requires --account and --name.");
  }
  await cleanupCloudflare(
    {
      account,
      name,
      apply: hasFlag(args, "apply"),
      ...(flag(args, "confirm-account")
        ? { confirmAccount: flag(args, "confirm-account") }
        : {}),
    },
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      log: dependencies.io.log,
      runCommand: dependencies.runCommand,
    },
  );
}

async function doctorCloudflareCommand(
  args: string[],
  dependencies: CliDependencies,
) {
  validateOptions(args, {
    values: ["endpoint", "deployment-id"],
  });
  const endpoint = flag(args, "endpoint");
  if (!endpoint) {
    throw new Error("doctor cloudflare requires --endpoint.");
  }
  await doctorCloudflare(
    {
      endpoint,
      ...(flag(args, "deployment-id")
        ? { deploymentId: flag(args, "deployment-id") }
        : {}),
    },
    {
      env: dependencies.env,
      fetch: dependencies.fetch,
      log: dependencies.io.log,
    },
  );
}

async function doctorCloudflareEventsCommand(
  args: string[],
  dependencies: CliDependencies,
) {
  validateOptions(args, {
    values: ["account", "name", "email-domain"],
  });
  const account = flag(args, "account");
  const name = flag(args, "name");
  const emailDomain = flag(args, "email-domain");
  if (!account || !name || !emailDomain) {
    throw new Error(
      "doctor cloudflare-events requires --account, --name, and --email-domain.",
    );
  }
  await doctorCloudflareEmailEvents(
    { account, name, emailDomain },
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      log: dependencies.io.log,
      runCommand: dependencies.runCommand,
    },
  );
}

function help(dependencies: CliDependencies) {
  dependencies.io.log(`HayaSend CLI

Commands:
  version, --version, -v
      Print the exact HayaSend package version.

  init [--dir DIRECTORY]
      Create a pinned, hardened local Compose setup without overwriting files.

  dev
      Start HayaSend in local mode.

  deploy aws [--account ACCOUNT_ID] [--region REGION] [--stack NAME]
      Validate tools, identity, SES readiness, the SAM template, and a local
      build without changing AWS. Add --apply to create, inspect, and execute
      an exact CloudFormation change set. Destructive changes require the
      additional --allow-destructive-changes acknowledgement. The first apply
      creates live Lambda aliases; the next upgrade enables alarm-driven
      canary traffic shifting and automatic rollback.

  bootstrap aws [--account ACCOUNT_ID] [--region REGION]
      Validate and plan a one-time CloudFormation deployment bootstrap.
      Add --apply and the exact --confirm-account value to create a dedicated
      artifact bucket, CloudFormation service role, and scoped operator policy.
      An optional --permissions-boundary-arn limits the service role further.

  status aws [--account ACCOUNT_ID] [--region REGION] [--stack NAME]
      Show the stack, SES readiness, CloudFormation resources, CloudWatch
      alarms, public health, dashboard link, and exact next commands.
      Add --detect-drift to run and await a fresh CloudFormation drift check.

  upgrade aws [--account ACCOUNT_ID] [--region REGION] [--stack NAME]
      Plan or safely apply an update to an existing HayaSend stack. The same
      inspected change-set and destructive-change protections as deploy apply.

  cleanup aws [--account ACCOUNT_ID] [--region REGION] [--stack NAME]
      Plan deletion and list data resources retained by CloudFormation.
      Applying requires --apply and the exact --confirm-stack value. Protected
      stacks also require --disable-termination-protection.
      Add --purge-failed-create-resources to also remove the resources a
      failed initial creation retained. It is accepted only for a stack in
      ROLLBACK_COMPLETE, and each resource is verified empty before deletion.

  migration resend inventory --file FILE
      Validate a versioned, workload-specific inventory and report unsupported
      transports, unreviewed account state, send fields, webhooks, scheduling,
      marketing, and proof requirements.

  migration resend canary --comparison-id ID --from ADDRESS --to-file FILE
      Plan a synthetic dual-provider comparison without sending. Add --apply
      plus both printed origin/recipient confirmations to send once through
      HayaSend and once through Resend, then compare terminal lifecycle events.
      Keys are read only from HAYASEND_API_KEY and RESEND_API_KEY.

  migration resend report --inventory FILE --evidence FILE
      Produce a fail-closed GO or NO_GO decision. GO requires feature parity,
      reconciled state, per-stream canary and mailbox evidence, rehearsed Resend
      rollback, SES production access, and the 14-day/1000-message dogfood gate.

  deploy cloudflare --account ACCOUNT_ID --name NAME --email-domain DOMAIN
      Print a pinned, plan-first disposable Cloudflare deployment. Add --apply
      and the exact --confirm-account value to create D1, R2, Queues, apply
      migrations, and deploy one version. Requires CLOUDFLARE_API_TOKEN and
      HAYASEND_CLOUDFLARE_API_KEY only when applying.
      Repeat --allowed-recipient to constrain the Email Sending binding; at
      least one controlled, Cloudflare-verified address is required for apply.

  upgrade cloudflare --account ACCOUNT_ID --name NAME --database-id ID --email-domain DOMAIN
      Apply additive migrations and deploy a new tagged Worker version without
      recreating durable resources. Plan-only unless --apply and the exact
      --confirm-account value are provided.
      Repeat the reviewed --allowed-recipient values for the new version.

  rollback cloudflare --account ACCOUNT_ID --name NAME --version-id ID
      Plan or apply a 100% rollback to an explicit Worker version.

  cleanup cloudflare --account ACCOUNT_ID --name NAME
      Plan or explicitly delete only the deterministic HayaSend resources,
      including referenced private R2 payloads before deleting the bucket.

  doctor cloudflare --endpoint URL [--deployment-id ID]
      Verify health, capability digests, Beta truth, deployment identity, and
      the authenticated email API when HAYASEND_CLOUDFLARE_API_KEY is set.

  doctor cloudflare-events --account ACCOUNT_ID --name NAME --email-domain DOMAIN
      Fail unless exactly one enabled per-domain Email Sending subscription
      covers all six documented terminal/deferred lifecycle events.

  doctor [--endpoint URL]
      Check HayaSend identity, health, authentication, and preview availability.
      Read the key from HAYASEND_API_KEY.

  test --from ADDRESS --to ADDRESS [--subject TEXT] [--endpoint URL]
      Send and retrieve an end-to-end test message. This sends real email when
      the endpoint is not local.

  emails send --from ADDRESS --to ADDRESS --subject TEXT
      Send text, HTML, files, hosted templates, scheduled messages, and local
      attachments. The root-level send command remains an alias.

  emails send --to ADDRESS --template ID [--var KEY=VALUE] [--from ADDRESS]
      Send a published hosted template. Repeat recipient and variable options.
      Body: --text TEXT, --text-file FILE, --html HTML, --html-file FILE
      Envelope: --cc ADDRESS, --bcc ADDRESS, --reply-to ADDRESS
      Metadata: --header NAME=VALUE, --tag NAME=VALUE, --scheduled-at TIME
      Safety: --idempotency-key KEY, --attachment FILE

  domains create --name DOMAIN [--endpoint URL]
  domains list [--limit NUMBER] [--after DOMAIN_ID] [--endpoint URL]
  domains get DOMAIN_ID [--endpoint URL]
  domains verify DOMAIN_ID [--endpoint URL]
  domains delete DOMAIN_ID --yes [--endpoint URL]
      Register and inspect sending-domain DNS records. Verification only
      refreshes provider state; HayaSend never changes DNS.

  emails list [--limit NUMBER] [--after ID] [--endpoint URL]
  emails get ID [--include-content] [--endpoint URL]
  emails recipients ID [--limit NUMBER] [--after RECIPIENT_ID] [--endpoint URL]
      Inspect sent-email lifecycle state. Output is metadata-only unless
      --include-content explicitly exposes recipients, subject, and bodies.
      Recipient diagnostics use opaque IDs and never print addresses or content.

  emails cancel ID --yes [--endpoint URL]
  emails update ID --scheduled-at TIME --yes [--endpoint URL]
      Cancel or reschedule a queued email after explicit confirmation.

  templates push [--file FILE] [--dry-run] [--publish] [--endpoint URL]
      Reconcile hayasend.templates.json. Changes remain drafts unless
      --publish is explicitly provided.

  templates list [--limit NUMBER] [--after ID | --before ID] [--endpoint URL]
  templates get ID_OR_ALIAS [--endpoint URL]
  templates render ID_OR_ALIAS [--var KEY=VALUE] [--from ADDRESS] [--subject TEXT]
  templates publish ID_OR_ALIAS [--version VERSION_ID] [--endpoint URL]
      Inspect, render a draft without sending, or explicitly publish templates.

  templates versions ID_OR_ALIAS [--limit NUMBER] [--after VERSION_ID]
  templates inspect-version ID_OR_ALIAS VERSION_ID
  templates render-version ID_OR_ALIAS VERSION_ID [--var KEY=VALUE]
  templates restore-version ID_OR_ALIAS VERSION_ID
      Inspect immutable publication history, render it without sending, or
      restore one version into a new unpublished draft.

  keys create --name NAME --scope SCOPE --token-out FILE
  keys list [--limit NUMBER] [--after CURSOR]
  keys get KEY_ID
  keys revoke KEY_ID
      Create, inspect, or revoke least-privilege API keys. Created tokens are
      written once to a new mode-0600 file and are never printed.

  webhooks create --url URL --event EVENT --secret-file FILE
      Register a webhook and save its one-time signing secret to a new
      permission-0600 file without printing the secret.

  webhooks list [--limit NUMBER] [--after ID]
  webhooks get ID
  webhooks update ID [--url URL] [--event EVENT] [--status enabled|disabled]
  webhooks delete ID --yes
      Inspect and manage webhook endpoints. Repeat --event to subscribe to
      multiple events.

  webhooks deliveries ID [--limit NUMBER] [--after DELIVERY_ID]
  webhooks inspect-delivery ID DELIVERY_ID
  webhooks replay ID DELIVERY_ID --yes
      Inspect retained delivery attempts or explicitly queue a replay.

  suppressions add EMAIL [--detail-file FILE] [--endpoint URL]
  suppressions add --email-file FILE [--detail-file FILE] [--endpoint URL]
      Add a manual suppression. File inputs keep recipient data and controlled
      audit context out of the process list.

  suppressions list [--limit NUMBER] [--after ID] [--endpoint URL]
  suppressions get EMAIL [--endpoint URL]
  suppressions get --email-file FILE [--endpoint URL]
  suppressions delete EMAIL --yes [--endpoint URL]
  suppressions delete --email-file FILE --yes [--endpoint URL]
      Inspect suppression records or explicitly remove one. JSON output
      contains recipient data and must be handled as sensitive.

Environment:
  HAYASEND_BASE_URL    Defaults to http://localhost:8787
  HAYASEND_API_KEY     Defaults to re_hayasend_dev for local mode
  RESEND_API_KEY       Required only by migration resend canary --apply
  HAYASEND_ATTACHMENT_UPLOAD_ORIGINS
                       Comma-separated HTTPS origins for custom S3-compatible
                       direct attachment uploads
  HAYASEND_AWS_ACCOUNT_ID
                       Expected 12-digit AWS account for AWS lifecycle commands
  HAYASEND_AWS_CLOUDFORMATION_ROLE_ARN
                       Exact service role preserved for deploy/upgrade/cleanup
  HAYASEND_AWS_ARTIFACT_BUCKET
                       Dedicated SAM artifact bucket from bootstrap aws
  AWS_REGION            Default Region for AWS lifecycle commands
`);
}

export async function runCli(
  args: string[],
  overrides: Partial<CliDependencies> = {},
) {
  const dependencies: CliDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  const command = args[0] ?? "help";
  if (
    args.length === 1 &&
    (command === "--version" || command === "-v" || command === "version")
  ) {
    dependencies.io.log(HAYASEND_VERSION);
    return;
  }
  if (hasFlag(args, "help") || command === "help") {
    help(dependencies);
    return;
  }
  switch (command) {
    case "init":
      validateOptions(args, { values: ["dir"] });
      await initProject(args, dependencies);
      break;
    case "dev":
      validateOptions(args, {});
      await runServerProcess();
      break;
    case "deploy":
      await deployCommand(args.slice(1), dependencies);
      break;
    case "bootstrap":
      await bootstrapCommand(args.slice(1), dependencies);
      break;
    case "status":
      await statusAwsCommand(args.slice(1), dependencies);
      break;
    case "upgrade":
      await upgradeCommand(args.slice(1), dependencies);
      break;
    case "rollback":
      await rollbackCloudflareCommand(args.slice(1), dependencies);
      break;
    case "cleanup":
      await cleanupCommand(args.slice(1), dependencies);
      break;
    case "migration":
      await resendMigrationCommand(args.slice(1), {
        cwd: dependencies.cwd,
        env: dependencies.env,
        fetch: dependencies.fetch,
        log: dependencies.io.log,
        sleep: dependencies.sleep,
      });
      break;
    case "doctor":
      if (args[1] === "cloudflare") {
        await doctorCloudflareCommand(args.slice(1), dependencies);
      } else if (args[1] === "cloudflare-events") {
        await doctorCloudflareEventsCommand(args.slice(1), dependencies);
      } else {
        validateOptions(args, { values: ["endpoint"] });
        await doctor(args, dependencies);
      }
      break;
    case "test":
      validateOptions(args, {
        values: ["from", "to", "subject", "endpoint"],
      });
      await testSend(args, dependencies);
      break;
    case "send":
      await sendEmail(args, sendContext(args, dependencies));
      break;
    case "domains":
      await domainCommand(args.slice(1), {
        request: (path, init) =>
          request(path, args.slice(1), dependencies, init),
        log: dependencies.io.log,
      });
      break;
    case "emails": {
      const emailArgs = args.slice(1);
      await emailCommand(emailArgs, sendContext(emailArgs, dependencies));
      break;
    }
    case "templates":
      await templateCommand(args.slice(1), dependencies);
      break;
    case "keys":
      await apiKeyCommand(args.slice(1), dependencies);
      break;
    case "webhooks":
      await webhookCommand(args.slice(1), {
        cwd: dependencies.cwd,
        log: dependencies.io.log,
        request: (path, init) => request(path, args, dependencies, init),
      });
      break;
    case "suppressions":
      await suppressionCommand(args.slice(1), {
        cwd: dependencies.cwd,
        log: dependencies.io.log,
        request: (path, init) => request(path, args, dependencies, init),
      });
      break;
    default:
      throw new Error(`Unknown command: ${command}. Run hayasend help.`);
  }
}

export function isMainModule(
  entrypoint: string | undefined,
  moduleUrl: string,
) {
  if (!entrypoint) {
    return false;
  }
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    defaultDependencies.io.error(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}
