import { createHash } from "node:crypto";
import { z } from "zod";
import { readBoundedFile } from "./cli-send-attachments.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMPARISON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SUPPORTED_SEND_FIELDS = new Set([
  "attachments",
  "batch",
  "bcc",
  "cc",
  "from",
  "headers",
  "html",
  "idempotency_key",
  "react",
  "reply_to",
  "scheduled_at",
  "subject",
  "tags",
  "template",
  "text",
  "to",
]);
const SUPPORTED_WEBHOOK_EVENTS = new Set([
  "email.bounced",
  "email.clicked",
  "email.complained",
  "email.delivered",
  "email.delivery_delayed",
  "email.failed",
  "email.opened",
  "email.received",
  "email.scheduled",
  "email.sent",
  "email.suppressed",
]);
const TERMINAL_EVENTS = new Set([
  "bounced",
  "canceled",
  "complained",
  "delivered",
  "failed",
  "suppressed",
]);
const httpsUrlSchema = z.url().refine((value) => value.startsWith("https://"), {
  message: "Evidence references must use HTTPS.",
});

const sdkSchema = z
  .object({
    language: z.string().trim().min(1).max(64),
    package: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const streamSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    criticality: z.enum(["low", "medium", "high", "critical"]),
    daily_volume: z.number().int().nonnegative(),
    required_canary_messages: z.number().int().positive(),
    features: z.array(z.string().trim().min(1).max(64)).min(1),
  })
  .strict();

const transportSchema = z
  .object({
    mode: z.enum(["official_sdk", "http_api", "smtp"]),
    endpoint_switch: z.enum([
      "configuration",
      "application_change",
      "provider_managed",
    ]),
    rollback: z.enum([
      "configuration",
      "deployment",
      "provider_console",
      "unverified",
    ]),
  })
  .strict();

const inventoryInspectionSchema = z
  .object({
    source_reviewed: z.boolean(),
    provider_account_reviewed: z.boolean(),
    observed_at: z.iso.datetime(),
  })
  .strict();

