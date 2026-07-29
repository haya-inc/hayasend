import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024;
const SHORT_COMMAND_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const DEPLOY_TIMEOUT_MS = 15 * 60_000;
const STACK_TIMEOUT_MS = 35 * 60_000;
const HEALTH_TIMEOUT_MS = 5_000;
const DRIFT_POLL_INTERVAL_MS = 5_000;
const DRIFT_MAX_ATTEMPTS = 120;
const LOG_RETENTION_DAYS = new Set([
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
]);
const PACKAGED_TEMPLATE_PATH = fileURLToPath(
  new URL("../template.yaml", import.meta.url),
);
const PACKAGED_NPM_SAM_COMPAT_PATH = fileURLToPath(
  new URL("../scripts/npm-sam-compat.mjs", import.meta.url),
);
const PACKAGED_VERSION = (() => {
  const packageMetadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof packageMetadata.version !== "string") {
    throw new Error("The HayaSend package is missing a valid version.");
  }
  return packageMetadata.version;
})();

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
  EnableGradualDeployments: "false",
  DeploymentPreferenceType: "Canary10Percent5Minutes",
  EnableBackups: "true",
  BackupRetentionDays: "35",
  BackupVaultName: "HayaSendBackup",
  PayloadNoncurrentVersionRetentionDays: "7",
  EnableRestoreTesting: "false",
  RestoreTestingPlanName: "HayaSendRestoreTesting",
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
  "BackupVaultArn",
  "BackupPlanId",
  "RestoreTestingPlanArn",
] as const;

const RETAINED_RESOURCE_LOGICAL_IDS = new Set([
  "DataTable",
  "PayloadBucket",
  "InboundKey",
  "InboundBucket",
  "BackupVault",
]);

const CORE_LAMBDA_ALIAS_LOGICAL_IDS = [
  "ApiFunctionAliaslive",
  "WorkerFunctionAliaslive",
  "DispatcherFunctionAliaslive",
  "SesEventsFunctionAliaslive",
] as const;

const APPLICATION_LAMBDA_DEPLOYMENTS = [
  {
    aliasLogicalId: "ApiFunctionAliaslive",
    alarmLogicalId: "ApiFunctionAliasErrorAlarm",
    conditional: false,
  },
  {
    aliasLogicalId: "WorkerFunctionAliaslive",
    alarmLogicalId: "WorkerFunctionAliasErrorAlarm",
    conditional: false,
  },
  {
    aliasLogicalId: "DispatcherFunctionAliaslive",
    alarmLogicalId: "DispatcherFunctionAliasErrorAlarm",
    conditional: false,
  },
  {
    aliasLogicalId: "SesEventsFunctionAliaslive",
    alarmLogicalId: "SesEventsFunctionAliasErrorAlarm",
    conditional: false,
  },
  {
    aliasLogicalId: "InboundFunctionAliaslive",
    alarmLogicalId: "InboundFunctionAliasErrorAlarm",
    conditional: true,
  },
] as const;

const DEPLOYMENT_PREFERENCE_TYPES = new Set([
  "Canary10Percent5Minutes",
  "Canary10Percent10Minutes",
  "Canary10Percent15Minutes",
  "Canary10Percent30Minutes",
  "Linear10PercentEvery1Minute",
  "Linear10PercentEvery2Minutes",
  "Linear10PercentEvery3Minutes",
  "Linear10PercentEvery10Minutes",
]);

const STACK_POLICY = {
  Statement: [
    {
      Effect: "Allow",
      Action: "Update:*",
      Principal: "*",
      Resource: "*",
    },
    {
      Effect: "Deny",
      Action: ["Update:Replace", "Update:Delete"],
      Principal: "*",
      Resource: [...RETAINED_RESOURCE_LOGICAL_IDS]
        .sort()
        .map((logicalId) => `LogicalResourceId/${logicalId}`),
    },
  ],
};

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
  account?: string;
  region?: string;
  stack?: string;
  profile?: string;
  operation?: "deploy" | "upgrade";
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
  deploymentPreferenceType?: string;
  enableBackups?: boolean;
  backupRetentionDays?: string;
  payloadNoncurrentVersionRetentionDays?: string;
  enableRestoreTesting?: boolean;
  tags: string[];
}

export interface AwsDeployDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  runCommand: CommandRunner;
}

export interface AwsStatusDependencies extends AwsDeployDependencies {
  fetch: typeof fetch;
  sleep(milliseconds: number): Promise<void>;
}

export interface AwsTargetOptions {
  account?: string;
  region?: string;
  stack?: string;
  profile?: string;
}

export interface AwsStatusOptions extends AwsTargetOptions {
  detectDrift: boolean;
}

export interface AwsCleanupOptions extends AwsTargetOptions {
  apply: boolean;
  confirmStack?: string;
  disableTerminationProtection: boolean;
}

interface NormalizedTarget {
  account: string;
  region: string;
  stack: string;
  profile?: string;
}

interface NormalizedOptions extends NormalizedTarget {
  operation: "deploy" | "upgrade";
  apply: boolean;
  allowDestructiveChanges: boolean;
  explicitParameters: Record<string, string>;
  tags: Array<{ key: string; value: string }>;
}

interface StackDescription {
  exists: boolean;
  status?: string;
  creationTime?: string;
  lastUpdatedTime?: string;
  terminationProtectionEnabled?: boolean;
  driftStatus?: string;
  driftLastCheckedAt?: string;
  parameters: Record<string, string>;
  outputs: Record<string, string>;
  tags: Record<string, string>;
}

interface StackResource {
  logicalId: string;
  physicalId?: string;
  type: string;
  status: string;
  statusReason?: string;
}

interface DriftedResource {
  logicalId: string;
  type: string;
  status: string;
}

interface DriftDetection {
  status: string;
  checkedAt: string | null;
  driftedResourceCount: number | null;
  resources: DriftedResource[];
}

interface DriftDetectionStatus {
  StackDriftDetectionId?: unknown;
  StackDriftStatus?: unknown;
  DetectionStatus?: unknown;
  DetectionStatusReason?: unknown;
  DriftedStackResourceCount?: unknown;
  Timestamp?: unknown;
}

interface AwsIdentity {
  account: string;
  principalArn: string;
}

