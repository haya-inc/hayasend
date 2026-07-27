import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024;
const SHORT_COMMAND_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const DEPLOY_TIMEOUT_MS = 15 * 60_000;
const STACK_TIMEOUT_MS = 35 * 60_000;
const LOG_RETENTION_DAYS = new Set([
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
]);

const TEMPLATE_DEFAULTS: Record<string, string> = {
  BootstrapSecretArn: "",
  ApiThrottlingRateLimit: "10",
  ApiThrottlingBurstLimit: "20",
  LogRetentionDays: "30",
  EnableInbound: "false",
  InboundRetentionDays: "7",
  InboundMaxMessageSizeBytes: "26214400",
  InboundRecipientSuffixes: "@example.invalid",
  InboundTlsPolicy: "OPTIONAL",
  WebhookDeliveryRetentionDays: "7",
  TemplateHistoryRetentionDays: "90",
  TemplateHistoryLimit: "50",
  WorkerReservedConcurrency: "10",
};

const LEGACY_STACK_DEFAULTS: Record<string, string> = {
  ApiThrottlingRateLimit: "50",
  ApiThrottlingBurstLimit: "100",
};

const OUTPUT_KEYS = [
  "ApiBaseUrl",
  "BootstrapSecretArn",
  "AlarmTopicArn",
  "OperationsDashboardName",
  "InboundMxRecord",
] as const;

const STABLE_STACK_STATUSES = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
]);

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>;

export interface AwsDeployOptions {
  account: string;
  region?: string;
  stack?: string;
  profile?: string;
  apply: boolean;
  allowDestructiveChanges: boolean;
  enableInbound?: boolean;
  bootstrapSecretArn?: string;
  apiRateLimit?: string;
  apiBurstLimit?: string;
  logRetentionDays?: string;
  inboundRetentionDays?: string;
  inboundMaxMessageBytes?: string;
  inboundRecipientSuffixes?: string;
  inboundTlsPolicy?: string;
  webhookRetentionDays?: string;
  templateHistoryRetentionDays?: string;
  templateHistoryLimit?: string;
  workerReservedConcurrency?: string;
  tags: string[];
}

export interface AwsDeployDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  runCommand: CommandRunner;
}

interface NormalizedOptions {
  account: string;
  region: string;
  stack: string;
  profile?: string;
  apply: boolean;
  allowDestructiveChanges: boolean;
  explicitParameters: Record<string, string>;
  tags: Array<{ key: string; value: string }>;
}

interface StackDescription {
  exists: boolean;
  status?: string;
  parameters: Record<string, string>;
  outputs: Record<string, string>;
  tags: Record<string, string>;
}

interface ResourceChange {
  action: string;
  logical_resource_id: string;
  resource_type: string;
  replacement: string;
  scope: string[];
  policy_action: string | null;
}

interface ChangeSetDescription {
  ChangeSetId?: unknown;
  StackName?: unknown;
  ExecutionStatus?: unknown;
  Status?: unknown;
  StatusReason?: unknown;
  Changes?: Array<{
    ResourceChange?: {
      Action?: unknown;
      LogicalResourceId?: unknown;
      ResourceType?: unknown;
      Replacement?: unknown;
      Scope?: unknown;
      PolicyAction?: unknown;
    };
  }>;
}

export const defaultCommandRunner: CommandRunner = (
  command,
  args,
  { cwd, env = process.env, timeoutMs = SHORT_COMMAND_TIMEOUT_MS },
) =>
  new Promise((resolveResult) => {
    execFile(
      command,
      args,
      {
        cwd,
        env,
        maxBuffer: COMMAND_OUTPUT_LIMIT,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof error.code === "number"
            ? error.code
            : error
              ? 127
              : 0;
        resolveResult({
          exitCode: code,
          stdout: String(stdout),
          stderr: error && !stderr ? error.message : String(stderr),
        });
      },
    );
  });

export function redactAwsDiagnostics(value: string) {
  return value
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\b(?:re|whsec)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_SECRET]")
    .replace(
      /((?:aws_secret_access_key|aws_session_token|secretstring|authorization)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 4_000);
}

function requireInteger(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return String(number);
}

function requireNumber(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) {
    return undefined;
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a plain decimal number.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return String(number);
}

