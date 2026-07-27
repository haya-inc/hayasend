import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  CommandResult,
  CommandRunner,
} from "./cli-aws-deploy.js";
import { CLOUDFLARE_WORKER_CAPABILITY } from "./cloudflare-worker-capability.js";

const COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEPLOY_TIMEOUT_MS = 15 * 60_000;
const COMPATIBILITY_DATE = "2026-07-27";
const PACKAGED_WORKER_ENTRY = fileURLToPath(
  new URL("../src/workers/index.ts", import.meta.url),
);
const PACKAGED_MIGRATIONS = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version?: unknown;
  devDependencies?: Record<string, unknown>;
};
const WRANGLER_VERSION =
  typeof packageMetadata.devDependencies?.wrangler === "string"
    ? packageMetadata.devDependencies.wrangler
    : undefined;
const HAYASEND_VERSION =
  typeof packageMetadata.version === "string"
    ? packageMetadata.version
    : undefined;

if (!WRANGLER_VERSION || !HAYASEND_VERSION) {
  throw new Error(
    "HayaSend package metadata is missing pinned Cloudflare tooling.",
  );
}

export interface CloudflareResourceNames {
  worker: string;
  database: string;
  bucket: string;
  primary_queue: string;
  dead_letter_queue: string;
  email_events_queue: string;
}

export interface CloudflareDeployOptions {
  account: string;
  name: string;
  deploymentId?: string | undefined;
  databaseId?: string | undefined;
  apply: boolean;
  confirmAccount?: string | undefined;
  healthMode?: "ready" | "fail" | undefined;
  allowedRecipients?: string[] | undefined;
}

export interface CloudflareRollbackOptions {
  account: string;
  name: string;
  versionId: string;
  apply: boolean;
  confirmAccount?: string | undefined;
}

export interface CloudflareCleanupOptions {
  account: string;
  name: string;
  apply: boolean;
  confirmAccount?: string | undefined;
}

export interface CloudflareDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  runCommand: CommandRunner;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
}

interface WranglerEvent {
  type?: unknown;
  worker_name?: unknown;
  version_id?: unknown;
  deployment_id?: unknown;
  version_traffic?: unknown;
  targets?: unknown;
  timestamp?: unknown;
}

interface D1DatabaseDescription {
  name?: unknown;
  uuid?: unknown;
  id?: unknown;
}

const allowedRecipientSchema = z.email().max(320);

function validateAccount(account: string): string {
  if (!/^[a-f0-9]{32}$/.test(account)) {
    throw new Error(
      "Cloudflare account ID must contain exactly 32 lowercase hexadecimal characters.",
    );
  }
  return account;
}

function validateName(name: string): string {
  if (
    name.length < 1 ||
    name.length > 30 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
  ) {
    throw new Error(
      "Cloudflare deployment name must be 1-30 lowercase letters, digits, or internal hyphens.",
    );
  }
  return name;
}

function validateVersionId(versionId: string): string {
  if (!/^[a-f0-9-]{16,128}$/.test(versionId)) {
    throw new Error("Cloudflare Worker version ID is invalid.");
  }
  return versionId;
}

function validateAllowedRecipients(
  values: string[] | undefined,
): string[] {
  const recipients = [...new Set(values ?? [])];
  if (recipients.length > 50) {
    throw new Error(
      "Cloudflare recipient allowlist cannot exceed 50 addresses.",
    );
  }
  for (const recipient of recipients) {
    if (!allowedRecipientSchema.safeParse(recipient).success) {
      throw new Error("Cloudflare allowed recipient is invalid.");
    }
  }
  return recipients;
}

export function cloudflareResourceNames(
  name: string,
): CloudflareResourceNames {
  const prefix = `hayasend-${validateName(name)}`;
  return {
    worker: prefix,
    database: `${prefix}-d1`,
    bucket: `${prefix}-payloads`,
    primary_queue: `${prefix}-jobs`,
    dead_letter_queue: `${prefix}-jobs-dlq`,
    email_events_queue: `${prefix}-email-events`,
  };
}