interface SesAccount {
  productionAccess: boolean;
  sendingEnabled: boolean;
  enforcementStatus: string | null;
  max24HourSend: unknown;
  maxSendRate: unknown;
  sentLast24Hours: unknown;
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

export function renderAwsTemplate(
  source: string,
  gradualAliasLogicalIds: ReadonlySet<string>,
) {
  let rendered = source;
  for (const deployment of APPLICATION_LAMBDA_DEPLOYMENTS) {
    const markerName = deployment.conditional
      ? "HAYASEND_GRADUAL_DEPLOYMENT_CONDITIONAL"
      : "HAYASEND_GRADUAL_DEPLOYMENT";
    const marker = `      # ${markerName}: ${deployment.alarmLogicalId}\n`;
    if (rendered.split(marker).length !== 2) {
      throw new Error(
        `The packaged AWS template must contain exactly one ${deployment.alarmLogicalId} gradual-deployment marker.`,
      );
    }
    const preference = gradualAliasLogicalIds.has(deployment.aliasLogicalId)
      ? [
          "      DeploymentPreference:",
          "        Type: !Ref DeploymentPreferenceType",
          "        Alarms:",
          `          - !Ref ${deployment.alarmLogicalId}`,
          ...(deployment.conditional
            ? ["        PassthroughCondition: true"]
            : []),
          "",
        ].join("\n")
      : "";
    rendered = rendered.replace(marker, preference);
  }
  if (rendered.includes("HAYASEND_GRADUAL_DEPLOYMENT")) {
    throw new Error(
      "The packaged AWS template contains an unknown gradual-deployment marker.",
    );
  }
  return rendered;
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
    labels.every((label) =>
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

function normalizeTargetOptions(
  options: AwsTargetOptions,
  env: NodeJS.ProcessEnv,
): Pick<NormalizedOptions, "account" | "region" | "stack" | "profile"> {
  const account = options.account ?? env.HAYASEND_AWS_ACCOUNT_ID;
  if (!account || !/^\d{12}$/.test(account)) {
    throw new Error(
      "--account or HAYASEND_AWS_ACCOUNT_ID must be the expected 12-digit AWS account ID.",
    );
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
  if (options.profile && !/^[A-Za-z0-9_+=,.@-]{1,128}$/.test(options.profile)) {
    throw new Error("--profile contains unsupported characters.");
  }
  return {
    account,
    region,
    stack,
    ...(options.profile ? { profile: options.profile } : {}),
  };
}

function normalizeOptions(
  options: AwsDeployOptions,
  env: NodeJS.ProcessEnv,
): NormalizedOptions {
  const target = normalizeTargetOptions(options, env);
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
    explicitParameters.TemplateHistoryRetentionDays = templateHistoryRetention;
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
    explicitParameters.WorkerReservedConcurrency = workerReservedConcurrency;
  }
  if (options.deploymentPreferenceType !== undefined) {
    if (!DEPLOYMENT_PREFERENCE_TYPES.has(options.deploymentPreferenceType)) {
      throw new Error(
        "--deployment-preference-type must be a supported AWS SAM canary or linear deployment strategy.",
      );
    }
    explicitParameters.DeploymentPreferenceType =
      options.deploymentPreferenceType;
  }
  if (options.enableBackups !== undefined) {
    explicitParameters.EnableBackups = String(options.enableBackups);
  }
  const backupRetentionDays = requireInteger(
    options.backupRetentionDays,
    "--backup-retention-days",
    1,
    365,
  );
  if (backupRetentionDays) {
    explicitParameters.BackupRetentionDays = backupRetentionDays;
  }
  const payloadNoncurrentVersionRetentionDays = requireInteger(
    options.payloadNoncurrentVersionRetentionDays,
    "--payload-noncurrent-version-retention-days",
    1,
    30,
  );
  if (payloadNoncurrentVersionRetentionDays) {
    explicitParameters.PayloadNoncurrentVersionRetentionDays =
      payloadNoncurrentVersionRetentionDays;
  }
  if (options.enableRestoreTesting !== undefined) {
    explicitParameters.EnableRestoreTesting = String(
      options.enableRestoreTesting,
    );
  }

  return {
    ...target,
    operation: options.operation ?? "deploy",
    apply: options.apply,
    allowDestructiveChanges: options.allowDestructiveChanges,
    explicitParameters,
    tags: parseTags(options.tags),
  };
}

function awsArgs(
  options: NormalizedTarget,
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

function samArgs(options: NormalizedTarget, commandArgs: string[]) {
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
  env = dependencies.env,
) {
  const result = await dependencies.runCommand(command, args, {
    cwd: dependencies.cwd,
    env,
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
  options: NormalizedTarget,
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
      CreationTime?: unknown;
      LastUpdatedTime?: unknown;
      EnableTerminationProtection?: unknown;
      DriftInformation?: {
        StackDriftStatus?: unknown;
        LastCheckTimestamp?: unknown;
      };
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
    ...(typeof stack.CreationTime === "string"
      ? { creationTime: stack.CreationTime }
      : {}),
    ...(typeof stack.LastUpdatedTime === "string"
      ? { lastUpdatedTime: stack.LastUpdatedTime }
      : {}),
    ...(typeof stack.EnableTerminationProtection === "boolean"
      ? {
          terminationProtectionEnabled: stack.EnableTerminationProtection,
        }
      : {}),
    ...(typeof stack.DriftInformation?.StackDriftStatus === "string"
      ? { driftStatus: stack.DriftInformation.StackDriftStatus }
      : {}),
    ...(typeof stack.DriftInformation?.LastCheckTimestamp === "string"
      ? {
          driftLastCheckedAt: stack.DriftInformation.LastCheckTimestamp,
        }
      : {}),
    parameters: readParameters(stack.Parameters),
    outputs: readOutputs(stack.Outputs),
    tags: readTags(stack.Tags),
  };
}

function expectedStackPolicy(value: unknown) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const statements = (value as { Statement?: unknown }).Statement;
  if (!Array.isArray(statements)) {
    return false;
  }
  const allow = statements.some((statement) => {
    if (!statement || typeof statement !== "object") {
      return false;
    }
    const candidate = statement as Record<string, unknown>;
    return (
      candidate.Effect === "Allow" &&
      candidate.Action === "Update:*" &&
      candidate.Principal === "*" &&
      candidate.Resource === "*"
    );
  });
  const expectedResources = [...RETAINED_RESOURCE_LOGICAL_IDS]
    .sort()
    .map((logicalId) => `LogicalResourceId/${logicalId}`);
  const deny = statements.some((statement) => {
    if (!statement || typeof statement !== "object") {
      return false;
    }
    const candidate = statement as Record<string, unknown>;
    const actions = Array.isArray(candidate.Action)
      ? candidate.Action.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    const resources = Array.isArray(candidate.Resource)
      ? candidate.Resource.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    return (
      candidate.Effect === "Deny" &&
      candidate.Principal === "*" &&
      ["Update:Delete", "Update:Replace"].every((action) =>
        actions.includes(action),
      ) &&
      expectedResources.every((resource) => resources.includes(resource))
    );
  });
  return allow && deny;
}

async function inspectStackPolicy(
  dependencies: AwsDeployDependencies,
  options: NormalizedTarget,
) {
  const value = await requireJson<{ StackPolicyBody?: unknown }>(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "get-stack-policy",
      "--stack-name",
      options.stack,
    ]),
    "CloudFormation stack-policy inspection",
  );
  if (value.StackPolicyBody === undefined) {
    return { present: false, protectedRetainedResources: false };
  }
  if (typeof value.StackPolicyBody !== "string") {
    throw new Error("CloudFormation returned an invalid stack policy.");
  }
  let policy: unknown;
  try {
    policy = JSON.parse(value.StackPolicyBody);
  } catch {
    throw new Error("CloudFormation returned invalid stack-policy JSON.");
  }
  return {
    present: true,
    protectedRetainedResources: expectedStackPolicy(policy),
  };
}

async function enforceStackProtections(
  dependencies: AwsDeployDependencies,
  options: NormalizedTarget,
) {
  await requireCommand(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "set-stack-policy",
      "--stack-name",
      options.stack,
      "--stack-policy-body",
      JSON.stringify(STACK_POLICY),
    ]),
    "CloudFormation stack-policy enforcement",
  );
  await requireCommand(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "update-termination-protection",
      "--enable-termination-protection",
      "--stack-name",
      options.stack,
    ]),
    "CloudFormation termination-protection enforcement",
  );
  const [policy, protectedStack] = await Promise.all([
    inspectStackPolicy(dependencies, options),
    describeStack(dependencies, options),
  ]);
  if (
    !policy.protectedRetainedResources ||
    protectedStack.terminationProtectionEnabled !== true
  ) {
    throw new Error(
      "Deployment completed, but CloudFormation did not verify the required stack policy and termination protection.",
    );
  }
  return protectedStack;
}