function parseTags(values: string[]) {
  const tags = new Map<string, string>([
    ["Project", "HayaSend"],
    ["ManagedBy", "HayaSendCLI"],
  ]);
  for (const value of values) {
    const separator = value.indexOf("=");
    const key = separator > 0 ? value.slice(0, separator) : "";
    const tagValue = separator > 0 ? value.slice(separator + 1) : "";
    if (
      !/^[A-Za-z0-9 _.:/=+\-@]{1,128}$/.test(key) ||
      tagValue.length > 256 ||
      !/^[A-Za-z0-9 _.:/=+\-@]*$/.test(tagValue)
    ) {
      throw new Error(
        "--tag must use KEY=VALUE with AWS-safe characters and lengths.",
      );
    }
    if (key.toLowerCase().startsWith("aws:")) {
      throw new Error("--tag cannot use the reserved aws: prefix.");
    }
    if (tags.has(key)) {
      throw new Error(`Duplicate or reserved tag key: ${key}`);
    }
    tags.set(key, tagValue);
  }
  return [...tags].map(([key, value]) => ({ key, value }));
}

function validRecipientDomain(domain: string) {
  if (domain.length > 253) {
    return false;
  }
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
    ) &&
    /^[A-Za-z]{2,63}$/.test(labels.at(-1) ?? "")
  );
}

function validateRecipientSuffixes(value: string) {
  const suffixes = value.split(",");
  if (
    suffixes.length < 1 ||
    suffixes.length > 10 ||
    suffixes.some(
      (suffix) =>
        !suffix.startsWith("@") || !validRecipientDomain(suffix.slice(1)),
    )
  ) {
    throw new Error(
      "--inbound-recipient-suffixes must contain 1-10 comma-separated @domain suffixes.",
    );
  }
}

function normalizeOptions(
  options: AwsDeployOptions,
  env: NodeJS.ProcessEnv,
): NormalizedOptions {
  if (!/^\d{12}$/.test(options.account)) {
    throw new Error("--account must be the expected 12-digit AWS account ID.");
  }
  const region = options.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!region || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)) {
    throw new Error(
      "--region or AWS_REGION must contain a valid AWS Region name.",
    );
  }
  const stack = options.stack ?? "hayasend";
  if (!/^[A-Za-z][-A-Za-z0-9]{0,127}$/.test(stack)) {
    throw new Error(
      "--stack must be a valid CloudFormation stack name of at most 128 characters.",
    );
  }
  if (
    options.profile &&
    !/^[A-Za-z0-9_+=,.@-]{1,128}$/.test(options.profile)
  ) {
    throw new Error("--profile contains unsupported characters.");
  }
  if (options.allowDestructiveChanges && !options.apply) {
    throw new Error("--allow-destructive-changes requires --apply.");
  }

  const explicitParameters: Record<string, string> = {};
  if (options.bootstrapSecretArn !== undefined) {
    explicitParameters.BootstrapSecretArn = options.bootstrapSecretArn;
  }
  const apiRateLimit = requireNumber(
    options.apiRateLimit,
    "--api-rate-limit",
    1,
    10_000,
  );
  if (apiRateLimit) {
    explicitParameters.ApiThrottlingRateLimit = apiRateLimit;
  }
  const apiBurstLimit = requireInteger(
    options.apiBurstLimit,
    "--api-burst-limit",
    1,
    5_000,
  );
  if (apiBurstLimit) {
    explicitParameters.ApiThrottlingBurstLimit = apiBurstLimit;
  }
  if (options.enableInbound !== undefined) {
    explicitParameters.EnableInbound = String(options.enableInbound);
  }
  const logRetention = requireInteger(
    options.logRetentionDays,
    "--log-retention-days",
    1,
    3653,
  );
  if (
    logRetention !== undefined &&
    !LOG_RETENTION_DAYS.has(Number(logRetention))
  ) {
    throw new Error(
      "--log-retention-days must be a supported CloudWatch Logs retention value.",
    );
  }
  if (logRetention) {
    explicitParameters.LogRetentionDays = logRetention;
  }
  const inboundRetention = requireInteger(
    options.inboundRetentionDays,
    "--inbound-retention-days",
    1,
    30,
  );
  if (inboundRetention) {
    explicitParameters.InboundRetentionDays = inboundRetention;
  }
  const inboundMaxBytes = requireInteger(
    options.inboundMaxMessageBytes,
    "--inbound-max-message-bytes",
    1,
    41_943_040,
  );
  if (inboundMaxBytes) {
    explicitParameters.InboundMaxMessageSizeBytes = inboundMaxBytes;
  }
  if (options.inboundRecipientSuffixes !== undefined) {
    validateRecipientSuffixes(options.inboundRecipientSuffixes);
    explicitParameters.InboundRecipientSuffixes =
      options.inboundRecipientSuffixes;
  }
  if (options.inboundTlsPolicy !== undefined) {
    if (!["OPTIONAL", "REQUIRED", "FIPS"].includes(options.inboundTlsPolicy)) {
      throw new Error(
        "--inbound-tls-policy must be OPTIONAL, REQUIRED, or FIPS.",
      );
    }
    explicitParameters.InboundTlsPolicy = options.inboundTlsPolicy;
  }
  const webhookRetention = requireInteger(
    options.webhookRetentionDays,
    "--webhook-retention-days",
    1,
    30,
  );
  if (webhookRetention) {
    explicitParameters.WebhookDeliveryRetentionDays = webhookRetention;
  }
  const templateHistoryRetention = requireInteger(
    options.templateHistoryRetentionDays,
    "--template-history-retention-days",
    1,
    365,
  );
  if (templateHistoryRetention) {
    explicitParameters.TemplateHistoryRetentionDays =
      templateHistoryRetention;
  }
  const templateHistoryLimit = requireInteger(
    options.templateHistoryLimit,
    "--template-history-limit",
    1,
    50,
  );
  if (templateHistoryLimit) {
    explicitParameters.TemplateHistoryLimit = templateHistoryLimit;
  }
  const workerReservedConcurrency = requireInteger(
    options.workerReservedConcurrency,
    "--worker-reserved-concurrency",
    0,
    1000,
  );
  if (workerReservedConcurrency !== undefined) {
    explicitParameters.WorkerReservedConcurrency =
      workerReservedConcurrency;
  }

  return {
    account: options.account,
    region,
    stack,
    ...(options.profile ? { profile: options.profile } : {}),
    apply: options.apply,
    allowDestructiveChanges: options.allowDestructiveChanges,
    explicitParameters,
    tags: parseTags(options.tags),
  };
}