export const resendInventorySchema = z
  .object({
    schema_version: z.union([z.literal(1), z.literal(2)]),
    workload: z
      .object({
        name: z.string().trim().min(1).max(128),
        environment: z.enum(["development", "staging", "production"]),
        estimated_daily_volume: z.number().int().nonnegative(),
      })
      .strict(),
    sdks: z.array(sdkSchema).min(1),
    transport: transportSchema.optional(),
    inspection: inventoryInspectionSchema.optional(),
    features: z
      .object({
        send_fields: z.array(z.string().trim().min(1).max(64)),
        templates: z
          .object({
            used: z.boolean(),
            count: z.number().int().nonnegative(),
          })
          .strict(),
        webhooks: z
          .object({
            events: z.array(z.string().trim().min(1).max(128)),
            verifies_signatures: z.boolean(),
          })
          .strict(),
        suppressions: z
          .object({
            used: z.boolean(),
            estimated_count: z.number().int().nonnegative(),
          })
          .strict(),
        schedules: z
          .object({
            used: z.boolean(),
            maximum_horizon_days: z.number().nonnegative(),
          })
          .strict(),
        inbound: z
          .object({
            used: z.boolean(),
          })
          .strict(),
        marketing: z
          .object({
            used: z.boolean(),
            apis: z.array(z.string().trim().min(1).max(128)),
          })
          .strict(),
      })
      .strict(),
    streams: z.array(streamSchema).min(1),
  })
  .strict()
  .superRefine((inventory, context) => {
    if (inventory.schema_version === 2 && !inventory.transport) {
      context.addIssue({
        code: "custom",
        message: "schema_version 2 requires transport.",
        path: ["transport"],
      });
    }
    if (inventory.schema_version === 2 && !inventory.inspection) {
      context.addIssue({
        code: "custom",
        message: "schema_version 2 requires inspection.",
        path: ["inspection"],
      });
    }
    if (!inventory.features.templates.used && inventory.features.templates.count > 0) {
      context.addIssue({
        code: "custom",
        message: "templates.count must be zero when templates.used is false.",
        path: ["features", "templates", "count"],
      });
    }
    if (
      !inventory.features.suppressions.used &&
      inventory.features.suppressions.estimated_count > 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "suppressions.estimated_count must be zero when suppressions.used is false.",
        path: ["features", "suppressions", "estimated_count"],
      });
    }
    if (
      !inventory.features.schedules.used &&
      inventory.features.schedules.maximum_horizon_days > 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "schedules.maximum_horizon_days must be zero when schedules.used is false.",
        path: ["features", "schedules", "maximum_horizon_days"],
      });
    }
    if (!inventory.features.marketing.used && inventory.features.marketing.apis.length > 0) {
      context.addIssue({
        code: "custom",
        message: "marketing.apis must be empty when marketing.used is false.",
        path: ["features", "marketing", "apis"],
      });
    }
    const names = inventory.streams.map((stream) => stream.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        message: "stream names must be unique.",
        path: ["streams"],
      });
    }
    const requiredFeatures = new Set(inventory.features.send_fields);
    for (const [name, used] of [
      ["templates", inventory.features.templates.used],
      ["webhooks", inventory.features.webhooks.events.length > 0],
      ["suppressions", inventory.features.suppressions.used],
      ["schedules", inventory.features.schedules.used],
      ["inbound", inventory.features.inbound.used],
    ] as const) {
      if (used) {
        requiredFeatures.add(name);
      }
    }
    const coveredFeatures = new Set(
      inventory.streams.flatMap((stream) => stream.features),
    );
    const missingFeatures = [...requiredFeatures].filter(
      (feature) => !coveredFeatures.has(feature),
    );
    if (missingFeatures.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Every used feature must be assigned to a canary stream; missing: ${missingFeatures.join(", ")}.`,
        path: ["streams"],
      });
    }
  });

const streamEvidenceSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    comparison_messages: z.number().int().nonnegative(),
    terminal_event_matches: z.number().int().nonnegative(),
    mailbox_receipts: z.number().int().nonnegative(),
    rollback_rehearsed: z.boolean(),
    verified_features: z.array(z.string().trim().min(1).max(64)),
    evidence_url: httpsUrlSchema,
  })
  .strict();

export const resendEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    observed_at: z.iso.datetime(),
    ses: z
      .object({
        production_access: z.boolean(),
        sending_enabled: z.boolean(),
      })
      .strict(),
    dogfood: z
      .object({
        calendar_days: z.number().int().nonnegative(),
        controlled_notifications: z.number().int().nonnegative(),
      })
      .strict(),
    references: z
      .object({
        ses: httpsUrlSchema,
        dogfood: httpsUrlSchema,
        reconciliation: httpsUrlSchema,
      })
      .strict(),
    reconciliation: z
      .object({
        sdk_contract_verified: z.boolean(),
        source_templates: z.number().int().nonnegative(),
        target_templates: z.number().int().nonnegative(),
        source_suppressions: z.number().int().nonnegative(),
        target_suppressions: z.number().int().nonnegative(),
        webhooks_verified: z.boolean(),
        inbound_verified: z.boolean(),
      })
      .strict(),
    streams: z.array(streamEvidenceSchema),
  })
  .strict()
  .superRefine((evidence, context) => {
    const names = evidence.streams.map((stream) => stream.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        message: "stream evidence names must be unique.",
        path: ["streams"],
      });
    }
    for (const [index, stream] of evidence.streams.entries()) {
      if (stream.terminal_event_matches > stream.comparison_messages) {
        context.addIssue({
          code: "custom",
          message:
            "terminal_event_matches cannot exceed comparison_messages.",
          path: ["streams", index, "terminal_event_matches"],
        });
      }
      if (stream.mailbox_receipts > stream.comparison_messages) {
        context.addIssue({
          code: "custom",
          message: "mailbox_receipts cannot exceed comparison_messages.",
          path: ["streams", index, "mailbox_receipts"],
        });
      }
    }
  });

export type ResendInventory = z.infer<typeof resendInventorySchema>;
export type ResendEvidence = z.infer<typeof resendEvidenceSchema>;

export function assessResendInventory(inventory: ResendInventory) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (inventory.schema_version === 1) {
    blockers.push(
      "Inventory schema_version 1 does not attest the transport or provider-account review; upgrade the inventory to schema_version 2.",
    );
  }
  if (inventory.schema_version === 2) {
    if (!inventory.inspection?.source_reviewed) {
      blockers.push(
        "The application source has not been reviewed for every Resend send path.",
      );
    }
    if (!inventory.inspection?.provider_account_reviewed) {
      blockers.push(
        "The Resend account has not been reviewed for domains, templates, webhooks, suppressions, schedules, inbound, and marketing features.",
      );
    }
    if (inventory.transport?.mode === "smtp") {
      blockers.push(
        "HayaSend exposes the Resend-compatible HTTP API, not an SMTP relay; migrate this stream to a supported HTTP integration or keep its SMTP provider.",
      );
    }
    if (inventory.transport?.endpoint_switch === "application_change") {
      warnings.push(
        "Switching this workload requires an application change; test and deploy that change before the controlled canary.",
      );
    }
    if (inventory.transport?.endpoint_switch === "provider_managed") {
      warnings.push(
        "Switching this workload depends on provider-managed configuration; preserve and rehearse the provider-console rollback.",
      );
    }
    if (inventory.transport?.rollback === "unverified") {
      warnings.push(
        "The rollback mechanism is unverified and must be rehearsed before the migration report can pass.",
      );
    }
  }
  const unsupportedFields = [
    ...new Set(
      inventory.features.send_fields.filter(
        (field) => !SUPPORTED_SEND_FIELDS.has(field),
      ),
    ),
  ].sort();
  const unsupportedWebhookEvents = [
    ...new Set(
      inventory.features.webhooks.events.filter(
        (event) => !SUPPORTED_WEBHOOK_EVENTS.has(event),
      ),
    ),
  ].sort();

  if (unsupportedFields.length > 0) {
    blockers.push(`Unsupported send fields: ${unsupportedFields.join(", ")}.`);
  }
  if (unsupportedWebhookEvents.length > 0) {
    blockers.push(
      `Unsupported webhook events: ${unsupportedWebhookEvents.join(", ")}.`,
    );
  }
  if (
    inventory.features.schedules.used &&
    inventory.features.schedules.maximum_horizon_days > 30
  ) {
    blockers.push("HayaSend schedules are limited to 30 days.");
  }
  if (inventory.features.marketing.used) {
    blockers.push(
      "Resend marketing, contact, audience, and broadcast APIs do not have HayaSend parity.",
    );
  }
  if (
    inventory.features.webhooks.events.length > 0 &&
    !inventory.features.webhooks.verifies_signatures
  ) {
    blockers.push(
      "The workload does not currently verify webhook signatures against the raw request body.",
    );
  }
  if (inventory.features.suppressions.estimated_count > 0) {
    warnings.push(
      "Suppression migration requires a reviewed export/import and exact count reconciliation.",
    );
  }
  if (inventory.features.inbound.used) {
    warnings.push(
      "Inbound receiving requires separate DNS, raw-MIME, forwarding, and rollback evidence.",
    );
  }
  if (
    inventory.sdks.some(
      (sdk) =>
        !["javascript", "typescript", "python"].includes(
          sdk.language.toLowerCase(),
        ),
    )
  ) {
    warnings.push(
      "At least one SDK language is outside the currently automated Node.js/Python compatibility gates.",
    );
  }

  return {
    object: "resend_migration_inventory",
    schema_version: inventory.schema_version,
    workload: inventory.workload,
    inventory_complete:
      inventory.schema_version === 2 &&
      inventory.inspection?.source_reviewed === true &&
      inventory.inspection.provider_account_reviewed === true,
    ...(inventory.transport ? { transport: inventory.transport } : {}),
    ...(inventory.inspection ? { inspection: inventory.inspection } : {}),
    blockers,
    warnings,
    canary_streams: inventory.streams.map((stream) => ({
      name: stream.name,
      criticality: stream.criticality,
      required_canary_messages: stream.required_canary_messages,
      features: stream.features,
    })),
    disposition: blockers.length === 0 ? "CANARY_ELIGIBLE" : "BLOCKED",
  } as const;
}

export function buildResendMigrationReport(
  inventory: ResendInventory,
  evidence: ResendEvidence,
  now = new Date(),
) {
  const assessment = assessResendInventory(inventory);
  const blockers = [...assessment.blockers];
  const checks: Array<{
    gate: string;
    passed: boolean;
    evidence: string;
    reference?: string;
  }> = [];
  const addCheck = (
    gate: string,
    passed: boolean,
    detail: string,
    reference?: string,
  ) => {
    checks.push({
      gate,
      passed,
      evidence: detail,
      ...(reference ? { reference } : {}),
    });
    if (!passed) {
      blockers.push(`${gate}: ${detail}`);
    }
  };

  const observedAt = new Date(evidence.observed_at);
  const ageMilliseconds = now.getTime() - observedAt.getTime();
  addCheck(
    "evidence_freshness",
    ageMilliseconds >= -5 * 60_000 && ageMilliseconds <= 24 * 60 * 60_000,
    "The operational evidence snapshot must be no more than 24 hours old and not more than 5 minutes in the future.",
    evidence.references.reconciliation,
  );
  addCheck(
    "ses_production_access",
    evidence.ses.production_access && evidence.ses.sending_enabled,
    "SES production access and sending must both be enabled (#126).",
    evidence.references.ses,
  );
  addCheck(
    "dogfood",
    evidence.dogfood.calendar_days >= 14 &&
      evidence.dogfood.controlled_notifications >= 1_000,
    `Observed ${evidence.dogfood.calendar_days} days and ${evidence.dogfood.controlled_notifications} controlled notifications; require at least 14 days and 1000 notifications (#105).`,
    evidence.references.dogfood,
  );
  addCheck(
    "sdk_contract",
    evidence.reconciliation.sdk_contract_verified,
    "The exact inventoried SDK versions and send shapes must pass the HayaSend contract suite.",
    evidence.references.reconciliation,
  );
  addCheck(
    "templates",
    !inventory.features.templates.used ||
      (evidence.reconciliation.source_templates ===
        inventory.features.templates.count &&
        evidence.reconciliation.target_templates ===
          inventory.features.templates.count),
    "Source, inventory, and target template counts must match.",
    evidence.references.reconciliation,
  );
  addCheck(
    "suppressions",
    !inventory.features.suppressions.used ||
      (evidence.reconciliation.source_suppressions ===
        inventory.features.suppressions.estimated_count &&
        evidence.reconciliation.target_suppressions ===
          inventory.features.suppressions.estimated_count),
    "Source, inventory, and target suppression counts must match.",
    evidence.references.reconciliation,
  );
  addCheck(
    "webhooks",
    inventory.features.webhooks.events.length === 0 ||
      evidence.reconciliation.webhooks_verified,
    "Every required webhook event and raw-body signature path must be verified.",
    evidence.references.reconciliation,
  );
  addCheck(
    "inbound",
    !inventory.features.inbound.used ||
      evidence.reconciliation.inbound_verified,
    "Inbound DNS, receipt, raw MIME, forwarding, and rollback must be verified.",
    evidence.references.reconciliation,
  );

  const evidenceByStream = new Map(
    evidence.streams.map((stream) => [stream.name, stream]),
  );
  for (const stream of inventory.streams) {
    const result = evidenceByStream.get(stream.name);
    const missingVerifiedFeatures = result
      ? stream.features.filter(
          (feature) => !result.verified_features.includes(feature),
        )
      : stream.features;
    const passed =
      result !== undefined &&
      result.comparison_messages >= stream.required_canary_messages &&
      result.terminal_event_matches === result.comparison_messages &&
      result.mailbox_receipts > 0 &&
      result.rollback_rehearsed &&
      missingVerifiedFeatures.length === 0;
    addCheck(
      `stream:${stream.name}`,
      passed,
      result
        ? `${result.comparison_messages}/${stream.required_canary_messages} comparisons, ${result.terminal_event_matches} terminal matches, ${result.mailbox_receipts} mailbox receipts, rollback_rehearsed=${result.rollback_rehearsed}, missing_verified_features=${missingVerifiedFeatures.join(",") || "none"}.`
        : "No controlled comparison evidence was supplied.",
      result?.evidence_url,
    );
  }

  const passed = blockers.length === 0;
  return {
    object: "resend_migration_go_no_go",
    schema_version: 1,
    generated_at: now.toISOString(),
    observed_at: evidence.observed_at,
    workload: inventory.workload,
    decision: passed ? "GO" : "NO_GO",
    production_ready: passed,
    checks,
    blockers,
    rollback_provider: "Resend",
    critical_mail_disposition: passed
      ? "Eligible for an independently reviewed gradual cutover."
      : "Keep authentication, billing, and recovery mail on Resend.",
  } as const;
}