async function detectStackDrift(
  dependencies: AwsStatusDependencies,
  options: NormalizedTarget,
): Promise<DriftDetection> {
  const started = await requireJson<{ StackDriftDetectionId?: unknown }>(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "detect-stack-drift",
      "--stack-name",
      options.stack,
    ]),
    "CloudFormation drift detection",
  );
  const detectionId = started.StackDriftDetectionId;
  if (
    typeof detectionId !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(detectionId)
  ) {
    throw new Error(
      "CloudFormation returned an invalid stack drift detection ID.",
    );
  }

  let completed: DriftDetectionStatus | undefined;
  for (let attempt = 0; attempt < DRIFT_MAX_ATTEMPTS; attempt += 1) {
    const driftStatusResponse: DriftDetectionStatus =
      await requireJson<DriftDetectionStatus>(
        dependencies,
        "aws",
        awsArgs(options, [
          "cloudformation",
          "describe-stack-drift-detection-status",
          "--stack-drift-detection-id",
          detectionId,
        ]),
        "CloudFormation drift detection status",
      );
    if (driftStatusResponse.StackDriftDetectionId !== detectionId) {
      throw new Error(
        "CloudFormation returned a different stack drift detection ID.",
      );
    }
    if (driftStatusResponse.DetectionStatus === "DETECTION_COMPLETE") {
      completed = driftStatusResponse;
      break;
    }
    if (driftStatusResponse.DetectionStatus === "DETECTION_FAILED") {
      const reason =
        typeof driftStatusResponse.DetectionStatusReason === "string"
          ? `: ${redactAwsDiagnostics(
              driftStatusResponse.DetectionStatusReason,
            )}`
          : "";
      throw new Error(`CloudFormation drift detection failed${reason}`);
    }
    if (driftStatusResponse.DetectionStatus !== "DETECTION_IN_PROGRESS") {
      throw new Error(
        `CloudFormation returned an unknown drift detection status: ${String(
          driftStatusResponse.DetectionStatus ?? "missing",
        )}.`,
      );
    }
    if (attempt + 1 < DRIFT_MAX_ATTEMPTS) {
      await dependencies.sleep(DRIFT_POLL_INTERVAL_MS);
    }
  }
  if (!completed) {
    throw new Error(
      "CloudFormation drift detection did not complete within 10 minutes.",
    );
  }
  if (
    typeof completed.StackDriftStatus !== "string" ||
    !["DRIFTED", "IN_SYNC", "NOT_CHECKED", "UNKNOWN"].includes(
      completed.StackDriftStatus,
    )
  ) {
    throw new Error("CloudFormation returned an invalid stack drift status.");
  }

  const value = await requireJson<{
    StackResourceDrifts?: Array<{
      LogicalResourceId?: unknown;
      ResourceType?: unknown;
      StackResourceDriftStatus?: unknown;
    }>;
  }>(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "describe-stack-resource-drifts",
      "--stack-name",
      options.stack,
      "--stack-resource-drift-status-filters",
      "MODIFIED",
      "DELETED",
    ]),
    "CloudFormation drifted-resource inspection",
  );
  const resources: DriftedResource[] = [];
  for (const resource of value.StackResourceDrifts ?? []) {
    if (
      typeof resource.LogicalResourceId !== "string" ||
      typeof resource.ResourceType !== "string" ||
      typeof resource.StackResourceDriftStatus !== "string"
    ) {
      throw new Error("CloudFormation returned invalid drifted-resource JSON.");
    }
    resources.push({
      logicalId: resource.LogicalResourceId,
      type: resource.ResourceType,
      status: resource.StackResourceDriftStatus,
    });
  }
  return {
    status: completed.StackDriftStatus,
    checkedAt:
      typeof completed.Timestamp === "string" ? completed.Timestamp : null,
    driftedResourceCount:
      typeof completed.DriftedStackResourceCount === "number"
        ? completed.DriftedStackResourceCount
        : null,
    resources,
  };
}

async function requireAwsIdentity(
  dependencies: AwsDeployDependencies,
  options: NormalizedTarget,
): Promise<AwsIdentity> {
  const identity = await requireJson<{ Account?: unknown; Arn?: unknown }>(
    dependencies,
    "aws",
    awsArgs(options, ["sts", "get-caller-identity"], false),
    "AWS caller identity",
  );
  if (
    identity.Account !== options.account ||
    typeof identity.Arn !== "string"
  ) {
    throw new Error(
      `AWS caller account ${String(
        identity.Account ?? "unknown",
      )} does not match --account or HAYASEND_AWS_ACCOUNT_ID.`,
    );
  }
  return {
    account: identity.Account,
    principalArn: identity.Arn,
  };
}

