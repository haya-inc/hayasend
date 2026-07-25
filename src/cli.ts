#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";

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
}

const defaultDependencies: CliDependencies = {
  cwd: process.cwd(),
  env: process.env,
  fetch,
  io: console,
};

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value.`);
  }
  return value;
}

function hasFlag(args: string[], name: string) {
  return args.includes(`--${name}`);
}

function validateOptions(args: string[], allowed: string[]) {
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    if (!option?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${option ?? ""}`);
    }
    const name = option.slice(2);
    if (!allowed.includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`Option --${name} may be provided only once.`);
    }
    seen.add(name);
    flag(args, name);
  }
}

function isLoopbackHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
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
    flag(args, "endpoint") ??
      env.HAYASEND_BASE_URL ??
      "http://localhost:8787",
  );
}

function apiKey(env: NodeJS.ProcessEnv) {
  return env.HAYASEND_API_KEY ?? "re_hayasend_dev";
}

async function readJsonResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(
      `Expected JSON from HayaSend but received ${contentType || "an unknown content type"}: ${body}`,
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
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

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
          preview:
            previewResponse.status === 200
              ? "available"
              : "not_available",
        },
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
  const packageJson = JSON.parse(
    await readFile(packagePath, "utf8"),
  ) as { version?: unknown };
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
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function initProject(
  args: string[],
  dependencies: CliDependencies,
) {
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

async function send(args: string[], dependencies: CliDependencies) {
  const from = flag(args, "from");
  const to = flag(args, "to");
  const subject = flag(args, "subject");
  const text = flag(args, "text");
  if (!from || !to || !subject || !text) {
    throw new Error(
      "send requires --from, --to, --subject, and --text arguments.",
    );
  }
  const result = await request("/emails", args, dependencies, {
    method: "POST",
    body: JSON.stringify({ from, to, subject, text }),
  });
  dependencies.io.log(JSON.stringify(result, null, 2));
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
              preview_url:
                `${baseUrl}/preview?email=${encodeURIComponent(created.id)}`,
            }
          : {}),
      },
      null,
      2,
    ),
  );
}

function help(dependencies: CliDependencies) {
  dependencies.io.log(`HayaSend CLI

Commands:
  init [--dir DIRECTORY]
      Create a pinned, hardened local Compose setup without overwriting files.

  dev
      Start HayaSend from source in local mode.

  doctor [--endpoint URL]
      Check HayaSend identity, health, authentication, and preview availability.
      Read the key from HAYASEND_API_KEY.

  test --from ADDRESS --to ADDRESS [--subject TEXT] [--endpoint URL]
      Send and retrieve an end-to-end test message. This sends real email when
      the endpoint is not local.

  send --from ADDRESS --to ADDRESS --subject TEXT --text TEXT [--endpoint URL]
      Send a plain-text email.

Environment:
  HAYASEND_BASE_URL    Defaults to http://localhost:8787
  HAYASEND_API_KEY     Defaults to re_hayasend_dev for local mode
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
  if (hasFlag(args, "help") || command === "help") {
    help(dependencies);
    return;
  }
  switch (command) {
    case "init":
      validateOptions(args, ["dir"]);
      await initProject(args, dependencies);
      break;
    case "dev":
      validateOptions(args, []);
      startServer();
      break;
    case "doctor":
      validateOptions(args, ["endpoint"]);
      await doctor(args, dependencies);
      break;
    case "test":
      validateOptions(args, ["from", "to", "subject", "endpoint"]);
      await testSend(args, dependencies);
      break;
    case "send":
      validateOptions(args, [
        "from",
        "to",
        "subject",
        "text",
        "endpoint",
      ]);
      await send(args, dependencies);
      break;
    default:
      throw new Error(`Unknown command: ${command}. Run hayasend help.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