interface ParsedOptions {
  values: Map<string, string>;
  booleans: Set<string>;
}

function parseOptions(
  args: string[],
  values: string[],
  booleans: string[] = [],
): ParsedOptions {
  const allowedValues = new Set(values);
  const allowedBooleans = new Set(booleans);
  const parsedValues = new Map<string, string>();
  const parsedBooleans = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument ?? ""}`);
    }
    const name = argument.slice(2);
    if (allowedBooleans.has(name)) {
      if (parsedBooleans.has(name)) {
        throw new Error(`Option --${name} may be provided only once.`);
      }
      parsedBooleans.add(name);
      continue;
    }
    if (!allowedValues.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (parsedValues.has(name)) {
      throw new Error(`Option --${name} may be provided only once.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    parsedValues.set(name, value);
    index += 1;
  }
  return { values: parsedValues, booleans: parsedBooleans };
}

function required(options: ParsedOptions, name: string) {
  const value = options.values.get(name);
  if (!value) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

async function jsonFile<T>(
  cwd: string,
  path: string,
  schema: z.ZodType<T>,
  label: string,
) {
  const bytes = await readBoundedFile(cwd, path, MAX_INPUT_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${label} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function endpoint(value: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS.`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replaceAll("/", "") !== ""
  ) {
    throw new Error(
      `${label} must contain only an HTTPS origin without credentials, query, fragment, or path.`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function identifier(value: unknown, provider: string) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256
  ) {
    throw new Error(`${provider} returned an invalid email identifier.`);
  }
  return value.id;
}

async function providerRequest(
  fetcher: typeof fetch,
  provider: string,
  origin: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
) {
  const response = await fetcher(`${origin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    throw new Error(`${provider} request failed with HTTP ${response.status}.`);
  }
  return body;
}

function lastEvent(value: unknown, provider: string) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("last_event" in value) ||
    typeof value.last_event !== "string"
  ) {
    throw new Error(`${provider} returned an invalid lifecycle record.`);
  }
  return value.last_event;
}

async function awaitTerminal(
  fetcher: typeof fetch,
  provider: string,
  origin: string,
  apiKey: string,
  emailId: string,
  timeoutSeconds: number,
  pollSeconds: number,
  sleep: (milliseconds: number) => Promise<void>,
) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let event = "";
  while (Date.now() < deadline) {
    event = lastEvent(
      await providerRequest(
        fetcher,
        provider,
        origin,
        apiKey,
        `/emails/${encodeURIComponent(emailId)}`,
      ),
      provider,
    );
    if (TERMINAL_EVENTS.has(event)) {
      return event;
    }
    await sleep(pollSeconds * 1_000);
  }
  return event || "timeout";
}

