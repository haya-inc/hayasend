import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  redactAwsDiagnostics,
  type CommandResult,
  type CommandRunner,
} from "./cli-aws-deploy.js";

const SHORT_TIMEOUT_MS = 30_000;
const CHANGE_SET_TIMEOUT_MS = 10 * 60_000;
const STACK_TIMEOUT_MS = 35 * 60_000;
const TEMPLATE_PATH = fileURLToPath(
  new URL("../deploy/aws-cloudformation-bootstrap.yaml", import.meta.url),
);
const PACKAGE_VERSION = (() => {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof metadata.version !== "string") {
    throw new Error("The HayaSend package is missing a valid version.");
  }
  return metadata.version;
})();

export interface AwsBootstrapOptions {
  account?: string;
  region?: string;
  profile?: string;
  stack?: string;
  applicationStackPrefix?: string;
  permissionsBoundaryArn?: string;
  artifactRetentionDays?: string;
  apply: boolean;
  allowDestructiveChanges: boolean;
  confirmAccount?: string;
}

export interface AwsBootstrapDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  runCommand: CommandRunner;
}

interface NormalizedOptions {
  account: string;
  region: string;
  profile?: string;
  stack: string;
  applicationStackPrefix: string;
  permissionsBoundaryArn: string;
  artifactRetentionDays: string;
  apply: boolean;
  allowDestructiveChanges: boolean;
  confirmAccount?: string;
}

interface BootstrapStack {
  exists: boolean;
  status?: string;
  terminationProtectionEnabled?: boolean;
  outputs: Record<string, string>;
  parameters: Record<string, string>;
}

interface BootstrapChange {
  action: string;
  logical_resource_id: string;
  resource_type: string;
  replacement: string;
}

function expectedPartition(region: string) {
  return region.startsWith("cn-")
    ? "aws-cn"
    : region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
}

function normalizeOptions(
  options: AwsBootstrapOptions,
  env: NodeJS.ProcessEnv,
): NormalizedOptions {
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
  if (options.profile && !/^[A-Za-z0-9_+=,.@-]{1,128}$/.test(options.profile)) {
    throw new Error("--profile contains unsupported characters.");
  }
  const stack = options.stack ?? "HayaSendDeploymentBootstrap";
  if (!/^[A-Za-z][-A-Za-z0-9]{0,127}$/.test(stack)) {
    throw new Error("--stack must be a valid CloudFormation stack name.");
  }
  const applicationStackPrefix = options.applicationStackPrefix ?? "hayasend";
  if (!/^[A-Za-z][-A-Za-z0-9]{0,63}$/.test(applicationStackPrefix)) {
    throw new Error(
      "--application-stack-prefix must be a valid CloudFormation stack-name prefix.",
    );
  }
  validateStackIsolation(stack, applicationStackPrefix);
  const artifactRetentionDays = options.artifactRetentionDays ?? "90";
  if (
    !/^\d+$/.test(artifactRetentionDays) ||
    Number(artifactRetentionDays) < 30 ||
    Number(artifactRetentionDays) > 3650
  ) {
    throw new Error("--artifact-retention-days must be between 30 and 3650.");
  }
  const permissionsBoundaryArn = options.permissionsBoundaryArn ?? "";
  validatePermissionsBoundary(permissionsBoundaryArn, account, region);
  if (options.allowDestructiveChanges && !options.apply) {
    throw new Error("--allow-destructive-changes requires --apply.");
  }
  return {
    account,
    region,
    ...(options.profile ? { profile: options.profile } : {}),
    stack,
    applicationStackPrefix,
    permissionsBoundaryArn,
    artifactRetentionDays,
    apply: options.apply,
    allowDestructiveChanges: options.allowDestructiveChanges,
    ...(options.confirmAccount
      ? { confirmAccount: options.confirmAccount }
      : {}),
  };
}

function validateStackIsolation(
  bootstrapStack: string,
  applicationStackPrefix: string,
) {
  if (bootstrapStack.startsWith(applicationStackPrefix)) {
    throw new Error(
      "--application-stack-prefix must not match the bootstrap stack; otherwise the operator policy could mutate its own trust boundary.",
    );
  }
}