async function requireSesAccount(
  dependencies: AwsDeployDependencies,
  options: NormalizedTarget,
): Promise<SesAccount> {
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
  return {
    productionAccess: ses.ProductionAccessEnabled === true,
    sendingEnabled: ses.SendingEnabled === true,
    enforcementStatus:
      typeof ses.EnforcementStatus === "string" ? ses.EnforcementStatus : null,
    max24HourSend: ses.SendQuota?.Max24HourSend ?? null,
    maxSendRate: ses.SendQuota?.MaxSendRate ?? null,
    sentLast24Hours: ses.SendQuota?.SentLast24Hours ?? null,
  };
}

async function listStackResources(
  dependencies: AwsDeployDependencies,
  options: NormalizedTarget,
): Promise<StackResource[]> {
  const value = await requireJson<{
    StackResourceSummaries?: Array<{
      LogicalResourceId?: unknown;
      PhysicalResourceId?: unknown;
      ResourceType?: unknown;
      ResourceStatus?: unknown;
      ResourceStatusReason?: unknown;
    }>;
  }>(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "list-stack-resources",
      "--stack-name",
      options.stack,
    ]),
    "CloudFormation resource inspection",
  );
  const resources: StackResource[] = [];
  for (const item of value.StackResourceSummaries ?? []) {
    if (
      typeof item.LogicalResourceId !== "string" ||
      typeof item.ResourceType !== "string" ||
      typeof item.ResourceStatus !== "string"
    ) {
      throw new Error("CloudFormation returned invalid stack resource JSON.");
    }
    resources.push({
      logicalId: item.LogicalResourceId,
      ...(typeof item.PhysicalResourceId === "string"
        ? { physicalId: item.PhysicalResourceId }
        : {}),
      type: item.ResourceType,
      status: item.ResourceStatus,
      ...(typeof item.ResourceStatusReason === "string"
        ? {
            statusReason: redactAwsDiagnostics(item.ResourceStatusReason),
          }
        : {}),
    });
  }
  return resources;
}

function problematicResources(resources: StackResource[]) {
  return resources
    .filter(
      (resource) =>
        !["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(
          resource.status,
        ),
    )
    .map((resource) => ({
      logical_id: resource.logicalId,
      resource_type: resource.type,
      status: resource.status,
      ...(resource.statusReason
        ? { status_reason: resource.statusReason }
        : {}),
    }));
}

function gradualDeploymentSummary(
  parameters: Record<string, string>,
  resources: StackResource[],
) {
  const requiredAliases = [
    ...CORE_LAMBDA_ALIAS_LOGICAL_IDS,
    ...(parameters.EnableInbound === "true"
      ? ["InboundFunctionAliaslive"]
      : []),
  ];
  const availableAliases = availableLambdaAliases(resources);
  const missingAliases = requiredAliases.filter(
    (logicalId) => !availableAliases.has(logicalId),
  );
  const requiredDeploymentGroups = requiredAliases.map((logicalId) =>
    logicalId.replace(/Aliaslive$/, "DeploymentGroup"),
  );
  const availableDeploymentGroups = new Set(
    resources
      .filter(
        (resource) =>
          resource.type === "AWS::CodeDeploy::DeploymentGroup" &&
          ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(
            resource.status,
          ),
      )
      .map((resource) => resource.logicalId),
  );
  const missingDeploymentGroups = requiredDeploymentGroups.filter(
    (logicalId) => !availableDeploymentGroups.has(logicalId),
  );
  return {
    enabled: parameters.EnableGradualDeployments === "true",
    strategy: parameters.DeploymentPreferenceType ?? "Canary10Percent5Minutes",
    aliases_ready: missingAliases.length === 0,
    deployment_groups_ready: missingDeploymentGroups.length === 0,
    required_aliases: requiredAliases,
    missing_aliases: missingAliases,
    required_deployment_groups: requiredDeploymentGroups,
    missing_deployment_groups: missingDeploymentGroups,
  };
}

function backupSummary(
  parameters: Record<string, string>,
  resources: StackResource[],
) {
  const logicalIds = new Set(
    resources
      .filter((resource) =>
        ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(
          resource.status,
        ),
      )
      .map((resource) => resource.logicalId),
  );
  const enabled = parameters.EnableBackups === "true";
  const required = enabled
    ? ["BackupServiceRole", "BackupVault", "BackupPlan", "BackupSelection"]
    : [];
  const missing = required.filter((logicalId) => !logicalIds.has(logicalId));
  const restoreTestingEnabled =
    enabled && parameters.EnableRestoreTesting === "true";
  const restoreTestingRequired = restoreTestingEnabled
    ? [
        "RestoreTestingServiceRole",
        "RestoreTestingPlan",
        "DynamoDbRestoreTestingSelection",
        "S3RestoreTestingSelection",
      ]
    : [];
  const restoreTestingMissing = restoreTestingRequired.filter(
    (logicalId) => !logicalIds.has(logicalId),
  );
  return {
    enabled,
    retention_days: Number(parameters.BackupRetentionDays ?? 35),
    payload_noncurrent_version_retention_days: Number(
      parameters.PayloadNoncurrentVersionRetentionDays ?? 7,
    ),
    resources_ready: missing.length === 0,
    missing_resources: missing,
    restore_testing: {
      enabled: restoreTestingEnabled,
      plan_name: parameters.RestoreTestingPlanName ?? "HayaSendRestoreTesting",
      resources_ready: restoreTestingMissing.length === 0,
      missing_resources: restoreTestingMissing,
    },
  };
}

function dashboardUrl(region: string, dashboardName: string) {
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${encodeURIComponent(
    region,
  )}#dashboards/dashboard/${encodeURIComponent(dashboardName)}`;
}