export interface ResendMigrationCommandDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  log(message: string): void;
  sleep(milliseconds: number): Promise<void>;
}

async function canaryCommand(
  args: string[],
  dependencies: ResendMigrationCommandDependencies,
) {
  const options = parseOptions(
    args,
    [
      "comparison-id",
      "confirm-hayasend-origin",
      "confirm-recipient-sha256",
      "from",
      "hayasend-endpoint",
      "poll-seconds",
      "subject",
      "timeout-seconds",
      "to-file",
    ],
    ["apply"],
  );
  const comparisonId = required(options, "comparison-id");
  if (!COMPARISON_ID_PATTERN.test(comparisonId)) {
    throw new Error(
      "--comparison-id must be 1-128 URL-safe, human-auditable characters.",
    );
  }
  const recipientBytes = await readBoundedFile(
    dependencies.cwd,
    required(options, "to-file"),
    512,
  );
  const recipient = Buffer.from(recipientBytes).toString("utf8").trim();
  if (!z.email().safeParse(recipient).success) {
    throw new Error("--to-file must contain exactly one valid email address.");
  }
  const recipientSha256 = createHash("sha256")
    .update(recipient.toLowerCase())
    .digest("hex");
  const hayasendEndpoint = endpoint(
    options.values.get("hayasend-endpoint") ??
      dependencies.env.HAYASEND_BASE_URL ??
      "",
    "--hayasend-endpoint",
  );
  const resendEndpoint = "https://api.resend.com";
  const from = required(options, "from");
  const subject =
    options.values.get("subject") ?? "[TEST] HayaSend migration comparison";
  const timeoutSeconds = Number(options.values.get("timeout-seconds") ?? "900");
  const pollSeconds = Number(options.values.get("poll-seconds") ?? "10");
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 60 ||
    timeoutSeconds > 3_600
  ) {
    throw new Error("--timeout-seconds must be an integer from 60 to 3600.");
  }
  if (
    !Number.isInteger(pollSeconds) ||
    pollSeconds < 2 ||
    pollSeconds > 60
  ) {
    throw new Error("--poll-seconds must be an integer from 2 to 60.");
  }

  const plan = {
    object: "resend_migration_canary_plan",
    schema_version: 1,
    mutating: options.booleans.has("apply"),
    comparison_id: comparisonId,
    recipient_sha256: recipientSha256,
    providers: [
      { name: "HayaSend", origin: new URL(hayasendEndpoint).origin },
      { name: "Resend", origin: new URL(resendEndpoint).origin },
    ],
    sends: 2,
    content: "synthetic",
    rollback_provider: "Resend",
  };
  dependencies.log(JSON.stringify(plan));
  if (!options.booleans.has("apply")) {
    return;
  }
  const confirmation = options.values.get("confirm-recipient-sha256");
  if (confirmation !== recipientSha256 || !SHA256_PATTERN.test(confirmation)) {
    throw new Error(
      `Apply requires --confirm-recipient-sha256 ${recipientSha256}.`,
    );
  }
  const confirmedHayasendOrigin = options.values.get(
    "confirm-hayasend-origin",
  );
  const expectedHayasendOrigin = new URL(hayasendEndpoint).origin;
  if (confirmedHayasendOrigin !== expectedHayasendOrigin) {
    throw new Error(
      `Apply requires --confirm-hayasend-origin ${expectedHayasendOrigin}.`,
    );
  }
  const hayasendKey = dependencies.env.HAYASEND_API_KEY;
  const resendKey = dependencies.env.RESEND_API_KEY;
  if (!hayasendKey || !resendKey) {
    throw new Error(
      "Apply requires HAYASEND_API_KEY and RESEND_API_KEY in the environment.",
    );
  }
  const payload = {
    from,
    to: [recipient],
    subject,
    text:
      "Synthetic dual-provider migration canary. No customer content is included.",
    headers: {
      "X-HayaSend-Migration-Comparison": comparisonId,
    },
    tags: [{ name: "migration", value: "controlled_canary" }],
  };
  const sendWithFetcher = async (
    provider: string,
    origin: string,
    key: string,
    suffix: string,
  ) =>
    identifier(
      await providerRequest(
        dependencies.fetch,
        provider,
        origin,
        key,
        "/emails",
        {
          method: "POST",
          headers: {
            "idempotency-key": `migration/${comparisonId}/${suffix}`,
          },
          body: JSON.stringify(payload),
        },
      ),
      provider,
    );

  const hayasendId = await sendWithFetcher(
    "HayaSend",
    hayasendEndpoint,
    hayasendKey,
    "hayasend",
  );
  const resendId = await sendWithFetcher(
    "Resend",
    resendEndpoint,
    resendKey,
    "resend",
  );
  const [hayasendEvent, resendEvent] = await Promise.all([
    awaitTerminal(
      dependencies.fetch,
      "HayaSend",
      hayasendEndpoint,
      hayasendKey,
      hayasendId,
      timeoutSeconds,
      pollSeconds,
      dependencies.sleep,
    ),
    awaitTerminal(
      dependencies.fetch,
      "Resend",
      resendEndpoint,
      resendKey,
      resendId,
      timeoutSeconds,
      pollSeconds,
      dependencies.sleep,
    ),
  ]);
  dependencies.log(
    JSON.stringify({
      object: "resend_migration_canary_result",
      schema_version: 1,
      ok:
        TERMINAL_EVENTS.has(hayasendEvent) &&
        TERMINAL_EVENTS.has(resendEvent) &&
        hayasendEvent === resendEvent,
      comparison_id: comparisonId,
      recipient_sha256: recipientSha256,
      results: [
        { provider: "HayaSend", email_id: hayasendId, last_event: hayasendEvent },
        { provider: "Resend", email_id: resendId, last_event: resendEvent },
      ],
      terminal_event_match: hayasendEvent === resendEvent,
      mailbox_receipt_verified: false,
      rollback_provider: "Resend",
      next:
        "Verify both mailbox receipts, record latency and rendering differences, then rehearse routing 100% back to Resend.",
    }),
  );
}

