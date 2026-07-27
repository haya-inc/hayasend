import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  webhookEventSchema,
  webhookSchema,
  webhookUpdateSchema,
} from "./schemas.js";

interface WebhookCommandDependencies {
  cwd: string;
  log(message: string): void;
  request(path: string, init?: RequestInit): Promise<unknown>;
}

interface OptionSpecification {
  values?: string[];
  booleans?: string[];
  repeatable?: string[];
  positionals?: number;
}

interface ParsedOptions {
  booleans: Set<string>;
  positionals: string[];
  repeatable: Map<string, string[]>;
  values: Map<string, string>;
}

const WEBHOOK_ID_PATTERN = /^wh_[a-f0-9]{32}$/;
const DELIVERY_ID_PATTERN = /^msg_[a-f0-9]{32}$/;
const SIGNING_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/]{43}=$/;

function parseOptions(
  args: string[],
  {
    values = [],
    booleans = [],
    repeatable = [],
    positionals = 0,
  }: OptionSpecification,
): ParsedOptions {
  const result: ParsedOptions = {
    booleans: new Set(),
    positionals: [],
    repeatable: new Map(),
    values: new Map(),
  };
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (!option) {
      throw new Error("Unexpected empty argument.");
    }
    if (!option.startsWith("--")) {
      if (result.positionals.length >= positionals) {
        throw new Error(`Unexpected argument: ${option ?? ""}`);
      }
      result.positionals.push(option);
      continue;
    }
    const name = option.slice(2);
    if (booleans.includes(name)) {
      if (result.booleans.has(name)) {
        throw new Error(`Option --${name} may be provided only once.`);
      }
      result.booleans.add(name);
      continue;
    }
    if (![...values, ...repeatable].includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    index += 1;
    if (repeatable.includes(name)) {
      result.repeatable.set(name, [
        ...(result.repeatable.get(name) ?? []),
        value,
      ]);
    } else {
      if (result.values.has(name)) {
        throw new Error(`Option --${name} may be provided only once.`);
      }
      result.values.set(name, value);
    }
  }
  if (result.positionals.length < positionals) {
    throw new Error("A required argument is missing.");
  }
  return result;
}

function requiredValue(options: ParsedOptions, name: string) {
  const value = options.values.get(name);
  if (!value) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function webhookPath(identifier: string) {
  return `/webhooks/${encodeURIComponent(identifier)}`;
}

function webhookEndpointShape(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Webhook URL must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    value.length > 2_048
  ) {
    throw new Error(
      "Webhook URL must be an HTTP(S) URL of at most 2048 characters without credentials or a fragment.",
    );
  }
}

function webhookEvents(options: ParsedOptions, required: boolean) {
  const events = [...new Set(options.repeatable.get("event") ?? [])];
  if (required && events.length === 0) {
    throw new Error("At least one --event is required.");
  }
  const invalid = events.find(
    (event) => !webhookEventSchema.safeParse(event).success,
  );
  if (invalid) {
    throw new Error(`Unsupported webhook event: ${invalid}`);
  }
  return events;
}

function paginationQuery(
  options: ParsedOptions,
  cursorPattern: RegExp,
  cursorLabel: string,
) {
  const parameters = new URLSearchParams();
  const limit = options.values.get("limit");
  if (limit) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
      throw new Error("--limit must be an integer between 1 and 100.");
    }
    parameters.set("limit", limit);
  }
  const after = options.values.get("after");
  if (after) {
    if (!cursorPattern.test(after)) {
      throw new Error(`--after must be a valid ${cursorLabel} ID.`);
    }
    parameters.set("after", after);
  }
  return parameters.size > 0 ? `?${parameters}` : "";
}

function responseId(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0
  ) {
    throw new Error("HayaSend did not return a valid webhook identifier.");
  }
  return value.id;
}

function signingSecret(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("signing_secret" in value) ||
    typeof value.signing_secret !== "string" ||
    !SIGNING_SECRET_PATTERN.test(value.signing_secret)
  ) {
    throw new Error("HayaSend did not return a valid webhook signing secret.");
  }
  return value.signing_secret;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
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
        normalized.includes("authorization");
      return [key, sensitive ? "[REDACTED]" : redactSecrets(entry)];
    }),
  );
}