function validatePermissionsBoundary(
  permissionsBoundaryArn: string,
  account: string,
  region: string,
) {
  if (!permissionsBoundaryArn) {
    return;
  }
  const match =
    /^arn:(aws|aws-us-gov|aws-cn):iam::(aws|\d{12}):policy\/[A-Za-z0-9_+=,.@/-]{1,128}$/.exec(
      permissionsBoundaryArn,
    );
  if (
    !match ||
    match[1] !== expectedPartition(region) ||
    (match[2] !== "aws" && match[2] !== account)
  ) {
    throw new Error(
      "--permissions-boundary-arn must name a managed policy in the expected partition and either the expected account or AWS.",
    );
  }
}

function awsArgs(options: NormalizedOptions, args: string[], region = true) {
  return [
    ...args,
    ...(region ? ["--region", options.region] : []),
    ...(options.profile ? ["--profile", options.profile] : []),
    "--output",
    "json",
    "--no-cli-pager",
  ];
}

async function run(
  dependencies: AwsBootstrapDependencies,
  command: string,
  args: string[],
  label: string,
  timeoutMs = SHORT_TIMEOUT_MS,
) {
  const result = await dependencies.runCommand(command, args, {
    cwd: dependencies.cwd,
    env: dependencies.env,
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.exitCode}: ${redactAwsDiagnostics(
        result.stderr || result.stdout,
      )}`,
    );
  }
  return result;
}

async function json<T>(
  dependencies: AwsBootstrapDependencies,
  command: string,
  args: string[],
  label: string,
) {
  const result = await run(dependencies, command, args, label);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function missingStack(result: CommandResult) {
  return (
    result.exitCode !== 0 &&
    /ValidationError/i.test(`${result.stdout}\n${result.stderr}`) &&
    /does not exist/i.test(`${result.stdout}\n${result.stderr}`)
  );
}

async function describeStack(
  dependencies: AwsBootstrapDependencies,
  options: NormalizedOptions,
): Promise<BootstrapStack> {
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
      timeoutMs: SHORT_TIMEOUT_MS,
    },
  );
  if (missingStack(result)) {
    return { exists: false, outputs: {}, parameters: {} };
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to inspect the bootstrap stack: ${redactAwsDiagnostics(
        result.stderr || result.stdout,
      )}`,
    );
  }
  const value = JSON.parse(result.stdout) as {
    Stacks?: Array<{
      StackStatus?: unknown;
      EnableTerminationProtection?: unknown;
      Outputs?: Array<{ OutputKey?: unknown; OutputValue?: unknown }>;
      Parameters?: Array<{
        ParameterKey?: unknown;
        ParameterValue?: unknown;
      }>;
    }>;
  };
  const stack = value.Stacks?.[0];
  if (!stack || typeof stack.StackStatus !== "string") {
    throw new Error("CloudFormation did not return the bootstrap stack.");
  }
  const outputs: Record<string, string> = {};
  const parameters: Record<string, string> = {};
  for (const output of stack.Outputs ?? []) {
    if (
      typeof output.OutputKey === "string" &&
      typeof output.OutputValue === "string"
    ) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }
  for (const parameter of stack.Parameters ?? []) {
    if (
      typeof parameter.ParameterKey === "string" &&
      typeof parameter.ParameterValue === "string"
    ) {
      parameters[parameter.ParameterKey] = parameter.ParameterValue;
    }
  }
  return {
    exists: true,
    status: stack.StackStatus,
    ...(typeof stack.EnableTerminationProtection === "boolean"
      ? {
          terminationProtectionEnabled: stack.EnableTerminationProtection,
        }
      : {}),
    outputs,
    parameters,
  };
}

async function enforceTerminationProtection(
  dependencies: AwsBootstrapDependencies,
  options: NormalizedOptions,
  stack: BootstrapStack,
) {
  if (stack.terminationProtectionEnabled === true) {
    return stack;
  }
  await run(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "update-termination-protection",
      "--enable-termination-protection",
      "--stack-name",
      options.stack,
    ]),
    "CloudFormation bootstrap termination-protection enforcement",
  );
  const protectedStack = await describeStack(dependencies, options);
  if (
    !protectedStack.exists ||
    protectedStack.terminationProtectionEnabled !== true
  ) {
    throw new Error(
      "CloudFormation did not verify termination protection on the bootstrap stack.",
    );
  }
  return protectedStack;
}