function cloudflarePlan(
  options: CloudflareDeployOptions,
  mode: "deploy" | "upgrade",
) {
  const names = cloudflareResourceNames(options.name);
  const allowedRecipients = validateAllowedRecipients(
    options.allowedRecipients,
  );
  return {
    object: "cloudflare_deployment_plan",
    schema_version: "1.0.0",
    mode,
    account: validateAccount(options.account),
    deployment_id:
      options.deploymentId ?? "generated-only-when-applied",
    toolchain: {
      node: process.version,
      npm: process.env.npm_config_user_agent?.split(" ")[0] ?? null,
      wrangler: WRANGLER_VERSION,
      compatibility_date: COMPATIBILITY_DATE,
      hayasend: HAYASEND_VERSION,
    },
    capability_digest:
      CLOUDFLARE_WORKER_CAPABILITY.capability_digest,
    provider_capability_digest:
      CLOUDFLARE_WORKER_CAPABILITY.provider_capability_digest,
    production_ready: false,
    provider_maturity: "beta",
    recipient_policy: {
      mode: "allowlist",
      count: allowedRecipients.length,
      apply_requires_at_least_one: true,
    },
    resources: names,
    mutations:
      mode === "deploy"
        ? [
            `create D1 database ${names.database}`,
            `create R2 bucket ${names.bucket}`,
            `create Queues ${names.primary_queue}, ${names.dead_letter_queue}, ${names.email_events_queue}`,
            "apply additive D1 migrations with a pre-migration backup",
            `upload and deploy one tagged Worker version ${names.worker}`,
          ]
        : [
            "apply additive D1 migrations with a pre-migration backup",
            `upload and deploy one tagged Worker version ${names.worker}`,
          ],
    secret_sources: {
      cloudflare_api_token: "CLOUDFLARE_API_TOKEN",
      hayasend_api_key: "HAYASEND_CLOUDFLARE_API_KEY",
    },
    apply_requires: [
      "--apply",
      `--confirm-account ${options.account}`,
      "at least one --allowed-recipient",
      "an approved non-production account and an isolated disposable namespace",
    ],
  };
}

export function buildCloudflareWranglerConfig(input: {
  names: CloudflareResourceNames;
  databaseId: string;
  deploymentId: string;
  healthMode: "ready" | "fail";
  allowedRecipients: string[];
}) {
  const allowedRecipients = validateAllowedRecipients(
    input.allowedRecipients,
  );
  if (allowedRecipients.length === 0) {
    throw new Error(
      "Cloudflare deployment requires at least one allowed recipient.",
    );
  }
  return {
    name: input.names.worker,
    main: PACKAGED_WORKER_ENTRY,
    compatibility_date: COMPATIBILITY_DATE,
    workers_dev: true,
    observability: { enabled: true },
    vars: {
      HAYASEND_DEPLOYMENT_ID: input.deploymentId,
      HAYASEND_PROVIDER: "cloudflare-email",
      HAYASEND_HEALTH_MODE: input.healthMode,
      PRIMARY_QUEUE_NAME: input.names.primary_queue,
      DLQ_QUEUE_NAME: input.names.dead_letter_queue,
      EMAIL_EVENTS_QUEUE_NAME: input.names.email_events_queue,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: input.names.database,
        database_id: input.databaseId,
        migrations_dir: PACKAGED_MIGRATIONS,
      },
    ],
    r2_buckets: [
      {
        binding: "PAYLOADS",
        bucket_name: input.names.bucket,
      },
    ],
    queues: {
      producers: [
        {
          binding: "PRIMARY_QUEUE",
          queue: input.names.primary_queue,
        },
      ],
      consumers: [
        {
          queue: input.names.primary_queue,
          dead_letter_queue: input.names.dead_letter_queue,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 3,
          retry_delay: 30,
        },
        {
          queue: input.names.dead_letter_queue,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 3,
        },
        {
          queue: input.names.email_events_queue,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 10,
          retry_delay: 30,
        },
      ],
    },
    send_email: [
      {
        name: "EMAIL",
        allowed_destination_addresses: allowedRecipients,
      },
    ],
    triggers: { crons: ["*/5 * * * *"] },
  };
}