function awsArgs(
  options: NormalizedOptions,
  serviceArgs: string[],
  includeRegion = true,
) {
  return [
    ...serviceArgs,
    ...(includeRegion ? ["--region", options.region] : []),
    ...(options.profile ? ["--profile", options.profile] : []),
    "--output",
    "json",
    "--no-cli-pager",
  ];
}

function samArgs(options: NormalizedOptions, commandArgs: string[]) {
  return [
    ...commandArgs,
    ...(options.profile ? ["--profile", options.profile] : []),
    "--region",
    options.region,
  ];
}

async function requireCommand(
  dependencies: AwsDeployDependencies,
  command: string,
  args: string[],
  label: string,
  timeoutMs = SHORT_COMMAND_TIMEOUT_MS,
) {
  const result = await dependencies.runCommand(command, args, {
    cwd: dependencies.cwd,
    env: dependencies.env,
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    const details = redactAwsDiagnostics(result.stderr || result.stdout);
    throw new Error(
      `${label} failed with exit code ${result.exitCode}${details ? `: ${details}` : "."}`,
    );
  }
  return result;
}

async function requireJson<T>(
  dependencies: AwsDeployDependencies,
  command: string,
  args: string[],
  label: string,
  timeoutMs = SHORT_COMMAND_TIMEOUT_MS,
) {
  const result = await requireCommand(
    dependencies,
    command,
    args,
    label,
    timeoutMs,
  );
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function commandVersion(result: CommandResult, label: string) {
  const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
  if (!version) {
    throw new Error(`${label} did not report a version.`);
  }
  return version.slice(0, 200);
}

function stackDoesNotExist(result: CommandResult) {
  const diagnostics = `${result.stdout}\n${result.stderr}`;
  return (
    result.exitCode !== 0 &&
    /ValidationError/i.test(diagnostics) &&
    /does not exist/i.test(diagnostics)
  );
}

function readParameters(
  parameters: Array<{ ParameterKey?: unknown; ParameterValue?: unknown }> = [],
) {
  const result: Record<string, string> = {};
  for (const parameter of parameters) {
    if (
      typeof parameter.ParameterKey === "string" &&
      typeof parameter.ParameterValue === "string"
    ) {
      result[parameter.ParameterKey] = parameter.ParameterValue;
    }
  }
  return result;
}

function readOutputs(
  outputs: Array<{ OutputKey?: unknown; OutputValue?: unknown }> = [],
) {
  const allowed = new Set<string>(OUTPUT_KEYS);
  const result: Record<string, string> = {};
  for (const output of outputs) {
    if (
      typeof output.OutputKey === "string" &&
      allowed.has(output.OutputKey) &&
      typeof output.OutputValue === "string"
    ) {
      result[output.OutputKey] = output.OutputValue;
    }
  }
  return result;
}

function readTags(tags: Array<{ Key?: unknown; Value?: unknown }> = []) {
  const result: Record<string, string> = {};
  for (const tag of tags) {
    if (
      typeof tag.Key === "string" &&
      !tag.Key.toLowerCase().startsWith("aws:") &&
      typeof tag.Value === "string"
    ) {
      result[tag.Key] = tag.Value;
    }
  }
  return result;
}

async function describeStack(
  dependencies: AwsDeployDependencies,
  options: NormalizedOptions,
): Promise<StackDescription> {
  const result = await dependencies.runCommand(
    "aws",
    awsArgs(options, [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      options.stack,
    ]),
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
    },
  );
  if (stackDoesNotExist(result)) {
    return { exists: false, parameters: {}, outputs: {}, tags: {} };
  }
  if (result.exitCode !== 0) {
    const details = redactAwsDiagnostics(result.stderr || result.stdout);
    throw new Error(`Unable to inspect the existing stack: ${details}`);
  }
  let value: {
    Stacks?: Array<{
      StackStatus?: unknown;
      Parameters?: Array<{
        ParameterKey?: unknown;
        ParameterValue?: unknown;
      }>;
      Outputs?: Array<{ OutputKey?: unknown; OutputValue?: unknown }>;
      Tags?: Array<{ Key?: unknown; Value?: unknown }>;
    }>;
  };
  try {
    value = JSON.parse(result.stdout) as typeof value;
  } catch {
    throw new Error("CloudFormation returned invalid stack JSON.");
  }
  const stack = value.Stacks?.[0];
  if (!stack || typeof stack.StackStatus !== "string") {
    throw new Error("CloudFormation did not return the requested stack.");
  }
  return {
    exists: true,
    status: stack.StackStatus,
    parameters: readParameters(stack.Parameters),
    outputs: readOutputs(stack.Outputs),
    tags: readTags(stack.Tags),
  };
}

function validateBootstrapSecret(
  value: string,
  options: NormalizedOptions,
) {
  if (value === "") {
    return;
  }
  const match =
    /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:([^:]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/.exec(
      value,
    );
  if (!match || match[1] !== options.region || match[2] !== options.account) {
    throw new Error(
      "BootstrapSecretArn must name a Secrets Manager secret in the expected account and Region.",
    );
  }
  const expectedPartition = options.region.startsWith("cn-")
    ? "aws-cn"
    : options.region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  if (!value.startsWith(`arn:${expectedPartition}:`)) {
    throw new Error(
      "BootstrapSecretArn must use the AWS partition for the expected Region.",
    );
  }
}

function effectiveParameters(
  options: NormalizedOptions,
  stack: StackDescription,
) {
  const parameters = {
    ...TEMPLATE_DEFAULTS,
    ...(stack.exists ? LEGACY_STACK_DEFAULTS : {}),
    ...Object.fromEntries(
      Object.entries(stack.parameters).filter(([key]) =>
        Object.hasOwn(TEMPLATE_DEFAULTS, key),
      ),
    ),
    ...options.explicitParameters,
  };
  validateBootstrapSecret(parameters.BootstrapSecretArn ?? "", options);
  if (parameters.EnableInbound === "true") {
    const suffixes = (parameters.InboundRecipientSuffixes ?? "").split(",");
    if (
      suffixes.some((suffix) => {
        const domain = suffix.slice(1).toLowerCase();
        return domain === "invalid" || domain.endsWith(".invalid");
      })
    ) {
      throw new Error(
        "Inbound receiving requires explicit non-.invalid recipient suffixes.",
      );
    }
  }
  return parameters;
}

function effectiveTags(
  options: NormalizedOptions,
  stack: StackDescription,
) {
  const tags = new Map(Object.entries(stack.tags));
  for (const tag of options.tags) {
    tags.set(tag.key, tag.value);
  }
  if (tags.size > 50) {
    throw new Error(
      "The deployment would exceed CloudFormation's 50-tag stack limit.",
    );
  }
  return [...tags].map(([key, value]) => ({ key, value }));
}

function applyCommand(
  options: NormalizedOptions,
  parameters: Record<string, string>,
  tags: Array<{ key: string; value: string }>,
) {
  return [
    "npm",
    "run",
    "cli",
    "--",
    "deploy",
    "aws",
    "--account",
    options.account,
    "--region",
    options.region,
    "--stack",
    options.stack,
    "--api-rate-limit",
    parameters.ApiThrottlingRateLimit ?? "10",
    "--api-burst-limit",
    parameters.ApiThrottlingBurstLimit ?? "20",
    ...(options.profile ? ["--profile", options.profile] : []),
    ...(parameters.EnableInbound === "true"
      ? [
          "--enable-inbound",
          "--inbound-recipient-suffixes",
          parameters.InboundRecipientSuffixes ?? "",
        ]
      : ["--disable-inbound"]),
    "--log-retention-days",
    parameters.LogRetentionDays ?? "30",
    "--inbound-retention-days",
    parameters.InboundRetentionDays ?? "7",
    "--inbound-max-message-bytes",
    parameters.InboundMaxMessageSizeBytes ?? "26214400",
    "--inbound-tls-policy",
    parameters.InboundTlsPolicy ?? "OPTIONAL",
    "--webhook-retention-days",
    parameters.WebhookDeliveryRetentionDays ?? "7",
    "--template-history-retention-days",
    parameters.TemplateHistoryRetentionDays ?? "90",
    "--template-history-limit",
    parameters.TemplateHistoryLimit ?? "50",
    "--worker-reserved-concurrency",
    parameters.WorkerReservedConcurrency ?? "10",
    ...(parameters.BootstrapSecretArn
      ? ["--bootstrap-secret-arn", parameters.BootstrapSecretArn]
      : []),
    ...tags.flatMap(({ key, value }) =>
      key === "Project" || key === "ManagedBy"
        ? []
        : ["--tag", `${key}=${value}`],
    ),
    "--apply",
  ];
}

function bootstrapKeyCommand(
  options: NormalizedOptions,
  bootstrapSecretArn: string,
) {
  return [
    "aws",
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    bootstrapSecretArn,
    "--query",
    "SecretString",
    "--region",
    options.region,
    ...(options.profile ? ["--profile", options.profile] : []),
    "--output",
    "text",
    "--no-cli-pager",
  ];
}

function changeSetIds(value: {
  Summaries?: Array<{ ChangeSetId?: unknown; Status?: unknown }>;
}) {
  return new Set(
    (value.Summaries ?? [])
      .filter(
        (summary) =>
          typeof summary.ChangeSetId === "string" &&
          summary.Status !== "DELETE_COMPLETE",
      )
      .map((summary) => summary.ChangeSetId as string),
  );
}

async function listChangeSets(
  dependencies: AwsDeployDependencies,
  options: NormalizedOptions,
  allowMissingStack: boolean,
) {
  const result = await dependencies.runCommand(
    "aws",
    awsArgs(options, [
      "cloudformation",
      "list-change-sets",
      "--stack-name",
      options.stack,
    ]),
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
    },
  );
  if (allowMissingStack && stackDoesNotExist(result)) {
    return new Set<string>();
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to list CloudFormation change sets: ${redactAwsDiagnostics(
        result.stderr || result.stdout,
      )}`,
    );
  }
  try {
    return changeSetIds(JSON.parse(result.stdout) as Parameters<
      typeof changeSetIds
    >[0]);
  } catch {
    throw new Error("CloudFormation returned invalid change-set list JSON.");
  }
}

function validateChangeSetIdentity(
  value: ChangeSetDescription,
  changeSetId: string,
  options: NormalizedOptions,
) {
  const match =
    /^arn:[-a-z0-9]+:cloudformation:([^:]+):(\d{12}):changeSet\/[^/]+\/[^/]+$/.exec(
      changeSetId,
    );
  if (
    !match ||
    match[1] !== options.region ||
    match[2] !== options.account ||
    value.ChangeSetId !== changeSetId ||
    value.StackName !== options.stack
  ) {
    throw new Error(
      "CloudFormation returned a change set outside the expected account, Region, or stack.",
    );
  }
  if (value.ExecutionStatus !== "AVAILABLE") {
    throw new Error(
      `CloudFormation change set is not executable: ${String(
        value.ExecutionStatus ?? "unknown",
      )}.`,
    );
  }
}

function summarizeChanges(value: ChangeSetDescription) {
  if (value.Status !== "CREATE_COMPLETE") {
    throw new Error(
      `CloudFormation change set is not ready: ${
        typeof value.StatusReason === "string"
          ? redactAwsDiagnostics(value.StatusReason)
          : String(value.Status ?? "unknown")
      }`,
    );
  }
  const changes: ResourceChange[] = [];
  for (const item of value.Changes ?? []) {
    const change = item.ResourceChange;
    if (
      !change ||
      typeof change.Action !== "string" ||
      typeof change.LogicalResourceId !== "string" ||
      typeof change.ResourceType !== "string"
    ) {
      throw new Error("CloudFormation returned an invalid resource change.");
    }
    changes.push({
      action: change.Action,
      logical_resource_id: change.LogicalResourceId,
      resource_type: change.ResourceType,
      replacement:
        typeof change.Replacement === "string" &&
        ["True", "False", "Conditional"].includes(change.Replacement)
          ? change.Replacement
          : change.Action === "Modify" || change.Action === "Dynamic"
            ? "Unknown"
            : "False",
      scope: Array.isArray(change.Scope)
        ? change.Scope.filter((scope): scope is string => typeof scope === "string")
        : [],
      policy_action:
        typeof change.PolicyAction === "string" ? change.PolicyAction : null,
    });
  }
  return changes;
}

function destructiveChanges(changes: ResourceChange[]) {
  return changes.filter(
    (change) =>
      !["Add", "Modify", "Import", "SyncWithActual"].includes(change.action) ||
      change.replacement !== "False" ||
      (change.policy_action !== null &&
        !["Retain", "Snapshot"].includes(change.policy_action)),
  );
}

async function recentFailureEvents(
  dependencies: AwsDeployDependencies,
  options: NormalizedOptions,
) {
  const result = await dependencies.runCommand(
    "aws",
    awsArgs(options, [
      "cloudformation",
      "describe-stack-events",
      "--stack-name",
      options.stack,
      "--query",
      "StackEvents[?ResourceStatusReason!=null].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason] | [:20]",
    ]),
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
    },
  );
  return result.exitCode === 0
    ? redactAwsDiagnostics(result.stdout)
    : "CloudFormation events were unavailable.";
}

export async function deployAws(
  rawOptions: AwsDeployOptions,
  dependencies: AwsDeployDependencies,
) {
  const options = normalizeOptions(rawOptions, dependencies.env);
  const templatePath = resolve(dependencies.cwd, "template.yaml");
  const template = await readFile(templatePath, "utf8").catch(() => {
    throw new Error(
      "template.yaml is required in the working directory. Run this command from a HayaSend checkout.",
    );
  });

  const awsVersionResult = await requireCommand(
    dependencies,
    "aws",
    ["--version"],
    "AWS CLI",
  );
  const samVersionResult = await requireCommand(
    dependencies,
    "sam",
    ["--version"],
    "AWS SAM CLI",
  );
  const identity = await requireJson<{ Account?: unknown; Arn?: unknown }>(
    dependencies,
    "aws",
    awsArgs(
      options,
      ["sts", "get-caller-identity"],
      false,
    ),
    "AWS caller identity",
  );
  if (
    identity.Account !== options.account ||
    typeof identity.Arn !== "string"
  ) {
    throw new Error(
      `AWS caller account ${String(identity.Account ?? "unknown")} does not match --account.`,
    );
  }
  const ses = await requireJson<{
    ProductionAccessEnabled?: unknown;
    SendingEnabled?: unknown;
    EnforcementStatus?: unknown;
    SendQuota?: {
      Max24HourSend?: unknown;
      MaxSendRate?: unknown;
      SentLast24Hours?: unknown;
    };
  }>(
    dependencies,
    "aws",
    awsArgs(options, ["sesv2", "get-account"]),
    "SES account preflight",
  );
  const stack = await describeStack(dependencies, options);
  if (
    stack.exists &&
    (!stack.status || !STABLE_STACK_STATUSES.has(stack.status))
  ) {
    throw new Error(
      `Stack ${options.stack} is in ${stack.status ?? "an unknown state"}; recover it before deploying.`,
    );
  }
  const parameters = effectiveParameters(options, stack);
  const tags = effectiveTags(options, stack);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "hayasend-deploy-"));
  try {
    const emptyConfig = join(temporaryDirectory, "samconfig.toml");
    const buildDirectory = join(temporaryDirectory, "build");
    await writeFile(emptyConfig, "", { encoding: "utf8", mode: 0o600 });
    const configArgs = [
      "--config-file",
      emptyConfig,
      "--config-env",
      "hayasend-cli",
    ];
    await requireCommand(
      dependencies,
      "sam",
      samArgs(options, [
        "validate",
        "--lint",
        "--template-file",
        templatePath,
        ...configArgs,
      ]),
      "SAM template validation",
      BUILD_TIMEOUT_MS,
    );
    await requireCommand(
      dependencies,
      "sam",
      samArgs(options, [
        "build",
        "--parallel",
        "--template-file",
        templatePath,
        "--build-dir",
        buildDirectory,
        ...configArgs,
      ]),
      "SAM build",
      BUILD_TIMEOUT_MS,
    );

    dependencies.log(
      JSON.stringify(
        {
          schema_version: 1,
          object: "aws_deployment_plan",
          ok: true,
          mutating: options.apply,
          mode: options.apply ? "apply" : "plan",
          tools: {
            aws_cli: commandVersion(awsVersionResult, "AWS CLI"),
            sam_cli: commandVersion(samVersionResult, "AWS SAM CLI"),
          },
          identity: {
            account: identity.Account,
            principal_arn: identity.Arn,
          },
          region: options.region,
          stack: {
            name: options.stack,
            exists: stack.exists,
            status: stack.status ?? null,
          },
          ses: {
            production_access: ses.ProductionAccessEnabled === true,
            sending_enabled: ses.SendingEnabled === true,
            enforcement_status:
              typeof ses.EnforcementStatus === "string"
                ? ses.EnforcementStatus
                : null,
            quota: {
              max_24_hour_send: ses.SendQuota?.Max24HourSend ?? null,
              max_send_rate: ses.SendQuota?.MaxSendRate ?? null,
              sent_last_24_hours: ses.SendQuota?.SentLast24Hours ?? null,
            },
          },
          template: {
            path: templatePath,
            sha256: createHash("sha256").update(template).digest("hex"),
            validation: "pass",
            build: "pass",
          },
          parameters,
          tags: Object.fromEntries(tags.map(({ key, value }) => [key, value])),
          dns_changes: "never",
          ...(options.apply
            ? {}
            : { apply_command: applyCommand(options, parameters, tags) }),
        },
      ),
    );

    if (!options.apply) {
      return;
    }

    const before = await listChangeSets(
      dependencies,
      options,
      !stack.exists,
    );
    const deployArguments = samArgs(options, [
      "deploy",
      "--template-file",
      join(buildDirectory, "template.yaml"),
      "--stack-name",
      options.stack,
      "--resolve-s3",
      "--s3-prefix",
      `hayasend/${options.stack}`,
      "--capabilities",
      "CAPABILITY_IAM",
      "--no-confirm-changeset",
      "--no-execute-changeset",
      "--no-fail-on-empty-changeset",
      "--no-progressbar",
      "--parameter-overrides",
      ...Object.entries(parameters)
        .filter(([key, value]) => key !== "BootstrapSecretArn" || value !== "")
        .map(([key, value]) => `${key}=${value}`),
      "--tags",
      ...tags.map(({ key, value }) => `${key}=${value}`),
      ...configArgs,
    ]);
    await requireCommand(
      dependencies,
      "sam",
      deployArguments,
      "SAM change-set creation",
      DEPLOY_TIMEOUT_MS,
    );
    const after = await listChangeSets(dependencies, options, false);
    const created = [...after].filter((id) => !before.has(id));
    if (created.length === 0) {
      dependencies.log(
        JSON.stringify(
          {
            schema_version: 1,
            object: "aws_deployment_result",
            ok: true,
            applied: false,
            no_changes: true,
            stack: options.stack,
            outputs: stack.outputs,
          },
        ),
      );
      return;
    }
    if (created.length !== 1) {
      throw new Error(
        "Expected exactly one new CloudFormation change set; concurrent deployment activity was detected.",
      );
    }
    const changeSetId = created[0] as string;
    const described = await requireJson<ChangeSetDescription>(
      dependencies,
      "aws",
      awsArgs(options, [
        "cloudformation",
        "describe-change-set",
        "--change-set-name",
        changeSetId,
      ]),
      "CloudFormation change-set inspection",
    );
    validateChangeSetIdentity(described, changeSetId, options);
    const changes = summarizeChanges(described);
    const destructive = destructiveChanges(changes);
    dependencies.log(
      JSON.stringify(
        {
          schema_version: 1,
          object: "aws_change_set_plan",
          ok: destructive.length === 0 || options.allowDestructiveChanges,
          stack: options.stack,
          change_set_id: changeSetId,
          changes,
          destructive_changes: destructive,
          requires_destructive_acknowledgement: destructive.length > 0,
        },
      ),
    );
    if (destructive.length > 0 && !options.allowDestructiveChanges) {
      throw new Error(
        "CloudFormation proposed removals or possible replacements. The change set was not executed; inspect it and rerun with --allow-destructive-changes only if every destructive change is intended.",
      );
    }
    await requireCommand(
      dependencies,
      "aws",
      awsArgs(options, [
        "cloudformation",
        "execute-change-set",
        "--change-set-name",
        changeSetId,
      ]),
      "CloudFormation change-set execution",
    );
    const waiter = stack.exists ? "stack-update-complete" : "stack-create-complete";
    const waitResult = await dependencies.runCommand(
      "aws",
      awsArgs(options, [
        "cloudformation",
        "wait",
        waiter,
        "--stack-name",
        options.stack,
      ]),
      {
        cwd: dependencies.cwd,
        env: dependencies.env,
        timeoutMs: STACK_TIMEOUT_MS,
      },
    );
    if (waitResult.exitCode !== 0) {
      const failedStack = await describeStack(dependencies, options).catch(
        () => undefined,
      );
      const events = await recentFailureEvents(dependencies, options);
      throw new Error(
        `CloudFormation did not reach a successful terminal state. Current stack status: ${
          failedStack?.status ?? "unavailable"
        }. Recent failure events: ${events}`,
      );
    }
    const deployed = await describeStack(dependencies, options);
    const apiBaseUrl = deployed.outputs.ApiBaseUrl;
    const bootstrapSecretArn = deployed.outputs.BootstrapSecretArn;
    const missingOutputs = [
      "ApiBaseUrl",
      "BootstrapSecretArn",
      "AlarmTopicArn",
      "OperationsDashboardName",
    ].filter((key) => !deployed.outputs[key]);
    if (!apiBaseUrl || !bootstrapSecretArn || missingOutputs.length > 0) {
      throw new Error(
        `Deployment completed, but required CloudFormation outputs are missing: ${missingOutputs.join(
          ", ",
        )}.`,
      );
    }
    validateBootstrapSecret(bootstrapSecretArn, options);
    dependencies.log(
      JSON.stringify(
        {
          schema_version: 1,
          object: "aws_deployment_result",
          ok: true,
          applied: true,
          no_changes: false,
          stack: options.stack,
          status: deployed.status,
          outputs: deployed.outputs,
          next: {
            environment: {
              HAYASEND_BASE_URL: apiBaseUrl,
              HAYASEND_BOOTSTRAP_SECRET_ARN: bootstrapSecretArn,
            },
            retrieve_bootstrap_key: {
              command: bootstrapKeyCommand(options, bootstrapSecretArn),
              assign_stdout_to: "HAYASEND_API_KEY",
              handling:
                "Keep the bootstrap key out of logs and unset it after issuing scoped application keys.",
            },
            doctor_command: ["npm", "run", "cli", "--", "doctor"],
            dns: deployed.outputs.InboundMxRecord
              ? "Review receiving webhooks, then create the documented MX record manually."
              : "No DNS change is required by this deployment.",
          },
        },
      ),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
