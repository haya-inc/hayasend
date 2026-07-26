import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { createTemplateSchema } from "./schemas.js";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TEMPLATE_FILE_BYTES = 128 * 1024;
const ALIAS_PATTERN = /^(?!tmpl_)[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const VARIABLE_KEY_PATTERN = /^[A-Za-z0-9_]{1,50}$/;
const VARIABLE_PATTERN = /{{{\s*([A-Za-z0-9_]{1,50})\s*}}}/g;
const RESERVED_VARIABLES = new Set([
  "FIRST_NAME",
  "LAST_NAME",
  "EMAIL",
  "UNSUBSCRIBE_URL",
  "RESEND_UNSUBSCRIBE_URL",
  "contact",
  "this",
]);

const manifestVariableSchema = z.discriminatedUnion("type", [
  z
    .object({
      key: z.string().regex(VARIABLE_KEY_PATTERN),
      type: z.literal("string"),
      fallback_value: z.string().max(2_000).nullable().optional(),
    })
    .strict(),
  z
    .object({
      key: z.string().regex(VARIABLE_KEY_PATTERN),
      type: z.literal("number"),
      fallback_value: z.number().finite().safe().nullable().optional(),
    })
    .strict(),
]);

const manifestTemplateSchema = z
  .object({
    alias: z.string().min(1).max(128).regex(ALIAS_PATTERN),
    name: z.string().trim().min(1).max(256),
    html_file: z.string().min(1),
    text_file: z.string().min(1).nullable().optional(),
    from: z.string().min(1).nullable().optional(),
    subject: z.string().max(998).nullable().optional(),
    reply_to: z.array(z.string().min(1)).max(50).nullable().optional(),
    variables: z.array(manifestVariableSchema).max(50).optional(),
  })
  .strict()
  .superRefine((template, context) => {
    const keys = new Set<string>();
    for (const [index, variable] of (template.variables ?? []).entries()) {
      if (keys.has(variable.key)) {
        context.addIssue({
          code: "custom",
          message: `Variable ${variable.key} is declared more than once.`,
          path: ["variables", index, "key"],
        });
      }
      keys.add(variable.key);
    }
  });

const templateManifestSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    templates: z.array(manifestTemplateSchema).min(1).max(100),
  })
  .strict()
  .superRefine((manifest, context) => {
    const aliases = new Set<string>();
    for (const [index, template] of manifest.templates.entries()) {
      if (aliases.has(template.alias)) {
        context.addIssue({
          code: "custom",
          message: `Alias ${template.alias} is declared more than once.`,
          path: ["templates", index, "alias"],
        });
      }
      aliases.add(template.alias);
    }
  });

type ManifestTemplate = z.infer<typeof manifestTemplateSchema>;

export interface DesiredTemplate {
  alias: string;
  name: string;
  html: string;
  text: string | null;
  from: string | null;
  subject: string | null;
  reply_to: string[] | null;
  variables: Array<{
    key: string;
    type: "string" | "number";
    fallback_value: string | number | null;
  }>;
}

export interface RemoteTemplate extends DesiredTemplate {
  id: string;
  object: "template";
  current_version_id: string;
  status: "draft" | "published";
  has_unpublished_versions: boolean;
}

const remoteTemplateSchema = z
  .object({
    object: z.literal("template"),
    id: z.string().min(1),
    current_version_id: z.string().min(1),
    alias: z.string().min(1),
    name: z.string(),
    html: z.string(),
    text: z.string().nullable(),
    from: z.string().nullable(),
    subject: z.string().nullable(),
    reply_to: z.array(z.string()).nullable(),
    variables: z
      .array(
        z
          .object({
            key: z.string(),
            type: z.enum(["string", "number"]),
            fallback_value: z.union([z.string(), z.number()]).nullable(),
          })
          .passthrough(),
      )
      .nullable(),
    status: z.enum(["draft", "published"]),
    has_unpublished_versions: z.boolean(),
  })
  .passthrough();

function formatZodError(error: z.ZodError) {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

async function readBoundedFile(path: string, maximumBytes: number) {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error(`Expected a regular file: ${path}`);
  }
  if (metadata.size > maximumBytes) {
    throw new Error(`File exceeds the ${maximumBytes}-byte limit: ${path}`);
  }
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > maximumBytes) {
    throw new Error(`File exceeds the ${maximumBytes}-byte limit: ${path}`);
  }
  return content;
}

