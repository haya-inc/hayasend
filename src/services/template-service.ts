import { convert } from "html-to-text";
import { createId } from "../core/crypto.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../core/errors.js";
import type {
  Page,
  PublicTemplate,
  SendEmailInput,
  TemplateListItem,
  TemplateRecord,
  TemplateVariable,
  TemplateVariableType,
  TemplateVersion,
} from "../core/types.js";
import type { Store } from "../ports/store.js";

export const MAX_TEMPLATE_BYTES = 128 * 1024;
export const MAX_RENDERED_TEMPLATE_BYTES = 1024 * 1024;

const RESERVED_VARIABLES = new Set([
  "FIRST_NAME",
  "LAST_NAME",
  "EMAIL",
  "UNSUBSCRIBE_URL",
  "RESEND_UNSUBSCRIBE_URL",
  "contact",
  "this",
]);
const VARIABLE_KEY_PATTERN = /^[A-Za-z0-9_]{1,50}$/;
const ALIAS_PATTERN = /^(?!tmpl_)[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const VARIABLE_PATTERN = /{{{\s*([A-Za-z0-9_]{1,50})\s*}}}/g;

export interface TemplateVariableInput {
  key: string;
  type: TemplateVariableType;
  fallback_value?: string | number | null | undefined;
}

export interface CreateTemplateInput {
  name: string;
  html: string;
  text?: string | null | undefined;
  alias?: string | null | undefined;
  from?: string | null | undefined;
  subject?: string | null | undefined;
  reply_to?: string[] | null | undefined;
  variables?: TemplateVariableInput[] | undefined;
}

export interface UpdateTemplateInput {
  name?: string | undefined;
  html?: string | undefined;
  text?: string | null | undefined;
  alias?: string | null | undefined;
  from?: string | null | undefined;
  subject?: string | null | undefined;
  reply_to?: string[] | null | undefined;
  variables?: TemplateVariableInput[] | undefined;
}

interface ResolvedSendEmailInput
  extends Omit<
    SendEmailInput,
    "from" | "subject" | "template" | "html" | "text" | "reply_to"
  > {
  from: string;
  subject: string;
  html?: string | undefined;
  text?: string | undefined;
  reply_to?: string[] | undefined;
}

function withoutNull<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function templateBytes(version: TemplateVersion): number {
  return Buffer.byteLength(
    JSON.stringify({
      name: version.name,
      html: version.html,
      text: version.text,
      alias: version.alias,
      from: version.from,
      subject: version.subject,
      reply_to: version.reply_to,
      variables: version.variables,
    }),
    "utf8",
  );
}

function validateVariables(variables: TemplateVariableInput[]) {
  if (variables.length > 50) {
    throw new ValidationError("A template may define at most 50 variables.");
  }
  const seen = new Set<string>();
  for (const variable of variables) {
    if (!VARIABLE_KEY_PATTERN.test(variable.key)) {
      throw new ValidationError(
        "Template variable keys must contain 1–50 ASCII letters, numbers, or underscores.",
      );
    }
    if (seen.has(variable.key)) {
      throw new ValidationError(
        `Template variable ${variable.key} is defined more than once.`,
      );
    }
    if (RESERVED_VARIABLES.has(variable.key)) {
      throw new ValidationError(
        `Template variable ${variable.key} is reserved.`,
      );
    }
    const fallback = variable.fallback_value;
    if (variable.type !== "string" && variable.type !== "number") {
      throw new ValidationError(
        `Template variable ${variable.key} has an invalid type.`,
      );
    }
    if (
      fallback !== undefined &&
      fallback !== null &&
      typeof fallback !== variable.type
    ) {
      throw new ValidationError(
        `Template variable ${variable.key} requires a ${variable.type} fallback value.`,
      );
    }
    if (typeof fallback === "string" && fallback.length > 2_000) {
      throw new ValidationError(
        `Template variable ${variable.key} must not exceed 2000 characters.`,
      );
    }
    if (
      typeof fallback === "number" &&
      (!Number.isFinite(fallback) || !Number.isSafeInteger(fallback))
    ) {
      throw new ValidationError(
        `Template variable ${variable.key} must be a finite safe integer.`,
      );
    }
    seen.add(variable.key);
  }
}

function variableRecords(
  inputs: TemplateVariableInput[],
  now: string,
  previous: TemplateVariable[] = [],
): TemplateVariable[] {
  validateVariables(inputs);
  const previousByKey = new Map(
    previous.map((variable) => [variable.key, variable]),
  );
  return inputs.map((input) => {
    const existing = previousByKey.get(input.key);
    return {
      id: existing?.id ?? createId("tmplvar"),
      key: input.key,
      type: input.type,
      fallback_value: input.fallback_value ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
  });
}

function referencedVariables(version: TemplateVersion): Set<string> {
  const references = new Set<string>();
  const fields = [
    version.html,
    version.text,
    version.from,
    version.subject,
    ...(version.reply_to ?? []),
  ];
  for (const field of fields) {
    if (field === undefined) {
      continue;
    }
    for (const match of field.matchAll(VARIABLE_PATTERN)) {
      const key = match[1];
      if (key) {
        references.add(key);
      }
    }
  }
  return references;
}

function validateVersion(version: TemplateVersion) {
  if (!version.name.trim() || version.name.length > 256) {
    throw new ValidationError(
      "Template name must contain between 1 and 256 characters.",
    );
  }
  if (!version.html) {
    throw new ValidationError("Template HTML is required.");
  }
  if (
    version.alias !== undefined &&
    (version.alias.length > 128 || !ALIAS_PATTERN.test(version.alias))
  ) {
    throw new ValidationError("Template alias is invalid.");
  }
  for (const [label, field] of [
    ["from", version.from],
    ["subject", version.subject],
    ...(version.reply_to ?? []).map(
      (replyTo) => ["reply_to", replyTo] as const,
    ),
  ] as const) {
    if (field !== undefined && /[\r\n]/.test(field)) {
      throw new ValidationError(
        `Template ${label} must not contain line breaks.`,
      );
    }
  }
  if (templateBytes(version) > MAX_TEMPLATE_BYTES) {
    throw new ValidationError(
      `A template version must not exceed ${MAX_TEMPLATE_BYTES} bytes.`,
    );
  }
  const declared = new Set(version.variables.map((variable) => variable.key));
  for (const key of referencedVariables(version)) {
    if (!declared.has(key)) {
      throw new ValidationError(
        `Template variable ${key} is used but not declared.`,
      );
    }
  }
}

function publicTemplate(record: TemplateRecord): PublicTemplate {
  const current = record.draft;
  return {
    object: "template",
    id: record.id,
    current_version_id: current.id,
    alias: current.alias ?? null,
    name: current.name,
    created_at: record.created_at,
    updated_at: record.updated_at,
    status: record.published ? "published" : "draft",
    published_at: record.published_at ?? null,
    from: current.from ?? null,
    subject: current.subject ?? null,
    reply_to: current.reply_to ?? null,
    html: current.html,
    text: current.text ?? null,
    variables:
      current.variables.length > 0 ? structuredClone(current.variables) : null,
    has_unpublished_versions: record.published?.id !== record.draft.id,
  };
}

function listItem(record: TemplateRecord): TemplateListItem {
  const template = publicTemplate(record);
  return {
    id: template.id,
    name: template.name,
    status: template.status,
    published_at: template.published_at,
    created_at: template.created_at,
    updated_at: template.updated_at,
    alias: template.alias,
  };
}

function renderValue(
  value: string | undefined,
  variables: Map<string, string | number>,
  escapeHtml = false,
): string | undefined {
  return value?.replace(VARIABLE_PATTERN, (_placeholder, key: string) => {
    const replacement = String(variables.get(key) ?? "");
    return escapeHtml
      ? replacement
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;")
      : replacement;
  });
}

export class TemplateService {
  constructor(private readonly store: Store) {}

  async create(
    input: CreateTemplateInput,
    now = new Date(),
  ): Promise<{ object: "template"; id: string }> {
    const timestamp = now.toISOString();
    const version: TemplateVersion = {
      id: createId("tmplv"),
      name: input.name,
      html: input.html,
      variables: variableRecords(input.variables ?? [], timestamp),
      created_at: timestamp,
      ...(withoutNull(input.text) !== undefined
        ? { text: withoutNull(input.text) }
        : {}),
      ...(withoutNull(input.alias) !== undefined
        ? { alias: withoutNull(input.alias) }
        : {}),
      ...(withoutNull(input.from) !== undefined
        ? { from: withoutNull(input.from) }
        : {}),
      ...(withoutNull(input.subject) !== undefined
        ? { subject: withoutNull(input.subject) }
        : {}),
      ...(withoutNull(input.reply_to) !== undefined
        ? { reply_to: withoutNull(input.reply_to) }
        : {}),
    };
    validateVersion(version);
    const record: TemplateRecord = {
      id: createId("tmpl"),
      created_at: timestamp,
      updated_at: timestamp,
      revision: 1,
      draft: version,
    };
    await this.store.createTemplate(record);
    return { object: "template", id: record.id };
  }

  async get(identifier: string): Promise<PublicTemplate> {
    return publicTemplate(await this.getRecord(identifier));
  }

  async list(
    limit: number,
    after?: string,
    before?: string,
  ): Promise<Page<TemplateListItem>> {
    const cursor = after ?? before;
    const resolvedCursor = cursor
      ? (await this.getRecord(cursor)).id
      : undefined;
    const page = await this.store.listTemplates(
      limit,
      resolvedCursor,
      before ? "before" : "after",
    );
    return { ...page, data: page.data.map(listItem) };
  }

  async update(
    identifier: string,
    input: UpdateTemplateInput,
    now = new Date(),
  ): Promise<{ object: "template"; id: string }> {
    const current = await this.getRecord(identifier);
    const timestamp = now.toISOString();
    const previous = current.draft;
    const draft: TemplateVersion = {
      id: createId("tmplv"),
      name: input.name ?? previous.name,
      html: input.html ?? previous.html,
      variables:
        input.variables === undefined
          ? structuredClone(previous.variables)
          : variableRecords(input.variables, timestamp, previous.variables),
      created_at: timestamp,
      ...this.updatedOptional("text", input, previous),
      ...this.updatedOptional("alias", input, previous),
      ...this.updatedOptional("from", input, previous),
      ...this.updatedOptional("subject", input, previous),
      ...this.updatedOptional("reply_to", input, previous),
    };
    validateVersion(draft);
    const updated: TemplateRecord = {
      ...current,
      draft,
      updated_at: timestamp,
      revision: current.revision + 1,
    };
    const replaced = await this.store.replaceTemplate(
      updated,
      previous.alias,
      current.revision,
    );
    if (!replaced) {
      throw new ConflictError(
        "Template changed concurrently; retry the update.",
      );
    }
    return { object: "template", id: current.id };
  }

  async publish(
    identifier: string,
    now = new Date(),
  ): Promise<{ object: "template"; id: string }> {
    const current = await this.getRecord(identifier);
    if (current.published?.id === current.draft.id) {
      return { object: "template", id: current.id };
    }
    const timestamp = now.toISOString();
    const updated: TemplateRecord = {
      ...current,
      published: structuredClone(current.draft),
      published_at: timestamp,
      updated_at: timestamp,
      revision: current.revision + 1,
    };
    const replaced = await this.store.replaceTemplate(
      updated,
      current.draft.alias,
      current.revision,
    );
    if (!replaced) {
      throw new ConflictError(
        "Template changed concurrently; retry the publish.",
      );
    }
    return { object: "template", id: current.id };
  }

  async duplicate(
    identifier: string,
    now = new Date(),
  ): Promise<{ object: "template"; id: string }> {
    const source = await this.getRecord(identifier);
    const timestamp = now.toISOString();
    const variables = source.draft.variables.map((variable) => ({
      key: variable.key,
      type: variable.type,
      fallback_value: variable.fallback_value,
    }));
    return this.create(
      {
        name: `${source.draft.name} copy`,
        html: source.draft.html,
        ...(source.draft.text !== undefined ? { text: source.draft.text } : {}),
        ...(source.draft.from !== undefined ? { from: source.draft.from } : {}),
        ...(source.draft.subject !== undefined
          ? { subject: source.draft.subject }
          : {}),
        ...(source.draft.reply_to !== undefined
          ? { reply_to: source.draft.reply_to }
          : {}),
        variables,
      },
      new Date(timestamp),
    );
  }

  async delete(
    identifier: string,
  ): Promise<{ object: "template"; id: string; deleted: true }> {
    const current = await this.getRecord(identifier);
    if (!(await this.store.deleteTemplate(current, current.revision))) {
      throw new ConflictError(
        "Template changed concurrently; retry the deletion.",
      );
    }
    return { object: "template", id: current.id, deleted: true };
  }

  async resolveForSend(input: SendEmailInput): Promise<ResolvedSendEmailInput> {
    if (!input.template) {
      if (!input.from || !input.subject) {
        throw new ValidationError("from and subject are required.");
      }
      const { template: _template, ...resolved } = input;
      return { ...resolved, from: input.from, subject: input.subject };
    }
    const record = await this.getRecord(input.template.id);
    const version = record.published;
    if (!version) {
      throw new ValidationError(
        `Template ${input.template.id} is not published.`,
      );
    }
    const provided = input.template.variables ?? {};
    if (Object.keys(provided).length > 50) {
      throw new ValidationError(
        "A template send may provide at most 50 variables.",
      );
    }
    const definitions = new Map(
      version.variables.map((variable) => [variable.key, variable]),
    );
    for (const key of Object.keys(provided)) {
      if (!definitions.has(key)) {
        throw new ValidationError(`Template variable ${key} is not declared.`);
      }
    }
    const values = new Map<string, string | number>();
    for (const variable of version.variables) {
      const value = provided[variable.key] ?? variable.fallback_value;
      if (value === null || value === undefined) {
        throw new ValidationError(
          `Template variable ${variable.key} requires a value.`,
        );
      }
      if (typeof value !== variable.type) {
        throw new ValidationError(
          `Template variable ${variable.key} must be a ${variable.type}.`,
        );
      }
      if (typeof value === "string" && value.length > 2_000) {
        throw new ValidationError(
          `Template variable ${variable.key} must not exceed 2000 characters.`,
        );
      }
      if (
        typeof value === "number" &&
        (!Number.isFinite(value) || !Number.isSafeInteger(value))
      ) {
        throw new ValidationError(
          `Template variable ${variable.key} must be a finite safe integer.`,
        );
      }
      values.set(variable.key, value);
    }
    const from = input.from ?? renderValue(version.from, values);
    const subject = input.subject ?? renderValue(version.subject, values);
    if (!from) {
      throw new ValidationError(
        "from is required because the template has no default sender.",
      );
    }
    if (!subject) {
      throw new ValidationError(
        "subject is required because the template has no default subject.",
      );
    }
    const {
      template: _template,
      from: _from,
      subject: _subject,
      html: _html,
      text: _text,
      reply_to: _replyTo,
      ...rest
    } = input;
    const templateReplyTo = version.reply_to?.map(
      (address) => renderValue(address, values) ?? address,
    );
    const replyTo = input.reply_to ?? templateReplyTo;
    const html = renderValue(version.html, values, true) ?? version.html;
    if (Buffer.byteLength(html, "utf8") > MAX_RENDERED_TEMPLATE_BYTES) {
      throw new ValidationError(
        `Rendered template content must not exceed ${MAX_RENDERED_TEMPLATE_BYTES} bytes.`,
      );
    }
    const text =
      version.text === undefined
        ? convert(html, {
            wordwrap: false,
            limits: {
              ellipsis: "…",
              maxBaseElements: 1,
              maxChildNodes: 50_000,
              maxDepth: 100,
              maxInputLength: MAX_RENDERED_TEMPLATE_BYTES,
            },
          })
        : renderValue(version.text, values);
    if (
      Buffer.byteLength(html, "utf8") + Buffer.byteLength(text ?? "", "utf8") >
      MAX_RENDERED_TEMPLATE_BYTES
    ) {
      throw new ValidationError(
        `Rendered template content must not exceed ${MAX_RENDERED_TEMPLATE_BYTES} bytes.`,
      );
    }
    return {
      ...rest,
      from,
      subject,
      html,
      ...(text !== undefined ? { text } : {}),
      ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
    };
  }

  private async getRecord(identifier: string): Promise<TemplateRecord> {
    const record = await this.store.getTemplate(identifier);
    if (!record) {
      throw new NotFoundError("Template");
    }
    return record;
  }

  private updatedOptional<
    K extends "text" | "alias" | "from" | "subject" | "reply_to",
  >(
    key: K,
    input: UpdateTemplateInput,
    previous: TemplateVersion,
  ): Pick<TemplateVersion, K> | Record<string, never> {
    const value =
      input[key] === undefined ? previous[key] : withoutNull(input[key]);
    return value === undefined
      ? {}
      : ({ [key]: structuredClone(value) } as Pick<TemplateVersion, K>);
  }
}
