import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { suppressionSchema } from "./schemas.js";
import { normalizeMailbox } from "./services/suppression-service.js";

const MAX_EMAIL_FILE_BYTES = 1_024;
const MAX_DETAIL_FILE_BYTES = 2_048;
const SUPPRESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

interface SuppressionCommandDependencies {
  cwd: string;
  log(message: string): void;
  request(path: string, init?: RequestInit): Promise<unknown>;
}

interface OptionSpecification {
  booleans?: string[];
  maximumPositionals?: number;
  values?: string[];
}

interface ParsedOptions {
  booleans: Set<string>;
  positionals: string[];
  values: Map<string, string>;
}

function parseOptions(
  args: string[],
  {
    booleans = [],
    maximumPositionals = 0,
    values = [],
  }: OptionSpecification,
): ParsedOptions {
  const result: ParsedOptions = {
    booleans: new Set(),
    positionals: [],
    values: new Map(),
  };
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (!option) {
      throw new Error("Unexpected empty argument.");
    }
    if (!option.startsWith("--")) {
      if (result.positionals.length >= maximumPositionals) {
        throw new Error(`Unexpected argument: ${option}`);
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
    if (!values.includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (result.values.has(name)) {
      throw new Error(`Option --${name} may be provided only once.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    result.values.set(name, value);
    index += 1;
  }
  return result;
}

async function readBoundedFile(
  cwd: string,
  inputPath: string,
  label: string,
  maximumBytes: number,
) {
  const path = resolve(cwd, inputPath);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`${label} must be a regular file: ${path}`);
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file: ${path}`);
    }
    if (metadata.size > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(buffer.subarray(0, bytesRead))
        .trim();
    } catch {
      throw new Error(`${label} must contain valid UTF-8 text: ${path}`);
    }
  } finally {
    await handle.close();
  }
}

async function mailbox(
  options: ParsedOptions,
  dependencies: SuppressionCommandDependencies,
) {
  const positional = options.positionals[0];
  const emailFile = options.values.get("email-file");
  if (positional && emailFile) {
    throw new Error(
      "Provide the suppression mailbox either as an argument or with --email-file, not both.",
    );
  }
  if (!positional && !emailFile) {
    throw new Error(
      "A suppression mailbox argument or --email-file is required.",
    );
  }
  const input = emailFile
    ? await readBoundedFile(
        dependencies.cwd,
        emailFile,
        "Email file",
        MAX_EMAIL_FILE_BYTES,
      )
    : (positional ?? "");
  let normalized: string;
  try {
    normalized = normalizeMailbox(input);
  } catch {
    throw new Error("The suppression mailbox is invalid.");
  }
  if (!suppressionSchema.safeParse({ email: normalized }).success) {
    throw new Error("The suppression mailbox is invalid.");
  }
  return normalized;
}

async function detail(
  options: ParsedOptions,
  dependencies: SuppressionCommandDependencies,
) {
  const detailFile = options.values.get("detail-file");
  if (!detailFile) {
    return undefined;
  }
  const value = await readBoundedFile(
    dependencies.cwd,
    detailFile,
    "Detail file",
    MAX_DETAIL_FILE_BYTES,
  );
  if (value.length === 0 || value.length > 500) {
    throw new Error(
      "The suppression detail must contain between 1 and 500 characters.",
    );
  }
  return value;
}

function paginationQuery(options: ParsedOptions) {
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
    if (!SUPPRESSION_ID_PATTERN.test(after)) {
      throw new Error("--after must be a valid suppression ID.");
    }
    parameters.set("after", after);
  }
  return parameters.size > 0 ? `?${parameters}` : "";
}

function suppressionPath(email: string) {
  return `/suppressions/${encodeURIComponent(email)}`;
}

function print(value: unknown, dependencies: SuppressionCommandDependencies) {
  dependencies.log(JSON.stringify(value, null, 2));
}

export async function suppressionCommand(
  args: string[],
  dependencies: SuppressionCommandDependencies,
) {
  const command = args[0] ?? "help";
  switch (command) {
    case "add": {
      const options = parseOptions(args, {
        maximumPositionals: 1,
        values: ["email-file", "detail-file", "endpoint"],
      });
      const email = await mailbox(options, dependencies);
      const suppressionDetail = await detail(options, dependencies);
      const input = suppressionSchema.parse({
        email,
        reason: "manual",
        ...(suppressionDetail ? { detail: suppressionDetail } : {}),
      });
      print(
        await dependencies.request("/suppressions", {
          method: "POST",
          body: JSON.stringify(input),
        }),
        dependencies,
      );
      break;
    }
    case "list": {
      const options = parseOptions(args, {
        values: ["limit", "after", "endpoint"],
      });
      print(
        await dependencies.request(
          `/suppressions${paginationQuery(options)}`,
        ),
        dependencies,
      );
      break;
    }
    case "get": {
      const options = parseOptions(args, {
        maximumPositionals: 1,
        values: ["email-file", "endpoint"],
      });
      const email = await mailbox(options, dependencies);
      print(
        await dependencies.request(suppressionPath(email)),
        dependencies,
      );
      break;
    }
    case "delete": {
      const options = parseOptions(args, {
        booleans: ["yes"],
        maximumPositionals: 1,
        values: ["email-file", "endpoint"],
      });
      if (!options.booleans.has("yes")) {
        throw new Error(
          "delete requires --yes because removing a suppression can damage sender reputation.",
        );
      }
      const email = await mailbox(options, dependencies);
      print(
        await dependencies.request(suppressionPath(email), {
          method: "DELETE",
        }),
        dependencies,
      );
      break;
    }
    default:
      throw new Error(
        `Unknown suppressions command: ${command}. Run hayasend help.`,
      );
  }
}