function applyCommand(options: NormalizedOptions) {
  return [
    "npx",
    "--yes",
    `@haya-inc/hayasend@${PACKAGE_VERSION}`,
    "bootstrap",
    "aws",
    "--account",
    options.account,
    "--region",
    options.region,
    "--stack",
    options.stack,
    "--application-stack-prefix",
    options.applicationStackPrefix,
    "--artifact-retention-days",
    options.artifactRetentionDays,
    ...(options.profile ? ["--profile", options.profile] : []),
    ...(options.permissionsBoundaryArn
      ? ["--permissions-boundary-arn", options.permissionsBoundaryArn]
      : []),
    "--apply",
    "--confirm-account",
    options.account,
  ];
}

function validateOutputs(
  outputs: Record<string, string>,
  options: NormalizedOptions,
) {
  const roleArn = outputs.CloudFormationRoleArn;
  const policyArn = outputs.OperatorPolicyArn;
  const bucket = outputs.ArtifactBucketName;
  const partition = expectedPartition(options.region);
  if (
    !roleArn ||
    !roleArn.startsWith(`arn:${partition}:iam::${options.account}:role/`)
  ) {
    throw new Error(
      "Bootstrap completed without an exact-account CloudFormationRoleArn output.",
    );
  }
  if (
    !policyArn ||
    !policyArn.startsWith(`arn:${partition}:iam::${options.account}:policy/`)
  ) {
    throw new Error(
      "Bootstrap completed without an exact-account OperatorPolicyArn output.",
    );
  }
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(
      "Bootstrap completed without a valid ArtifactBucketName output.",
    );
  }
  return { roleArn, policyArn, bucket };
}

function summarizeChanges(value: {
  Changes?: Array<{
    ResourceChange?: {
      Action?: unknown;
      LogicalResourceId?: unknown;
      ResourceType?: unknown;
      Replacement?: unknown;
    };
  }>;
}) {
  const changes: BootstrapChange[] = [];
  for (const item of value.Changes ?? []) {
    const change = item.ResourceChange;
    if (
      typeof change?.Action !== "string" ||
      typeof change.LogicalResourceId !== "string" ||
      typeof change.ResourceType !== "string"
    ) {
      throw new Error("CloudFormation returned an invalid bootstrap change.");
    }
    changes.push({
      action: change.Action,
      logical_resource_id: change.LogicalResourceId,
      resource_type: change.ResourceType,
      replacement:
        typeof change.Replacement === "string"
          ? change.Replacement
          : change.Action === "Modify"
            ? "Unknown"
            : "False",
    });
  }
  return changes;
}

function destructiveChanges(changes: BootstrapChange[]) {
  return changes.filter(
    (change) =>
      !["Add", "Modify"].includes(change.action) ||
      change.replacement !== "False",
  );
}

function noChanges(value: { Status?: unknown; StatusReason?: unknown }) {
  return (
    value.Status === "FAILED" &&
    typeof value.StatusReason === "string" &&
    /didn'?t contain changes|no updates are to be performed/i.test(
      value.StatusReason,
    )
  );
}