async function reserveSecretFile(path: string) {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite signing secret file: ${path}`);
    }
    throw error;
  }
}

async function createWebhook(
  options: ParsedOptions,
  dependencies: WebhookCommandDependencies,
) {
  const endpoint = requiredValue(options, "url");
  const events = webhookEvents(options, true);
  webhookEndpointShape(endpoint);
  const payload = webhookSchema.safeParse({ endpoint, events });
  if (!payload.success) {
    throw new Error("Webhook input is invalid.");
  }
  const secretFile = resolve(
    dependencies.cwd,
    requiredValue(options, "secret-file"),
  );
  const handle = await reserveSecretFile(secretFile);
  let createdId: string | undefined;
  let persisted = false;
  let rollbackFailed = false;
  try {
    const response = await dependencies.request("/webhooks", {
      method: "POST",
      body: JSON.stringify(payload.data),
    });
    createdId = responseId(response);
    if (!WEBHOOK_ID_PATTERN.test(createdId)) {
      throw new Error("HayaSend did not return a valid webhook identifier.");
    }
    const secret = signingSecret(response);
    await handle.writeFile(`${secret}\n`, "utf8");
    await handle.sync();
    persisted = true;
    const { signing_secret: _secret, ...webhook } = response as Record<
      string,
      unknown
    >;
    dependencies.log(
      JSON.stringify(
        {
          ...(redactSecrets(webhook) as Record<string, unknown>),
          signing_secret_file: secretFile,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (createdId && !persisted) {
      try {
        await dependencies.request(webhookPath(createdId), {
          method: "DELETE",
        });
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) {
      throw new Error(
        `Webhook ${createdId} was created, but its signing secret could not be saved and automatic cleanup failed. Delete it before retrying.`,
      );
    }
    throw error;
  } finally {
    await handle.close();
    if (!persisted) {
      await unlink(secretFile).catch(() => undefined);
    }
  }
}

function requireAcknowledgement(
  options: ParsedOptions,
  action: "delete" | "replay",
) {
  if (!options.booleans.has("yes")) {
    throw new Error(
      `${action} requires --yes because it ${
        action === "delete"
          ? "permanently removes a webhook"
          : "queues an externally observable delivery"
      }.`,
    );
  }
}

function print(value: unknown, dependencies: WebhookCommandDependencies) {
  dependencies.log(JSON.stringify(redactSecrets(value), null, 2));
}

export async function webhookCommand(
  args: string[],
  dependencies: WebhookCommandDependencies,
) {
  const command = args[0] ?? "help";
  switch (command) {
    case "create": {
      const options = parseOptions(args, {
        values: ["url", "secret-file", "endpoint"],
        repeatable: ["event"],
      });
      await createWebhook(options, dependencies);
      break;
    }
    case "list": {
      const options = parseOptions(args, {
        values: ["limit", "after", "endpoint"],
      });
      print(
        await dependencies.request(
          `/webhooks${paginationQuery(
            options,
            WEBHOOK_ID_PATTERN,
            "webhook",
          )}`,
        ),
        dependencies,
      );
      break;
    }
    case "get": {
      const options = parseOptions(args, {
        values: ["endpoint"],
        positionals: 1,
      });
      print(
        await dependencies.request(webhookPath(options.positionals[0] ?? "")),
        dependencies,
      );
      break;
    }
    case "update": {
      const options = parseOptions(args, {
        values: ["url", "status", "endpoint"],
        repeatable: ["event"],
        positionals: 1,
      });
      const endpoint = options.values.get("url");
      const events = webhookEvents(options, false);
      const status = options.values.get("status");
      if (status && !["enabled", "disabled"].includes(status)) {
        throw new Error("--status must be enabled or disabled.");
      }
      if (!endpoint && events.length === 0 && !status) {
        throw new Error(
          "update requires at least one of --url, --event, or --status.",
        );
      }
      if (endpoint) {
        webhookEndpointShape(endpoint);
      }
      const payload = webhookUpdateSchema.safeParse({
        ...(endpoint ? { endpoint } : {}),
        ...(events.length > 0 ? { events } : {}),
        ...(status ? { status } : {}),
      });
      if (!payload.success) {
        throw new Error("Webhook update is invalid.");
      }
      print(
        await dependencies.request(
          webhookPath(options.positionals[0] ?? ""),
          {
            method: "PATCH",
            body: JSON.stringify(payload.data),
          },
        ),
        dependencies,
      );
      break;
    }
    case "delete": {
      const options = parseOptions(args, {
        values: ["endpoint"],
        booleans: ["yes"],
        positionals: 1,
      });
      requireAcknowledgement(options, "delete");
      print(
        await dependencies.request(webhookPath(options.positionals[0] ?? ""), {
          method: "DELETE",
        }),
        dependencies,
      );
      break;
    }
    case "deliveries": {
      const options = parseOptions(args, {
        values: ["limit", "after", "endpoint"],
        positionals: 1,
      });
      print(
        await dependencies.request(
          `${webhookPath(
            options.positionals[0] ?? "",
          )}/deliveries${paginationQuery(
            options,
            DELIVERY_ID_PATTERN,
            "delivery",
          )}`,
        ),
        dependencies,
      );
      break;
    }
    case "inspect-delivery": {
      const options = parseOptions(args, {
        values: ["endpoint"],
        positionals: 2,
      });
      print(
        await dependencies.request(
          `${webhookPath(options.positionals[0] ?? "")}/deliveries/${encodeURIComponent(options.positionals[1] ?? "")}`,
        ),
        dependencies,
      );
      break;
    }
    case "replay": {
      const options = parseOptions(args, {
        values: ["endpoint"],
        booleans: ["yes"],
        positionals: 2,
      });
      requireAcknowledgement(options, "replay");
      print(
        await dependencies.request(
          `${webhookPath(options.positionals[0] ?? "")}/deliveries/${encodeURIComponent(options.positionals[1] ?? "")}/replay`,
          { method: "POST" },
        ),
        dependencies,
      );
      break;
    }
    default:
      throw new Error(
        `Unknown webhooks command: ${command}. Run hayasend help.`,
      );
  }
}