export function redactCloudflareDiagnostics(value: string): string {
  return value
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/giu,
      "$1[REDACTED]",
    )
    .replace(/\b(?:re|whsec)_[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_SECRET]")
    .replace(
      /(cloudflare_api_token|hayasend_cloudflare_api_key)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    )
    .slice(0, 4_000);
}

async function wrangler(
  dependencies: CloudflareDependencies,
  account: string,
  args: string[],
  outputPath?: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const token = dependencies.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN is required for Cloudflare mutations.",
    );
  }
  if (outputPath) {
    await writeFile(outputPath, "", { mode: 0o600 });
  }
  const {
    HAYASEND_CLOUDFLARE_API_KEY: _runtimeApiKey,
    ...commandEnvironment
  } = dependencies.env;
  const result = await dependencies.runCommand(
    "npx",
    ["--yes", `wrangler@${WRANGLER_VERSION}`, ...args],
    {
      cwd: dependencies.cwd,
      timeoutMs,
      env: {
        ...commandEnvironment,
        CI: "true",
        FORCE_COLOR: "0",
        WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_ACCOUNT_ID: account,
        CLOUDFLARE_API_TOKEN: token,
        ...(outputPath
          ? { WRANGLER_OUTPUT_FILE_PATH: outputPath }
          : {}),
      },
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Wrangler failed: ${redactCloudflareDiagnostics(result.stderr || result.stdout)}`,
    );
  }
  return result;
}

async function wranglerEvents(path: string): Promise<WranglerEvent[]> {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WranglerEvent);
}

function uploadedVersion(events: WranglerEvent[]): {
  versionId: string;
  targets: string[];
} {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.type === "version-upload");
  if (typeof event?.version_id !== "string") {
    throw new Error(
      "Wrangler did not record the uploaded Worker version ID.",
    );
  }
  return {
    versionId: event.version_id,
    targets: Array.isArray(event.targets)
      ? event.targets.filter(
          (target): target is string => typeof target === "string",
        )
      : [],
  };
}

function initialDeployment(
  events: WranglerEvent[],
  expectedWorker: string,
): {
  versionId: string;
  targets: string[];
} {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.type === "deploy");
  if (
    !event ||
    event.worker_name !== expectedWorker ||
    typeof event.version_id !== "string"
  ) {
    throw new Error(
      "Wrangler did not record the initial Worker deployment.",
    );
  }
  return {
    versionId: event.version_id,
    targets: Array.isArray(event.targets)
      ? event.targets.filter(
          (target): target is string => typeof target === "string",
        )
      : [],
  };
}

function deployedVersion(
  events: WranglerEvent[],
  expectedWorker: string,
): { deploymentId?: string | undefined } {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.type === "version-deploy");
  if (!event || event.worker_name !== expectedWorker) {
    throw new Error(
      "Wrangler did not record the Worker version deployment.",
    );
  }
  return {
    ...(typeof event.deployment_id === "string"
      ? { deploymentId: event.deployment_id }
      : {}),
  };
}

function d1DatabaseId(stdout: string, databaseName: string): string {
  const parsed = JSON.parse(stdout) as D1DatabaseDescription[];
  const matches = parsed.filter(
    (database) => database.name === databaseName,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one D1 database named ${databaseName}.`,
    );
  }
  const value = matches[0]?.uuid ?? matches[0]?.id;
  if (
    typeof value !== "string" ||
    !/^[a-f0-9-]{16,128}$/.test(value)
  ) {
    throw new Error("Wrangler returned an invalid D1 database ID.");
  }
  return value;
}

