import { domainSchema } from "./schemas.js";

interface DomainCommandDependencies {
  request(path: string, init?: RequestInit): Promise<unknown>;
  log(message: string): void;
}

interface ParsedArguments {
  booleans: Set<string>;
  positionals: string[];
  values: Map<string, string>;
}

const DOMAIN_ID_PATTERN = /^dom_[a-f0-9]{32}$/;

function parseArguments(
  args: string[],
  specification: {
    booleans?: string[];
    positionals?: number;
    values?: string[];
  },
): ParsedArguments {
  const allowedBooleans = new Set(specification.booleans ?? []);
  const allowedValues = new Set(specification.values ?? []);
  const booleans = new Set<string>();
  const positionals: string[] = [];
  const values = new Map<string, string>();

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) {
      positionals.push(argument ?? "");
      continue;
    }

    const name = argument.slice(2);
    if (allowedBooleans.has(name)) {
      if (booleans.has(name)) {
        throw new Error(`Option --${name} may be provided only once.`);
      }
      booleans.add(name);
      continue;
    }
    if (!allowedValues.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (values.has(name)) {
      throw new Error(`Option --${name} may be provided only once.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    values.set(name, value);
    index += 1;
  }

  const expectedPositionals = specification.positionals ?? 0;
  if (positionals.length < expectedPositionals) {
    throw new Error("A required argument is missing.");
  }
  if (positionals.length > expectedPositionals) {
    throw new Error(
      `Unexpected argument: ${positionals[expectedPositionals] ?? ""}`,
    );
  }
  return { booleans, positionals, values };
}

function domainPath(identifier: string) {
  if (!DOMAIN_ID_PATTERN.test(identifier)) {
    throw new Error("Domain ID is invalid.");
  }
  return `/domains/${encodeURIComponent(identifier)}`;
}

function printJson(
  dependencies: DomainCommandDependencies,
  value: unknown,
) {
  dependencies.log(JSON.stringify(value, null, 2));
}

export async function domainCommand(
  args: string[],
  dependencies: DomainCommandDependencies,
) {
  const command = args[0] ?? "help";
  switch (command) {
    case "create": {
      const parsed = parseArguments(args, {
        values: ["name", "endpoint"],
      });
      const result = domainSchema.safeParse({
        name: parsed.values.get("name")?.trim() ?? "",
      });
      if (!result.success) {
        throw new Error(
          `Domain input is invalid: ${result.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
      printJson(
        dependencies,
        await dependencies.request("/domains", {
          method: "POST",
          body: JSON.stringify(result.data),
        }),
      );
      break;
    }
    case "list": {
      const parsed = parseArguments(args, {
        values: ["limit", "after", "endpoint"],
      });
      const limit = parsed.values.get("limit");
      if (
        limit &&
        (!/^\d+$/.test(limit) ||
          Number(limit) < 1 ||
          Number(limit) > 100)
      ) {
        throw new Error("--limit must be an integer between 1 and 100.");
      }
      const after = parsed.values.get("after");
      if (after) {
        domainPath(after);
      }
      const parameters = new URLSearchParams();
      if (limit) {
        parameters.set("limit", limit);
      }
      if (after) {
        parameters.set("after", after);
      }
      const query = parameters.size > 0 ? `?${parameters}` : "";
      printJson(
        dependencies,
        await dependencies.request(`/domains${query}`),
      );
      break;
    }
    case "get":
    case "verify":
    case "delete": {
      const parsed = parseArguments(args, {
        booleans: command === "delete" ? ["yes"] : [],
        positionals: 1,
        values: ["endpoint"],
      });
      if (command === "delete" && !parsed.booleans.has("yes")) {
        throw new Error(
          "domains delete requires --yes because it removes the SES identity.",
        );
      }
      const path = domainPath(parsed.positionals[0] ?? "");
      const init =
        command === "verify"
          ? { method: "POST" }
          : command === "delete"
            ? { method: "DELETE" }
            : undefined;
      printJson(
        dependencies,
        await dependencies.request(
          command === "verify" ? `${path}/verify` : path,
          init,
        ),
      );
      break;
    }
    default:
      throw new Error(
        `Unknown domains command: ${command}. Run hayasend help.`,
      );
  }
}