export async function bootstrapAws(
  rawOptions: AwsBootstrapOptions,
  dependencies: AwsBootstrapDependencies,
) {
  let options = normalizeOptions(rawOptions, dependencies.env);
  const template = await readFile(TEMPLATE_PATH, "utf8").catch(() => {
    throw new Error(
      "The HayaSend package is incomplete: the AWS bootstrap template is missing.",
    );
  });
  const awsVersion = await run(dependencies, "aws", ["--version"], "AWS CLI");
  const identity = await json<{ Account?: unknown; Arn?: unknown }>(
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
      "The AWS caller does not belong to the exact account supplied to bootstrap aws.",
    );
  }
  await run(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "validate-template",
      "--template-body",
      `file://${TEMPLATE_PATH}`,
    ]),
    "CloudFormation bootstrap-template validation",
  );
  const existing = await describeStack(dependencies, options);
  if (existing.exists) {
    options = {
      ...options,
      applicationStackPrefix:
        rawOptions.applicationStackPrefix ??
        existing.parameters.ApplicationStackNamePrefix ??
        options.applicationStackPrefix,
      artifactRetentionDays:
        rawOptions.artifactRetentionDays ??
        existing.parameters.ArtifactRetentionDays ??
        options.artifactRetentionDays,
      permissionsBoundaryArn:
        rawOptions.permissionsBoundaryArn ??
        existing.parameters.PermissionsBoundaryArn ??
        options.permissionsBoundaryArn,
    };
    validatePermissionsBoundary(
      options.permissionsBoundaryArn,
      options.account,
      options.region,
    );
    validateStackIsolation(options.stack, options.applicationStackPrefix);
  }
  if (
    existing.exists &&
    ![
      "CREATE_COMPLETE",
      "UPDATE_COMPLETE",
      "UPDATE_ROLLBACK_COMPLETE",
    ].includes(existing.status ?? "")
  ) {
    throw new Error(
      `Bootstrap stack ${options.stack} is in ${existing.status ?? "an unknown state"}; recover it before updating.`,
    );
  }
  dependencies.log(
    JSON.stringify({
      schema_version: 1,
      object: "aws_bootstrap_plan",
      ok: true,
      mutating: options.apply,
      mode: options.apply ? "apply" : "plan",
      tools: {
        aws_cli: (awsVersion.stdout || awsVersion.stderr)
          .trim()
          .split(/\r?\n/, 1)[0],
      },
      identity: {
        account: options.account,
        principal_arn: identity.Arn,
      },
      region: options.region,
      stack: {
        name: options.stack,
        exists: existing.exists,
        status: existing.status ?? null,
        termination_protection: existing.terminationProtectionEnabled ?? false,
      },
      template: {
        source: "package:deploy/aws-cloudformation-bootstrap.yaml",
        sha256: createHash("sha256").update(template).digest("hex"),
        validation: "pass",
      },
      application_stack_name_prefix: options.applicationStackPrefix,
      artifact_retention_days: Number(options.artifactRetentionDays),
      permissions_boundary_arn: options.permissionsBoundaryArn || null,
      trust_boundary:
        "The bootstrap caller may create IAM roles, policies, and the artifact bucket. Attach the output operator policy only after review; normal deployments then pass only the exact output service role.",
      ...(options.apply ? {} : { apply_command: applyCommand(options) }),
    }),
  );
  if (!options.apply) {
    return;
  }
  if (options.confirmAccount !== options.account) {
    throw new Error(
      `bootstrap aws --apply requires --confirm-account ${options.account}.`,
    );
  }

  const changeSetName = `hayasend-bootstrap-${randomUUID()}`;
  const created = await json<{ Id?: unknown; StackId?: unknown }>(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "create-change-set",
      "--stack-name",
      options.stack,
      "--change-set-name",
      changeSetName,
      "--change-set-type",
      existing.exists ? "UPDATE" : "CREATE",
      "--template-body",
      `file://${TEMPLATE_PATH}`,
      "--capabilities",
      "CAPABILITY_IAM",
      "--parameters",
      `ParameterKey=ApplicationStackNamePrefix,ParameterValue=${options.applicationStackPrefix}`,
      `ParameterKey=ArtifactRetentionDays,ParameterValue=${options.artifactRetentionDays}`,
      ...(options.permissionsBoundaryArn
        ? [
            `ParameterKey=PermissionsBoundaryArn,ParameterValue=${options.permissionsBoundaryArn}`,
          ]
        : []),
      "--tags",
      "Key=Project,Value=HayaSend",
      "Key=ManagedBy,Value=HayaSendCLI",
    ]),
    "CloudFormation bootstrap change-set creation",
  );
  if (
    typeof created.Id !== "string" ||
    !created.Id.includes(`:changeSet/${changeSetName}/`)
  ) {
    throw new Error(
      "CloudFormation returned an unexpected bootstrap change-set identity.",
    );
  }
  const wait = await dependencies.runCommand(
    "aws",
    awsArgs(options, [
      "cloudformation",
      "wait",
      "change-set-create-complete",
      "--change-set-name",
      created.Id,
    ]),
    {
      cwd: dependencies.cwd,
      env: dependencies.env,
      timeoutMs: CHANGE_SET_TIMEOUT_MS,
    },
  );
  const described = await json<{
    ChangeSetId?: unknown;
    StackId?: unknown;
    Status?: unknown;
    StatusReason?: unknown;
    Changes?: Array<{
      ResourceChange?: {
        Action?: unknown;
        LogicalResourceId?: unknown;
        ResourceType?: unknown;
        Replacement?: unknown;
      };
    }>;
  }>(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "describe-change-set",
      "--change-set-name",
      created.Id,
    ]),
    "CloudFormation bootstrap change-set inspection",
  );
  if (
    described.ChangeSetId !== created.Id ||
    (typeof described.StackId === "string" &&
      !described.StackId.includes(`:stack/${options.stack}/`))
  ) {
    throw new Error(
      "CloudFormation returned a bootstrap change set for a different stack.",
    );
  }
  if (wait.exitCode !== 0 && noChanges(described)) {
    await run(
      dependencies,
      "aws",
      awsArgs(options, [
        "cloudformation",
        "delete-change-set",
        "--change-set-name",
        created.Id,
      ]),
      "Empty bootstrap change-set cleanup",
    );
    const protectedStack = await enforceTerminationProtection(
      dependencies,
      options,
      existing,
    );
    const outputs = validateOutputs(protectedStack.outputs, options);
    dependencies.log(
      JSON.stringify({
        schema_version: 1,
        object: "aws_bootstrap_result",
        ok: true,
        applied: false,
        no_changes: true,
        stack: options.stack,
        protections: {
          termination_protection: true,
        },
        outputs: {
          cloudformation_role_arn: outputs.roleArn,
          artifact_bucket: outputs.bucket,
          operator_policy_arn: outputs.policyArn,
        },
      }),
    );
    return;
  }
  if (wait.exitCode !== 0 || described.Status !== "CREATE_COMPLETE") {
    throw new Error(
      `CloudFormation did not create the bootstrap change set: ${redactAwsDiagnostics(
        String(described.StatusReason ?? "unknown reason"),
      )}`,
    );
  }
  const changes = summarizeChanges(described);
  const destructive = destructiveChanges(changes);
  dependencies.log(
    JSON.stringify({
      schema_version: 1,
      object: "aws_bootstrap_change_set_plan",
      ok: destructive.length === 0 || options.allowDestructiveChanges,
      change_set_id: created.Id,
      changes,
      destructive_changes: destructive,
      requires_destructive_acknowledgement: destructive.length > 0,
    }),
  );
  if (destructive.length > 0 && !options.allowDestructiveChanges) {
    throw new Error(
      "The bootstrap change set contains a removal or possible replacement. It was not executed; rerun with --allow-destructive-changes only after reviewing every change.",
    );
  }
  await run(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "execute-change-set",
      "--change-set-name",
      created.Id,
    ]),
    "CloudFormation bootstrap change-set execution",
  );
  await run(
    dependencies,
    "aws",
    awsArgs(options, [
      "cloudformation",
      "wait",
      existing.exists ? "stack-update-complete" : "stack-create-complete",
      "--stack-name",
      options.stack,
    ]),
    "CloudFormation bootstrap completion",
    STACK_TIMEOUT_MS,
  );
  const deployed = await describeStack(dependencies, options);
  const protectedStack = await enforceTerminationProtection(
    dependencies,
    options,
    deployed,
  );
  const outputs = validateOutputs(protectedStack.outputs, options);
  dependencies.log(
    JSON.stringify({
      schema_version: 1,
      object: "aws_bootstrap_result",
      ok: true,
      applied: true,
      no_changes: false,
      stack: options.stack,
      status: protectedStack.status ?? null,
      protections: {
        termination_protection: true,
      },
      outputs: {
        cloudformation_role_arn: outputs.roleArn,
        artifact_bucket: outputs.bucket,
        operator_policy_arn: outputs.policyArn,
      },
      next: {
        review_and_attach_operator_policy: outputs.policyArn,
        deploy_plan_command: [
          "npx",
          "--yes",
          `@haya-inc/hayasend@${PACKAGE_VERSION}`,
          "deploy",
          "aws",
          "--account",
          options.account,
          "--region",
          options.region,
          "--stack",
          options.applicationStackPrefix,
          "--cloudformation-role-arn",
          outputs.roleArn,
          "--artifact-bucket",
          outputs.bucket,
          ...(options.profile ? ["--profile", options.profile] : []),
        ],
      },
    }),
  );
}