function requireMutationConfirmation(
  account: string,
  confirmAccount: string | undefined,
): void {
  if (confirmAccount !== account) {
    throw new Error(
      `Cloudflare mutation requires --confirm-account ${account}.`,
    );
  }
}

export async function deployCloudflare(
  options: CloudflareDeployOptions,
  dependencies: CloudflareDependencies,
): Promise<void> {
  const mode = options.databaseId ? "upgrade" : "deploy";
  const plan = cloudflarePlan(options, mode);
  dependencies.log(JSON.stringify(plan, null, 2));
  if (!options.apply) {
    return;
  }
  requireMutationConfirmation(options.account, options.confirmAccount);
  const allowedRecipients = validateAllowedRecipients(
    options.allowedRecipients,
  );
  if (allowedRecipients.length === 0) {
    throw new Error(
      "Cloudflare deployment requires at least one --allowed-recipient.",
    );
  }
  const apiKey = dependencies.env.HAYASEND_CLOUDFLARE_API_KEY;
  if (!apiKey || !/^re_[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
    throw new Error(
      "HAYASEND_CLOUDFLARE_API_KEY must contain a strong re_ prefixed key.",
    );
  }
  const names = cloudflareResourceNames(options.name);
  const deploymentId =
    options.deploymentId ?? `cf-${randomUUID()}`;
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(deploymentId)) {
    throw new Error(
      "Cloudflare deployment ID must be an opaque 8-128 character identifier.",
    );
  }
  const temporary = await mkdtemp(
    join(tmpdir(), "hayasend-cloudflare-"),
  );
  try {
    let databaseId = options.databaseId;
    if (!databaseId) {
      await wrangler(dependencies, options.account, [
        "d1",
        "create",
        names.database,
        "--location",
        "apac",
      ]);
      const listed = await wrangler(dependencies, options.account, [
        "d1",
        "list",
        "--json",
      ]);
      databaseId = d1DatabaseId(listed.stdout, names.database);
      await wrangler(dependencies, options.account, [
        "r2",
        "bucket",
        "create",
        names.bucket,
        "--location",
        "apac",
      ]);
      for (const queue of [
        names.primary_queue,
        names.dead_letter_queue,
        names.email_events_queue,
      ]) {
        await wrangler(dependencies, options.account, [
          "queues",
          "create",
          queue,
          "--message-retention-period-secs",
          "86400",
        ]);
      }
    }
    if (!/^[a-f0-9-]{16,128}$/.test(databaseId)) {
      throw new Error("Cloudflare D1 database ID is invalid.");
    }
    const configPath = join(temporary, "wrangler.json");
    const secretPath = join(temporary, "secrets.json");
    const outputPath = join(temporary, "wrangler-output.jsonl");
    await writeFile(
      configPath,
      `${JSON.stringify(
        buildCloudflareWranglerConfig({
          names,
          databaseId,
          deploymentId,
          healthMode: options.healthMode ?? "ready",
          allowedRecipients,
        }),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      secretPath,
      `${JSON.stringify({ HAYASEND_API_KEY: apiKey })}\n`,
      { mode: 0o600 },
    );
    await chmod(secretPath, 0o600);
    await wrangler(
      dependencies,
      options.account,
      [
        "d1",
        "migrations",
        "apply",
        names.database,
        "--remote",
        "--config",
        configPath,
      ],
      undefined,
      DEPLOY_TIMEOUT_MS,
    );
    let uploaded: { versionId: string; targets: string[] };
    let deployed: { deploymentId?: string | undefined } = {};
    if (mode === "deploy") {
      await wrangler(
        dependencies,
        options.account,
        [
          "deploy",
          PACKAGED_WORKER_ENTRY,
          "--config",
          configPath,
          "--tag",
          deploymentId,
          "--message",
          `HayaSend ${HAYASEND_VERSION} ${deploymentId}`,
          "--secrets-file",
          secretPath,
          "--strict",
          "--minify",
          "--upload-source-maps",
        ],
        outputPath,
        DEPLOY_TIMEOUT_MS,
      );
      uploaded = initialDeployment(
        await wranglerEvents(outputPath),
        names.worker,
      );
    } else {
      await wrangler(
        dependencies,
        options.account,
        [
          "versions",
          "upload",
          PACKAGED_WORKER_ENTRY,
          "--config",
          configPath,
          "--tag",
          deploymentId,
          "--message",
          `HayaSend ${HAYASEND_VERSION} ${deploymentId}`,
          "--secrets-file",
          secretPath,
          "--strict",
          "--minify",
          "--upload-source-maps",
        ],
        outputPath,
        DEPLOY_TIMEOUT_MS,
      );
      uploaded = uploadedVersion(await wranglerEvents(outputPath));
      const deployArguments = [
        "versions",
        "deploy",
        "--name",
        names.worker,
        "--version-id",
        uploaded.versionId,
        "--percentage",
        "100",
        "--message",
        `HayaSend ${deploymentId}`,
        "--config",
        configPath,
        "--yes",
      ];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await wrangler(
            dependencies,
            options.account,
            deployArguments,
            outputPath,
            DEPLOY_TIMEOUT_MS,
          );
          break;
        } catch (error) {
          const versionStillPropagating =
            error instanceof Error &&
            error.message.includes("[code: 10013]");
          if (!versionStillPropagating || attempt === 9) {
            throw error;
          }
          dependencies.log(
            `Cloudflare version ${uploaded.versionId} is still propagating; retrying deployment.`,
          );
          await (dependencies.sleep ??
            ((milliseconds) =>
              new Promise((resolve) =>
                setTimeout(resolve, milliseconds),
              )))(1_000);
        }
      }
      const deployedEvents = await wranglerEvents(outputPath);
      deployed = deployedVersion(deployedEvents, names.worker);
    }
    dependencies.log(
      JSON.stringify(
        {
          object: "cloudflare_deployment_result",
          account: options.account,
          deployment_id: deploymentId,
          version_id: uploaded.versionId,
          targets: uploaded.targets,
          ...(deployed.deploymentId
            ? {
                cloudflare_deployment_id:
                  deployed.deploymentId,
              }
            : {}),
          database_id: databaseId,
          resources: names,
          capability_digest:
            CLOUDFLARE_WORKER_CAPABILITY.capability_digest,
          production_ready: false,
          provider_maturity: "beta",
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function rollbackCloudflare(
  options: CloudflareRollbackOptions,
  dependencies: CloudflareDependencies,
): Promise<void> {
  const account = validateAccount(options.account);
  const names = cloudflareResourceNames(options.name);
  const versionId = validateVersionId(options.versionId);
  dependencies.log(
    JSON.stringify(
      {
        object: "cloudflare_rollback_plan",
        account,
        worker: names.worker,
        target_version_id: versionId,
        mutation: `route 100% traffic to ${versionId}`,
      },
      null,
      2,
    ),
  );
  if (!options.apply) {
    return;
  }
  requireMutationConfirmation(account, options.confirmAccount);
  await wrangler(
    dependencies,
    account,
    [
      "rollback",
      versionId,
      "--name",
      names.worker,
      "--message",
      "HayaSend controlled rollback",
      "--yes",
    ],
    undefined,
    DEPLOY_TIMEOUT_MS,
  );
  dependencies.log(
    JSON.stringify({
      object: "cloudflare_rollback_result",
      account,
      worker: names.worker,
      version_id: versionId,
    }),
  );
}

function payloadKeysFromD1(stdout: string): string[] {
  const value = JSON.parse(stdout) as Array<{
    results?: Array<{ object_key?: unknown }>;
  }>;
  return value
    .flatMap((item) => item.results ?? [])
    .map((row) => row.object_key)
    .filter(
      (key): key is string =>
        typeof key === "string" &&
        /^emails\/email_[a-f0-9]{32}\/[a-f0-9-]{16,128}\.json$/.test(
          key,
        ),
    );
}

async function bestEffortWrangler(
  dependencies: CloudflareDependencies,
  account: string,
  args: string[],
  acceptableMissingCodes: number[] = [],
  acceptableMissingPatterns: RegExp[] = [],
): Promise<{ ok: boolean; diagnostic?: string }> {
  try {
    await wrangler(dependencies, account, args);
    return { ok: true };
  } catch (error) {
    const diagnostic = redactCloudflareDiagnostics(String(error));
    const acceptedCode = acceptableMissingCodes.find((code) =>
      diagnostic.includes(`[code: ${code}]`),
    );
    const acceptedPattern = acceptableMissingPatterns.find((pattern) =>
      pattern.test(diagnostic),
    );
    if (acceptedCode !== undefined || acceptedPattern !== undefined) {
      return {
        ok: true,
        diagnostic:
          acceptedCode !== undefined
            ? `Resource was already absent (Cloudflare code ${acceptedCode}).`
            : "Resource or binding was already absent.",
      };
    }
    return {
      ok: false,
      diagnostic,
    };
  }
}

export async function cleanupCloudflare(
  options: CloudflareCleanupOptions,
  dependencies: CloudflareDependencies,
): Promise<void> {
  const account = validateAccount(options.account);
  const names = cloudflareResourceNames(options.name);
  dependencies.log(
    JSON.stringify(
      {
        object: "cloudflare_cleanup_plan",
        account,
        resources: names,
        order: [
          "remove Queue consumers",
          "delete Worker",
          "read D1 payload references",
          "delete HayaSend R2 payload objects",
          "delete R2 bucket",
          "delete Queues",
          "delete D1 database",
        ],
        destructive: true,
      },
      null,
      2,
    ),
  );
  if (!options.apply) {
    return;
  }
  requireMutationConfirmation(account, options.confirmAccount);
  const results: Array<{
    resource: string;
    ok: boolean;
    diagnostic?: string;
  }> = [];
  for (const queue of [
    names.email_events_queue,
    names.primary_queue,
    names.dead_letter_queue,
  ]) {
    results.push({
      resource: `${queue} consumer ${names.worker}`,
      ...(await bestEffortWrangler(
        dependencies,
        account,
        ["queues", "consumer", "remove", queue, names.worker],
        [],
        [
          /Queue "[^"]+" does not exist/iu,
          /No worker consumer '[^']+' exists for queue/iu,
        ],
      )),
    });
  }
  results.push({
    resource: names.worker,
    ...(await bestEffortWrangler(
      dependencies,
      account,
      ["delete", names.worker],
      [10007, 10090],
    )),
  });
  let payloadKeys: string[] = [];
  try {
    const query = await wrangler(dependencies, account, [
      "d1",
      "execute",
      names.database,
      "--remote",
      "--json",
      "--yes",
      "--command",
      "SELECT json_extract(entity, '$.payload_ref') AS object_key FROM emails WHERE json_extract(entity, '$.payload_ref') IS NOT NULL",
    ]);
    payloadKeys = payloadKeysFromD1(query.stdout);
  } catch {
    // The database may already be absent during an idempotent cleanup retry.
  }
  for (const key of payloadKeys) {
    results.push({
      resource: `${names.bucket}/${key}`,
      ...(await bestEffortWrangler(dependencies, account, [
        "r2",
        "object",
        "delete",
        `${names.bucket}/${key}`,
        "--remote",
        "--force",
      ])),
    });
  }
  results.push({
    resource: names.bucket,
    ...(await bestEffortWrangler(
      dependencies,
      account,
      ["r2", "bucket", "delete", names.bucket],
      [10006],
    )),
  });
  for (const queue of [
    names.email_events_queue,
    names.primary_queue,
    names.dead_letter_queue,
  ]) {
    results.push({
      resource: queue,
      ...(await bestEffortWrangler(
        dependencies,
        account,
        ["queues", "delete", queue],
        [],
        [/Queue "[^"]+" does not exist/iu],
      )),
    });
  }
  results.push({
    resource: names.database,
    ...(await bestEffortWrangler(
      dependencies,
      account,
      [
        "d1",
        "delete",
        names.database,
        "--skip-confirmation",
      ],
      [],
      [/Couldn't find a D1 DB with name or binding/iu],
    )),
  });
  const failed = results.filter((result) => !result.ok);
  dependencies.log(
    JSON.stringify(
      {
        object: "cloudflare_cleanup_result",
        account,
        deleted_payload_objects: payloadKeys.length,
        results,
        complete: failed.length === 0,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) {
    throw new Error(
      `Cloudflare cleanup left ${failed.length} resource operation(s) unresolved.`,
    );
  }
}

export async function doctorCloudflare(
  input: {
    endpoint: string;
    deploymentId?: string | undefined;
  },
  dependencies: Pick<CloudflareDependencies, "env" | "log"> & {
    fetch: typeof fetch;
    sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  },
): Promise<void> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:") {
    throw new Error("Cloudflare doctor requires an HTTPS endpoint.");
  }
  const fetchJson = async (
    pathname: string,
    init: RequestInit = {},
  ): Promise<{
    response: Response;
    body: Record<string, unknown>;
  }> => {
    const transientStatuses = new Set([404, 500, 502, 503, 504]);
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const response = await dependencies.fetch(
          new URL(pathname, endpoint),
          {
            ...init,
            signal: AbortSignal.timeout(5_000),
          },
        );
        lastStatus = response.status;
        if (!response.ok && !transientStatuses.has(response.status)) {
          return { response, body: {} };
        }
        if (response.ok) {
          try {
            return {
              response,
              body: (await response.json()) as Record<string, unknown>,
            };
          } catch {
            lastStatus = response.status;
          }
        }
      } catch {
        lastStatus = undefined;
      }
      if (attempt < 9) {
        await (dependencies.sleep ??
          ((milliseconds) =>
            new Promise((resolve) =>
              setTimeout(resolve, milliseconds),
            )))(1_000);
      }
    }
    throw new Error(
      `Cloudflare endpoint did not stabilize after deployment${
        lastStatus === undefined ? "" : ` (HTTP ${lastStatus})`
      }.`,
    );
  };
  const {
    response: healthResponse,
    body: health,
  } = await fetchJson("/healthz");
  const {
    response: capabilityResponse,
    body: capability,
  } = await fetchJson("/capabilities");
  const checks = {
    health_status: healthResponse.status === 200,
    runtime: health.runtime === "cloudflare-workers",
    production_truth: health.production_ready === false,
    deployment_id:
      input.deploymentId === undefined ||
      health.deployment_id === input.deploymentId,
    capability_status: capabilityResponse.status === 200,
    capability_digest:
      capability.capability_digest ===
      CLOUDFLARE_WORKER_CAPABILITY.capability_digest,
    beta_truth:
      capability.maturity === "beta-proof" &&
      capability.production_ready === false,
  };
  const apiKey = dependencies.env.HAYASEND_CLOUDFLARE_API_KEY;
  let authenticatedApi: boolean | null = null;
  if (apiKey) {
    const { response: api } = await fetchJson("/emails?limit=1", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    authenticatedApi = api.status === 200;
  }
  const healthy =
    Object.values(checks).every(Boolean) &&
    authenticatedApi !== false;
  dependencies.log(
    JSON.stringify(
      {
        object: "cloudflare_doctor",
        endpoint: endpoint.origin,
        healthy,
        checks,
        authenticated_api:
          authenticatedApi === null ? "not_checked" : authenticatedApi,
        capability_digest:
          CLOUDFLARE_WORKER_CAPABILITY.capability_digest,
        production_ready: false,
        provider_maturity: "beta",
      },
      null,
      2,
    ),
  );
  if (!healthy) {
    throw new Error("Cloudflare doctor found an unhealthy deployment.");
  }
}