export async function resendMigrationCommand(
  args: string[],
  dependencies: ResendMigrationCommandDependencies,
) {
  if (args[0] !== "resend") {
    throw new Error("Migration provider must be resend.");
  }
  const command = args[1] ?? "help";
  const commandArgs = [command, ...args.slice(2)];
  switch (command) {
    case "inventory": {
      const options = parseOptions(commandArgs, ["file"]);
      const inventory = await jsonFile(
        dependencies.cwd,
        required(options, "file"),
        resendInventorySchema,
        "Resend inventory",
      );
      dependencies.log(JSON.stringify(assessResendInventory(inventory), null, 2));
      break;
    }
    case "report": {
      const options = parseOptions(commandArgs, ["evidence", "inventory"]);
      const inventory = await jsonFile(
        dependencies.cwd,
        required(options, "inventory"),
        resendInventorySchema,
        "Resend inventory",
      );
      const evidence = await jsonFile(
        dependencies.cwd,
        required(options, "evidence"),
        resendEvidenceSchema,
        "Resend migration evidence",
      );
      dependencies.log(
        JSON.stringify(buildResendMigrationReport(inventory, evidence), null, 2),
      );
      break;
    }
    case "canary":
      await canaryCommand(commandArgs, dependencies);
      break;
    default:
      throw new Error(
        `Unknown Resend migration command: ${command}. Run hayasend help.`,
      );
  }
}