async function resolveContentFile(
  root: string,
  configuredPath: string,
  label: string,
) {
  if (isAbsolute(configuredPath)) {
    throw new Error(`${label} must be relative to the manifest directory.`);
  }
  const candidate = await realpath(resolve(root, configuredPath));
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} must stay inside the manifest directory.`);
  }
  return candidate;
}

async function loadDesiredTemplate(
  root: string,
  input: ManifestTemplate,
): Promise<DesiredTemplate> {
  const htmlPath = await resolveContentFile(
    root,
    input.html_file,
    `${input.alias}.html_file`,
  );
  const html = await readBoundedFile(htmlPath, MAX_TEMPLATE_FILE_BYTES);
  if (html.length === 0) {
    throw new Error(`${input.alias}.html_file must not be empty.`);
  }
  const text =
    input.text_file === undefined || input.text_file === null
      ? null
      : await readBoundedFile(
          await resolveContentFile(
            root,
            input.text_file,
            `${input.alias}.text_file`,
          ),
          MAX_TEMPLATE_FILE_BYTES,
        );
  const desired: DesiredTemplate = {
    alias: input.alias,
    name: input.name,
    html,
    text,
    from: input.from ?? null,
    subject: input.subject ?? null,
    reply_to: input.reply_to ?? null,
    variables: (input.variables ?? []).map((variable) => ({
      ...variable,
      fallback_value: variable.fallback_value ?? null,
    })),
  };
  const serverValidation = createTemplateSchema.safeParse(desired);
  if (!serverValidation.success) {
    throw new Error(
      `Template ${input.alias} is invalid: ${formatZodError(
        serverValidation.error,
      )}`,
    );
  }
  const declared = new Set(desired.variables.map((variable) => variable.key));
  for (const variable of desired.variables) {
    if (RESERVED_VARIABLES.has(variable.key)) {
      throw new Error(
        `Template ${input.alias} uses reserved variable ${variable.key}.`,
      );
    }
  }
  const fields = [
    desired.html,
    desired.text,
    desired.from,
    desired.subject,
    ...(desired.reply_to ?? []),
  ];
  for (const field of fields) {
    if (field === null) {
      continue;
    }
    for (const match of field.matchAll(VARIABLE_PATTERN)) {
      const key = match[1];
      if (key && !declared.has(key)) {
        throw new Error(
          `Template ${input.alias} uses undeclared variable ${key}.`,
        );
      }
    }
  }
  return desired;
}

export async function loadTemplateManifest(
  cwd: string,
  configuredPath = "hayasend.templates.json",
) {
  const manifestPath = resolve(cwd, configuredPath);
  const source = await readBoundedFile(manifestPath, MAX_MANIFEST_BYTES);
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(
      `Template manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsed = templateManifestSchema.safeParse(untrusted);
  if (!parsed.success) {
    throw new Error(
      `Template manifest is invalid: ${formatZodError(parsed.error)}`,
    );
  }
  const root = await realpath(dirname(manifestPath));
  const templates = await Promise.all(
    parsed.data.templates.map((template) =>
      loadDesiredTemplate(root, template),
    ),
  );
  return { path: manifestPath, templates };
}

export function parseRemoteTemplate(value: unknown): RemoteTemplate {
  const parsed = remoteTemplateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `HayaSend returned an invalid template: ${formatZodError(parsed.error)}`,
    );
  }
  return {
    object: parsed.data.object,
    id: parsed.data.id,
    current_version_id: parsed.data.current_version_id,
    alias: parsed.data.alias,
    name: parsed.data.name,
    html: parsed.data.html,
    text: parsed.data.text,
    from: parsed.data.from,
    subject: parsed.data.subject,
    reply_to: parsed.data.reply_to,
    variables: (parsed.data.variables ?? []).map((variable) => ({
      key: variable.key,
      type: variable.type,
      fallback_value: variable.fallback_value,
    })),
    status: parsed.data.status,
    has_unpublished_versions: parsed.data.has_unpublished_versions,
  };
}

export function templatesMatch(
  desired: DesiredTemplate,
  remote: RemoteTemplate,
) {
  return (
    JSON.stringify(desired) ===
    JSON.stringify({
      alias: remote.alias,
      name: remote.name,
      html: remote.html,
      text: remote.text,
      from: remote.from,
      subject: remote.subject,
      reply_to: remote.reply_to,
      variables: remote.variables,
    })
  );
}

export function parseTemplateVariables(values: string[]) {
  const variables: Record<string, string | number> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new Error(
        "--var values must use KEY=VALUE (for example, --var NAME=Ada).",
      );
    }
    const key = value.slice(0, separator);
    const raw = value.slice(separator + 1);
    if (!VARIABLE_KEY_PATTERN.test(key)) {
      throw new Error(
        `Template variable key ${key} must contain 1–50 ASCII letters, numbers, or underscores.`,
      );
    }
    if (Object.hasOwn(variables, key)) {
      throw new Error(`Template variable ${key} was provided more than once.`);
    }
    if (/^-?(?:0|[1-9]\d*)$/.test(raw)) {
      const numeric = Number(raw);
      if (Number.isSafeInteger(numeric)) {
        variables[key] = numeric;
        continue;
      }
    }
    variables[key] = raw;
  }
  return variables;
}