async function alarmSummary(
  dependencies: AwsDeployDependencies,
  options: NormalizedTarget,
  resources: StackResource[],
) {
  const alarms = resources.filter(
    (resource) =>
      resource.type === "AWS::CloudWatch::Alarm" && resource.physicalId,
  );
  if (alarms.length === 0) {
    return {
      total: 0,
      ok: 0,
      alarm: 0,
      insufficient_data: 0,
      problems: [] as Array<{
        logical_id: string;
        state: string;
        reason: string | null;
      }>,
    };
  }
  const value = await requireJson<{
    MetricAlarms?: Array<{
      AlarmName?: unknown;
      StateValue?: unknown;
      StateReason?: unknown;
    }>;
    CompositeAlarms?: Array<{
      AlarmName?: unknown;
      StateValue?: unknown;
      StateReason?: unknown;
    }>;
  }>(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudwatch",
      "describe-alarms",
      "--alarm-names",
      ...alarms.map((alarm) => alarm.physicalId as string),
    ]),
    "CloudWatch alarm inspection",
  );
  const logicalByName = new Map(
    alarms.map((alarm) => [alarm.physicalId as string, alarm.logicalId]),
  );
  const states = [
    ...(value.MetricAlarms ?? []),
    ...(value.CompositeAlarms ?? []),
  ].flatMap((alarm) =>
    typeof alarm.AlarmName === "string" && typeof alarm.StateValue === "string"
      ? [
          {
            name: alarm.AlarmName,
            logicalId: logicalByName.get(alarm.AlarmName) ?? "UnknownAlarm",
            state: alarm.StateValue,
            reason:
              typeof alarm.StateReason === "string"
                ? redactAwsDiagnostics(alarm.StateReason)
                : null,
          },
        ]
      : [],
  );
  const missing = alarms.filter(
    (alarm) =>
      !states.some((state) => state.name === (alarm.physicalId as string)),
  );
  return {
    total: alarms.length,
    ok: states.filter((state) => state.state === "OK").length,
    alarm: states.filter((state) => state.state === "ALARM").length,
    insufficient_data:
      states.filter((state) => state.state === "INSUFFICIENT_DATA").length +
      missing.length,
    problems: [
      ...states
        .filter((state) => state.state !== "OK")
        .map((state) => ({
          logical_id: state.logicalId,
          state: state.state,
          reason: state.reason,
        })),
      ...missing.map((alarm) => ({
        logical_id: alarm.logicalId,
        state: "NOT_RETURNED",
        reason: null,
      })),
    ],
  };
}

async function publicHealth(
  endpoint: string,
  dependencies: AwsStatusDependencies,
) {
  const startedAt = Date.now();
  try {
    const response = await dependencies.fetch(
      `${endpoint.replace(/\/+$/, "")}/healthz`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      },
    );
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? ((await response.json()) as {
          ok?: unknown;
          service?: unknown;
          version?: unknown;
        })
      : {};
    const identified =
      response.ok && body.ok === true && body.service === "hayasend";
    return {
      ok: identified,
      http_status: response.status,
      latency_ms: Math.max(0, Date.now() - startedAt),
      service: body.service === "hayasend" ? body.service : null,
      version: typeof body.version === "string" ? body.version : null,
      ...(!identified
        ? {
            error:
              "The health endpoint did not identify a healthy HayaSend service.",
          }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      http_status: null,
      latency_ms: Math.max(0, Date.now() - startedAt),
      error:
        error instanceof Error
          ? redactAwsDiagnostics(error.message)
          : "Health request failed.",
    };
  }
}

function targetCommand(
  operation: "deploy" | "status" | "upgrade" | "cleanup",
  options: NormalizedTarget,
) {
  return [
    "npx",
    "--yes",
    `@haya-inc/hayasend@${PACKAGED_VERSION}`,
    operation,
    "aws",
    "--account",
    options.account,
    "--region",
    options.region,
    "--stack",
    options.stack,
    ...(options.profile ? ["--profile", options.profile] : []),
  ];
}

function validateBootstrapSecret(value: string, options: NormalizedOptions) {
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

function availableLambdaAliases(resources: StackResource[]) {
  return new Set(
    resources
      .filter(
        (resource) =>
          resource.type === "AWS::Lambda::Alias" &&
          ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(
            resource.status,
          ),
      )
      .map((resource) => resource.logicalId),
  );
}

function effectiveParameters(
  options: NormalizedOptions,
  stack: StackDescription,
  resources: StackResource[],
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
  const normalizedStack = options.stack
    .replaceAll(/[^A-Za-z0-9]/g, "_")
    .slice(0, 25);
  const restorePlanSuffix = createHash("sha256")
    .update(`${options.account}:${options.region}:${options.stack}`)
    .digest("hex")
    .slice(0, 10);
  parameters.RestoreTestingPlanName = `HayaSend_${normalizedStack}_${restorePlanSuffix}`;
  parameters.BackupVaultName = `HayaSend_${normalizedStack}_${restorePlanSuffix}`;
  if (
    parameters.EnableRestoreTesting === "true" &&
    parameters.EnableBackups !== "true"
  ) {
    throw new Error(
      "--enable-restore-testing requires backups to remain enabled.",
    );
  }
  const requiredAliases = [
    ...CORE_LAMBDA_ALIAS_LOGICAL_IDS,
    ...(parameters.EnableInbound === "true"
      ? ["InboundFunctionAliaslive"]
      : []),
  ];
  const readyAliases = availableLambdaAliases(resources);
  parameters.EnableGradualDeployments = String(
    stack.exists &&
      requiredAliases.every((logicalId) => readyAliases.has(logicalId)),
  );
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

function effectiveTags(options: NormalizedOptions, stack: StackDescription) {
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
    "npx",
    "--yes",
    `@haya-inc/hayasend@${PACKAGED_VERSION}`,
    options.operation,
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
    "--deployment-preference-type",
    parameters.DeploymentPreferenceType ?? "Canary10Percent5Minutes",
    ...(parameters.EnableBackups === "true"
      ? ["--enable-backups"]
      : ["--disable-backups"]),
    "--backup-retention-days",
    parameters.BackupRetentionDays ?? "35",
    "--payload-noncurrent-version-retention-days",
    parameters.PayloadNoncurrentVersionRetentionDays ?? "7",
    ...(parameters.EnableRestoreTesting === "true"
      ? ["--enable-restore-testing"]
      : ["--disable-restore-testing"]),
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

async function npmSamCompatibilityEnvironment(
  dependencies: AwsDeployDependencies,
  temporaryDirectory: string,
) {
  const npmRootResult = await requireCommand(
    dependencies,
    "npm",
    ["root", "--global"],
    "npm global package root",
  );
  const npmRoot = npmRootResult.stdout.trim();
  const environmentNpmCli = dependencies.env.npm_execpath;
  const realNpmCli =
    environmentNpmCli && isAbsolute(environmentNpmCli)
      ? environmentNpmCli
      : join(npmRoot, "npm", "bin", "npm-cli.js");
  if (!isAbsolute(npmRoot) || !isAbsolute(realNpmCli)) {
    throw new Error("npm returned a non-absolute global package root.");
  }

  const shimDirectory = join(temporaryDirectory, "npm-sam-compat");
  const shimPath = join(shimDirectory, "npm");
  await mkdir(shimDirectory, { mode: 0o700 });
  await copyFile(PACKAGED_NPM_SAM_COMPAT_PATH, shimPath);
  await chmod(shimPath, 0o700);
  await writeFile(
    join(shimDirectory, "npm.cmd"),
    '@"%HAYASEND_NODE_EXECUTABLE%" "%~dp0npm" %*\r\n',
    { encoding: "utf8", mode: 0o700 },
  );

  return {
    ...dependencies.env,
    HAYASEND_NODE_EXECUTABLE: process.execPath,
    HAYASEND_REAL_NPM_CLI: realNpmCli,
    PATH: `${shimDirectory}${delimiter}${dependencies.env.PATH ?? process.env.PATH ?? ""}`,
  };
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
    return changeSetIds(
      JSON.parse(result.stdout) as Parameters<typeof changeSetIds>[0],
    );
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
        ? change.Scope.filter(
            (scope): scope is string => typeof scope === "string",
          )
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
  options: NormalizedTarget,
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

export async function statusAws(
  rawOptions: AwsStatusOptions,
  dependencies: AwsStatusDependencies,
) {
  const options = normalizeTargetOptions(rawOptions, dependencies.env);
  const awsVersionResult = await requireCommand(
    dependencies,
    "aws",
    ["--version"],
    "AWS CLI",
  );
  const identity = await requireAwsIdentity(dependencies, options);
  const ses = await requireSesAccount(dependencies, options);
  let stack = await describeStack(dependencies, options);
  if (!stack.exists) {
    dependencies.log(
      JSON.stringify({
        schema_version: 1,
        object: "aws_status",
        ok: false,
        operational: false,
        send_ready: false,
        tools: {
          aws_cli: commandVersion(awsVersionResult, "AWS CLI"),
        },
        identity: {
          account: identity.account,
          principal_arn: identity.principalArn,
        },
        region: options.region,
        stack: {
          name: options.stack,
          exists: false,
          status: null,
        },
        ses: {
          production_access: ses.productionAccess,
          sending_enabled: ses.sendingEnabled,
          enforcement_status: ses.enforcementStatus,
          quota: {
            max_24_hour_send: ses.max24HourSend,
            max_send_rate: ses.maxSendRate,
            sent_last_24_hours: ses.sentLast24Hours,
          },
        },
        next: {
          deploy_plan_command: targetCommand("deploy", options),
        },
      }),
    );
    return;
  }

  if (
    rawOptions.detectDrift &&
    (!stack.status || !STABLE_STACK_STATUSES.has(stack.status))
  ) {
    throw new Error(
      `Stack ${options.stack} is in ${stack.status ?? "an unknown state"}; wait for a stable state before detecting drift.`,
    );
  }
  const detectedDrift = rawOptions.detectDrift
    ? await detectStackDrift(dependencies, options)
    : undefined;
  if (detectedDrift) {
    stack = {
      ...stack,
      driftStatus: detectedDrift.status,
      ...(detectedDrift.checkedAt
        ? { driftLastCheckedAt: detectedDrift.checkedAt }
        : {}),
    };
  }
  const stackPolicy = await inspectStackPolicy(dependencies, options);
  const resources = await listStackResources(dependencies, options);
  const problems = problematicResources(resources);
  const deployments = gradualDeploymentSummary(stack.parameters, resources);
  const backups = backupSummary(stack.parameters, resources);
  const alarms = await alarmSummary(dependencies, options, resources);
  const health = stack.outputs.ApiBaseUrl
    ? await publicHealth(stack.outputs.ApiBaseUrl, dependencies)
    : {
        ok: false,
        http_status: null,
        latency_ms: 0,
        error: "ApiBaseUrl is missing from the stack outputs.",
      };
  const stackStable =
    stack.status !== undefined && STABLE_STACK_STATUSES.has(stack.status);
  const driftHealthy = stack.driftStatus === "IN_SYNC";
  const protectionsHealthy =
    stack.terminationProtectionEnabled === true &&
    stackPolicy.protectedRetainedResources;
  const operational =
    stackStable &&
    driftHealthy &&
    protectionsHealthy &&
    deployments.enabled &&
    deployments.aliases_ready &&
    deployments.deployment_groups_ready &&
    backups.resources_ready &&
    backups.restore_testing.resources_ready &&
    problems.length === 0 &&
    alarms.total > 0 &&
    alarms.problems.length === 0 &&
    health.ok;
  const sendReady = operational && ses.productionAccess && ses.sendingEnabled;
  const dashboardName = stack.outputs.OperationsDashboardName;

  dependencies.log(
    JSON.stringify({
      schema_version: 1,
      object: "aws_status",
      ok: sendReady,
      operational,
      send_ready: sendReady,
      tools: {
        aws_cli: commandVersion(awsVersionResult, "AWS CLI"),
      },
      identity: {
        account: identity.account,
        principal_arn: identity.principalArn,
      },
      region: options.region,
      stack: {
        name: options.stack,
        exists: true,
        status: stack.status ?? null,
        created_at: stack.creationTime ?? null,
        updated_at: stack.lastUpdatedTime ?? null,
        termination_protection: stack.terminationProtectionEnabled ?? false,
        stack_policy: {
          present: stackPolicy.present,
          retained_resources_protected: stackPolicy.protectedRetainedResources,
        },
        drift: {
          status: stack.driftStatus ?? "NOT_CHECKED",
          checked_at: stack.driftLastCheckedAt ?? null,
          detected_now: rawOptions.detectDrift,
          drifted_resource_count: detectedDrift?.driftedResourceCount ?? null,
          resources:
            detectedDrift?.resources.map((resource) => ({
              logical_id: resource.logicalId,
              resource_type: resource.type,
              status: resource.status,
            })) ?? [],
        },
        resources: {
          total: resources.length,
          problems,
        },
        deployments,
        backups,
      },
      ses: {
        production_access: ses.productionAccess,
        sending_enabled: ses.sendingEnabled,
        enforcement_status: ses.enforcementStatus,
        quota: {
          max_24_hour_send: ses.max24HourSend,
          max_send_rate: ses.maxSendRate,
          sent_last_24_hours: ses.sentLast24Hours,
        },
      },
      alarms,
      public_health: health,
      outputs: stack.outputs,
      next: {
        dashboard: dashboardName
          ? {
              name: dashboardName,
              url: dashboardUrl(options.region, dashboardName),
            }
          : null,
        deep_doctor: {
          environment: {
            HAYASEND_BASE_URL: stack.outputs.ApiBaseUrl ?? null,
            HAYASEND_API_KEY:
              "Set a scoped key locally; never pass it as a command argument.",
          },
          command: [
            "npx",
            "--yes",
            `@haya-inc/hayasend@${PACKAGED_VERSION}`,
            "doctor",
          ],
        },
        detect_drift_command: [
          ...targetCommand("status", options),
          "--detect-drift",
        ],
        upgrade_plan_command: targetCommand("upgrade", options),
        cleanup_plan_command: targetCommand("cleanup", options),
      },
    }),
  );
}

export async function cleanupAws(
  rawOptions: AwsCleanupOptions,
  dependencies: AwsDeployDependencies,
) {
  if (rawOptions.disableTerminationProtection && !rawOptions.apply) {
    throw new Error("--disable-termination-protection requires --apply.");
  }
  const options = normalizeTargetOptions(rawOptions, dependencies.env);
  const awsVersionResult = await requireCommand(
    dependencies,
    "aws",
    ["--version"],
    "AWS CLI",
  );
  const identity = await requireAwsIdentity(dependencies, options);
  const stack = await describeStack(dependencies, options);
  if (!stack.exists) {
    dependencies.log(
      JSON.stringify({
        schema_version: 1,
        object: "aws_cleanup_plan",
        ok: true,
        mutating: false,
        no_changes: true,
        tools: {
          aws_cli: commandVersion(awsVersionResult, "AWS CLI"),
        },
        identity: {
          account: identity.account,
          principal_arn: identity.principalArn,
        },
        region: options.region,
        stack: {
          name: options.stack,
          exists: false,
          status: null,
        },
      }),
    );
    return;
  }
  if (!stack.status || !STABLE_STACK_STATUSES.has(stack.status)) {
    throw new Error(
      `Stack ${options.stack} is in ${stack.status ?? "an unknown state"}; recover it before cleanup.`,
    );
  }
  if (
    stack.tags.Project !== "HayaSend" ||
    stack.tags.ManagedBy !== "HayaSendCLI"
  ) {
    throw new Error(
      `Refusing to delete stack ${options.stack}: it is not tagged Project=HayaSend and ManagedBy=HayaSendCLI.`,
    );
  }
  const resources = await listStackResources(dependencies, options);
  const retained = resources
    .filter((resource) => RETAINED_RESOURCE_LOGICAL_IDS.has(resource.logicalId))
    .map((resource) => ({
      logical_id: resource.logicalId,
      resource_type: resource.type,
      physical_id: resource.physicalId ?? null,
    }));
  const applyCommand = [
    ...targetCommand("cleanup", options),
    "--apply",
    "--confirm-stack",
    options.stack,
    ...(stack.terminationProtectionEnabled === true
      ? ["--disable-termination-protection"]
      : []),
  ];
  dependencies.log(
    JSON.stringify({
      schema_version: 1,
      object: "aws_cleanup_plan",
      ok: true,
      mutating: rawOptions.apply,
      mode: rawOptions.apply ? "apply" : "plan",
      tools: {
        aws_cli: commandVersion(awsVersionResult, "AWS CLI"),
      },
      identity: {
        account: identity.account,
        principal_arn: identity.principalArn,
      },
      region: options.region,
      stack: {
        name: options.stack,
        exists: true,
        status: stack.status,
        termination_protection: stack.terminationProtectionEnabled ?? false,
        resource_count: resources.length,
      },
      deletion: {
        cloudformation_stack: options.stack,
        retained_resources: retained,
        retained_resource_handling:
          "Retained DynamoDB, S3, and inbound KMS resources are not purged. Inspect and remove them separately only when their data is no longer required.",
      },
      ...(rawOptions.apply ? {} : { apply_command: applyCommand }),
    }),
  );
  if (!rawOptions.apply) {
    return;
  }
  if (rawOptions.confirmStack !== options.stack) {
    throw new Error(
      `cleanup aws --apply requires --confirm-stack ${options.stack}.`,
    );
  }
  if (
    stack.terminationProtectionEnabled === true &&
    !rawOptions.disableTerminationProtection
  ) {
    throw new Error(
      `cleanup aws --apply requires --disable-termination-protection for protected stack ${options.stack}.`,
    );
  }

  let protectionDisabled = false;
  if (stack.terminationProtectionEnabled === true) {
    await requireCommand(
      dependencies,
      "aws",
      awsArgs(options, [
        "cloudformation",
        "update-termination-protection",
        "--disable-termination-protection",
        "--stack-name",
        options.stack,
      ]),
      "CloudFormation termination-protection disable",
    );
    const unprotected = await describeStack(dependencies, options);
    if (unprotected.terminationProtectionEnabled !== false) {
      throw new Error(
        "CloudFormation did not verify that termination protection was disabled; the stack was not deleted.",
      );
    }
    protectionDisabled = true;
  }

  try {
    await requireCommand(
      dependencies,
      "aws",
      awsArgs(options, [
        "cloudformation",
        "delete-stack",
        "--stack-name",
        options.stack,
      ]),
      "CloudFormation stack deletion",
    );
  } catch (error) {
    if (!protectionDisabled) {
      throw error;
    }
    try {
      await requireCommand(
        dependencies,
        "aws",
        awsArgs(options, [
          "cloudformation",
          "update-termination-protection",
          "--enable-termination-protection",
          "--stack-name",
          options.stack,
        ]),
        "CloudFormation termination-protection recovery",
      );
    } catch (recoveryError) {
      throw new Error(
        `${error instanceof Error ? error.message : "CloudFormation stack deletion failed."} Termination protection could not be re-enabled: ${
          recoveryError instanceof Error
            ? recoveryError.message
            : "unknown recovery failure"
        }`,
      );
    }
    throw new Error(
      `${error instanceof Error ? error.message : "CloudFormation stack deletion failed."} Termination protection was re-enabled.`,
    );
  }
  const waitResult = await dependencies.runCommand(
    "aws",
    awsArgs(options, [
      "cloudformation",
      "wait",
      "stack-delete-complete",
      "--stack-name",
      options.stack,
    ]),
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      timeoutMs: STACK_TIMEOUT_MS,
    },
  );
  const remaining = await describeStack(dependencies, options);
  if (remaining.exists) {
    const events = await recentFailureEvents(dependencies, options);
    throw new Error(
      `CloudFormation did not verify stack deletion${
        waitResult.exitCode === 0
          ? ""
          : ` (waiter exit code ${waitResult.exitCode})`
      }. Current stack status: ${
        remaining.status ?? "not present"
      }. Recent failure events: ${events}`,
    );
  }
  dependencies.log(
    JSON.stringify({
      schema_version: 1,
      object: "aws_cleanup_result",
      ok: true,
      deleted: true,
      stack: options.stack,
      retained_resources: retained,
      next:
        retained.length > 0
          ? "Review retained resources and their retention/compliance requirements before any separate purge."
          : "No retained HayaSend data resources were found.",
    }),
  );
}

export async function deployAws(
  rawOptions: AwsDeployOptions,
  dependencies: AwsDeployDependencies,
) {
  const options = normalizeOptions(rawOptions, dependencies.env);
  const templatePath = PACKAGED_TEMPLATE_PATH;
  const applicationDirectory = dirname(templatePath);
  const template = await readFile(templatePath, "utf8").catch(() => {
    throw new Error(
      "The HayaSend package is incomplete: template.yaml is missing.",
    );
  });

  const awsVersionResult = await requireCommand(
    dependencies,
    "aws",
    ["--version"],
    "AWS CLI",
  );
  const identity = await requireAwsIdentity(dependencies, options);
  const ses = await requireSesAccount(dependencies, options);
  const stack = await describeStack(dependencies, options);
  if (options.operation === "upgrade" && !stack.exists) {
    throw new Error(
      `Stack ${options.stack} does not exist; run deploy aws first.`,
    );
  }
  if (
    stack.exists &&
    (!stack.status || !STABLE_STACK_STATUSES.has(stack.status))
  ) {
    throw new Error(
      `Stack ${options.stack} is in ${stack.status ?? "an unknown state"}; recover it before deploying.`,
    );
  }
  const samVersionResult = await requireCommand(
    dependencies,
    "sam",
    ["--version"],
    "AWS SAM CLI",
  );
  const npmVersionResult = await requireCommand(
    dependencies,
    "npm",
    ["--version"],
    "npm CLI",
  );
  const stackResources = stack.exists
    ? await listStackResources(dependencies, options)
    : [];
  const parameters = effectiveParameters(options, stack, stackResources);
  const deployments = gradualDeploymentSummary(parameters, stackResources);
  const backups = backupSummary(parameters, stackResources);
  const deploymentTemplate = renderAwsTemplate(
    template,
    availableLambdaAliases(stackResources),
  );
  const tags = effectiveTags(options, stack);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "hayasend-deploy-"));
  try {
    const emptyConfig = join(temporaryDirectory, "samconfig.toml");
    const deploymentTemplatePath = join(temporaryDirectory, "template.yaml");
    const buildDirectory = join(temporaryDirectory, "build");
    const samBuildEnvironment = await npmSamCompatibilityEnvironment(
      dependencies,
      temporaryDirectory,
    );
    await writeFile(emptyConfig, "", { encoding: "utf8", mode: 0o600 });
    await writeFile(deploymentTemplatePath, deploymentTemplate, {
      encoding: "utf8",
      mode: 0o600,
    });
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
        deploymentTemplatePath,
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
        deploymentTemplatePath,
        "--base-dir",
        applicationDirectory,
        "--build-dir",
        buildDirectory,
        ...configArgs,
      ]),
      "SAM build",
      BUILD_TIMEOUT_MS,
      samBuildEnvironment,
    );

    dependencies.log(
      JSON.stringify({
        schema_version: 1,
        object: "aws_deployment_plan",
        operation: options.operation,
        ok: true,
        mutating: options.apply,
        mode: options.apply ? "apply" : "plan",
        tools: {
          aws_cli: commandVersion(awsVersionResult, "AWS CLI"),
          sam_cli: commandVersion(samVersionResult, "AWS SAM CLI"),
          npm_cli: commandVersion(npmVersionResult, "npm CLI"),
        },
        identity: {
          account: identity.account,
          principal_arn: identity.principalArn,
        },
        region: options.region,
        stack: {
          name: options.stack,
          exists: stack.exists,
          status: stack.status ?? null,
        },
        ses: {
          production_access: ses.productionAccess,
          sending_enabled: ses.sendingEnabled,
          enforcement_status: ses.enforcementStatus,
          quota: {
            max_24_hour_send: ses.max24HourSend,
            max_send_rate: ses.maxSendRate,
            sent_last_24_hours: ses.sentLast24Hours,
          },
        },
        template: {
          source: "package:template.yaml",
          sha256: createHash("sha256").update(deploymentTemplate).digest("hex"),
          validation: "pass",
          build: "pass",
        },
        parameters,
        tags: Object.fromEntries(tags.map(({ key, value }) => [key, value])),
        protections: {
          termination_protection: "enabled_on_apply",
          retained_resource_stack_policy: "enforced_on_apply",
          retained_logical_ids: [...RETAINED_RESOURCE_LOGICAL_IDS].sort(),
        },
        deployments: {
          ...deployments,
          mode: deployments.enabled ? "alarm_rollback" : "alias_bootstrap",
        },
        backups,
        dns_changes: "never",
        ...(options.apply
          ? {}
          : { apply_command: applyCommand(options, parameters, tags) }),
      }),
    );

    if (!options.apply) {
      return;
    }

    const before = await listChangeSets(dependencies, options, !stack.exists);
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
      const protectedStack = stack.exists
        ? await enforceStackProtections(dependencies, options)
        : stack;
      dependencies.log(
        JSON.stringify({
          schema_version: 1,
          object: "aws_deployment_result",
          operation: options.operation,
          ok: true,
          applied: stack.exists,
          no_changes: true,
          stack: options.stack,
          status: protectedStack.status ?? null,
          protections: {
            termination_protection:
              protectedStack.terminationProtectionEnabled === true,
            retained_resource_stack_policy: stack.exists,
          },
          deployments: gradualDeploymentSummary(
            protectedStack.parameters,
            stackResources,
          ),
          backups: backupSummary(protectedStack.parameters, stackResources),
          outputs: protectedStack.outputs,
        }),
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
      JSON.stringify({
        schema_version: 1,
        object: "aws_change_set_plan",
        ok: destructive.length === 0 || options.allowDestructiveChanges,
        stack: options.stack,
        change_set_id: changeSetId,
        changes,
        destructive_changes: destructive,
        requires_destructive_acknowledgement: destructive.length > 0,
      }),
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
    const waiter = stack.exists
      ? "stack-update-complete"
      : "stack-create-complete";
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
    const deployed = await enforceStackProtections(dependencies, options);
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
    const deployedResources = await listStackResources(dependencies, options);
    dependencies.log(
      JSON.stringify({
        schema_version: 1,
        object: "aws_deployment_result",
        operation: options.operation,
        ok: true,
        applied: true,
        no_changes: false,
        stack: options.stack,
        status: deployed.status,
        protections: {
          termination_protection: true,
          retained_resource_stack_policy: true,
        },
        deployments: gradualDeploymentSummary(
          deployed.parameters,
          deployedResources,
        ),
        backups: backupSummary(deployed.parameters, deployedResources),
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
          ...(parameters.EnableGradualDeployments === "true"
            ? {}
            : {
                enable_gradual_deployments: {
                  command: targetCommand("upgrade", options),
                  handling:
                    "Review and apply the next upgrade after live aliases exist; HayaSend will then enable alarm-driven traffic shifting.",
                },
              }),
          dns: deployed.outputs.InboundMxRecord
            ? "Review receiving webhooks, then create the documented MX record manually."
            : "No DNS change is required by this deployment.",
        },
      }),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
