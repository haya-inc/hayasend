import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  redactAwsDiagnostics,
  renderAwsTemplate,
  type CommandResult,
  type CommandRunner,
} from "../src/cli-aws-deploy.js";
import { runCli } from "../src/cli.js";

function result(stdout = "", exitCode = 0, stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

function json(value: unknown) {
  return result(JSON.stringify(value));
}

function missingStack() {
  return result(
    "",
    254,
    "An error occurred (ValidationError): Stack with id hayasend does not exist",
  );
}

function stackPolicy() {
  return json({
    StackPolicyBody: JSON.stringify({
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
          Resource: [
            "LogicalResourceId/BackupVault",
            "LogicalResourceId/DataTable",
            "LogicalResourceId/InboundBucket",
            "LogicalResourceId/InboundKey",
            "LogicalResourceId/PayloadBucket",
          ],
        },
      ],
    }),
  });
}

function capturingIo() {
  const logs: string[] = [];
  return {
    logs,
    io: {
      log: (message: string) => logs.push(message),
      error: vi.fn(),
    },
  };
}

function baseRunner(
  overrides: (
    command: string,
    args: string[],
  ) => CommandResult | undefined = () => undefined,
) {
  return vi.fn<CommandRunner>(async (command, args) => {
    const overridden = overrides(command, args);
    if (overridden) {
      return overridden;
    }
    if (command === "aws" && args[0] === "--version") {
      return result("", 0, "aws-cli/2.35.24 Python/3.13");
    }
    if (command === "sam" && args[0] === "--version") {
      return result("SAM CLI, version 1.164.0");
    }
    if (command === "npm" && args[0] === "--version") {
      return result("12.0.2");
    }
    if (command === "npm" && args[0] === "root" && args[1] === "--global") {
      return result(join(tmpdir(), "hayasend-test-npm-root"));
    }
    if (command === "aws" && args[0] === "sts") {
      return json({
        Account: "123456789012",
        Arn: "arn:aws:sts::123456789012:assumed-role/Deployer/session",
      });
    }
    if (command === "aws" && args[0] === "sesv2") {
      return json({
        ProductionAccessEnabled: true,
        SendingEnabled: true,
        EnforcementStatus: "HEALTHY",
        SendQuota: {
          Max24HourSend: 50_000,
          MaxSendRate: 14,
          SentLast24Hours: 25,
        },
      });
    }
    if (
      command === "aws" &&
      args[0] === "cloudformation" &&
      ["set-stack-policy", "update-termination-protection"].includes(
        args[1] ?? "",
      )
    ) {
      return result();
    }
    if (
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "list-stack-resources"
    ) {
      return json({
        StackResourceSummaries: [
          ["DataTable", "AWS::DynamoDB::Table"],
          ["PayloadBucket", "AWS::S3::Bucket"],
          ["BackupVault", "AWS::Backup::BackupVault"],
        ].map(([LogicalResourceId, ResourceType]) => ({
          LogicalResourceId,
          ResourceType,
          ResourceStatus: "CREATE_COMPLETE",
        })),
      });
    }
    if (
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "get-stack-policy"
    ) {
      return stackPolicy();
    }
    if (
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "describe-stacks"
    ) {
      return missingStack();
    }
    if (command === "sam" && ["validate", "build"].includes(args[0] ?? "")) {
      return result("ok");
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
}

describe("plan-first AWS deployment CLI", () => {
  it("renders the reviewed two-phase SAM template without enabling a first-deploy canary", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../template.yaml", import.meta.url)),
      "utf8",
    );
    const bootstrap = renderAwsTemplate(source, new Set());
    expect(bootstrap).not.toContain("DeploymentPreference:");
    expect(bootstrap).not.toContain("HAYASEND_GRADUAL_DEPLOYMENT");
    expect(bootstrap.match(/AutoPublishAlias: live/g)).toHaveLength(5);
    expect(bootstrap).toContain("AWSBackupServiceRolePolicyForS3Backup");
    expect(bootstrap).toContain("AWSBackupServiceRolePolicyForS3Restore");

    const gradual = renderAwsTemplate(
      source,
      new Set([
        "ApiFunctionAliaslive",
        "WorkerFunctionAliaslive",
        "DispatcherFunctionAliaslive",
        "SesEventsFunctionAliaslive",
        "InboundFunctionAliaslive",
      ]),
    );
    expect(gradual.match(/DeploymentPreference:/g)).toHaveLength(5);
    expect(gradual).toContain("!Ref ApiFunctionAliasErrorAlarm");
    expect(gradual).toContain("!Ref InboundFunctionAliasErrorAlarm");
    expect(gradual).toContain("PassthroughCondition: true");
    expect(gradual).not.toContain("HAYASEND_GRADUAL_DEPLOYMENT");
  });

  it("renders a read-only plan with identity, SES quota, and exact inputs", async () => {
    const capture = capturingIo();
    const runner = baseRunner();

    await runCli(
      [
        "deploy",
        "aws",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
        "--stack",
        "hayasend-beta",
        "--tag",
        "Environment=beta",
      ],
      {
        cwd: process.cwd(),
        env: {},
        io: capture.io,
        runCommand: runner,
      },
    );

    const plan = JSON.parse(capture.logs[0] ?? "{}");
    expect(plan).toMatchObject({
      schema_version: 1,
      object: "aws_deployment_plan",
      ok: true,
      mutating: false,
      mode: "plan",
      tools: {
        aws_cli: "aws-cli/2.35.24 Python/3.13",
        sam_cli: "SAM CLI, version 1.164.0",
        npm_cli: "12.0.2",
      },
      identity: {
        account: "123456789012",
        principal_arn:
          "arn:aws:sts::123456789012:assumed-role/Deployer/session",
      },
      region: "ap-northeast-1",
      stack: { name: "hayasend-beta", exists: false, status: null },
      ses: {
        production_access: true,
        sending_enabled: true,
        enforcement_status: "HEALTHY",
        quota: {
          max_24_hour_send: 50_000,
          max_send_rate: 14,
          sent_last_24_hours: 25,
        },
      },
      parameters: {
        ApiThrottlingRateLimit: "10",
        ApiThrottlingBurstLimit: "20",
        EnableInbound: "false",
        InboundRecipientSuffixes: "@example.invalid",
        LogRetentionDays: "30",
        TemplateHistoryRetentionDays: "90",
        TemplateHistoryLimit: "50",
        WorkerReservedConcurrency: "10",
        EnableBackups: "true",
        BackupRetentionDays: "35",
        PayloadNoncurrentVersionRetentionDays: "7",
        EnableRestoreTesting: "false",
      },
      tags: {
        Project: "HayaSend",
        ManagedBy: "HayaSendCLI",
        Environment: "beta",
      },
      dns_changes: "never",
    });
    expect(plan.template).toMatchObject({
      source: "package:template.yaml",
      validation: "pass",
      build: "pass",
    });
    expect(plan.template.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.parameters.RestoreTestingPlanName).toMatch(
      /^HayaSend_hayasend_beta_[a-f0-9]{10}$/,
    );
    expect(plan.parameters.BackupVaultName).toBe(
      plan.parameters.RestoreTestingPlanName,
    );
    expect(plan.backups).toMatchObject({
      enabled: true,
      retention_days: 35,
      resources_ready: false,
      restore_testing: { enabled: false, resources_ready: true },
    });
    expect(plan.apply_command).toContain("--apply");
    expect(plan.apply_command.slice(0, 2)).toEqual(["npx", "--yes"]);
    expect(plan.apply_command[2]).toMatch(/^@haya-inc\/hayasend@\d+\.\d+\.\d+/);
    expect(plan.apply_command.slice(3, 5)).toEqual(["deploy", "aws"]);
    expect(plan.apply_command).toEqual(
      expect.arrayContaining([
        "--api-rate-limit",
        "10",
        "--api-burst-limit",
        "20",
        "--log-retention-days",
        "30",
      ]),
    );
    expect(
      runner.mock.calls.some(
        ([command, args]) => command === "sam" && args[0] === "deploy",
      ),
    ).toBe(false);
    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === "sam" &&
          args[0] === "build" &&
          args.includes("--parallel"),
      ),
    ).toBe(true);
    const buildCall = runner.mock.calls.find(
      ([command, args]) => command === "sam" && args[0] === "build",
    );
    expect(buildCall?.[2].env?.HAYASEND_REAL_NPM_CLI).toMatch(
      /npm[/\\]bin[/\\]npm-cli\.js$/,
    );
    expect(buildCall?.[2].env?.PATH).toContain("npm-sam-compat");
  });

  it("accepts independent decimal rate and integer burst overrides", async () => {
    const capture = capturingIo();

    await runCli(
      [
        "deploy",
        "aws",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
        "--api-rate-limit",
        "7.5",
        "--api-burst-limit",
        "3",
      ],
      {
        cwd: process.cwd(),
        env: {},
        io: capture.io,
        runCommand: baseRunner(),
      },
    );

    expect(JSON.parse(capture.logs[0] ?? "{}").parameters).toMatchObject({
      ApiThrottlingRateLimit: "7.5",
      ApiThrottlingBurstLimit: "3",
    });
  });

  it("enables alarm-driven traffic shifting only after live aliases exist", async () => {
    const capture = capturingIo();
    let renderedTemplate = "";
    const aliasIds = [
      "ApiFunctionAliaslive",
      "WorkerFunctionAliaslive",
      "DispatcherFunctionAliaslive",
      "SesEventsFunctionAliaslive",
    ];
    const runner = baseRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        return json({
          Stacks: [
            {
              StackStatus: "UPDATE_COMPLETE",
              Parameters: [
                {
                  ParameterKey: "EnableGradualDeployments",
                  ParameterValue: "false",
                },
              ],
              Outputs: [],
            },
          ],
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "list-stack-resources"
      ) {
        return json({
          StackResourceSummaries: aliasIds.map((LogicalResourceId) => ({
            LogicalResourceId,
            ResourceType: "AWS::Lambda::Alias",
            ResourceStatus: "UPDATE_COMPLETE",
          })),
        });
      }
      if (command === "sam" && args[0] === "validate") {
        const templatePath = args.at(args.indexOf("--template-file") + 1) ?? "";
        renderedTemplate = readFileSync(templatePath, "utf8");
        return result("ok");
      }
      return undefined;
    });

    await runCli(
      [
        "upgrade",
        "aws",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
      ],
      {
        cwd: process.cwd(),
        env: {},
        io: capture.io,
        runCommand: runner,
      },
    );

    const plan = JSON.parse(capture.logs[0] ?? "{}");
    expect(plan.parameters.EnableGradualDeployments).toBe("true");
    expect(plan.deployments).toMatchObject({
      enabled: true,
      aliases_ready: true,
      mode: "alarm_rollback",
    });
    expect(renderedTemplate.match(/DeploymentPreference:/g)).toHaveLength(4);
    expect(renderedTemplate).not.toContain(
      "!Ref InboundFunctionAliasErrorAlarm\n        PassthroughCondition",
    );
  });

  it("builds only the packaged application outside a source checkout", async () => {
    const unrelatedWorkingDirectory = join(
      tmpdir(),
      "unrelated-hayasend-consumer",
    );
    const runner = baseRunner();

    await runCli(
      [
        "deploy",
        "aws",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
      ],
      {
        cwd: unrelatedWorkingDirectory,
        env: {},
        io: capturingIo().io,
        runCommand: runner,
      },
    );

    const packagedTemplate = fileURLToPath(
      new URL("../template.yaml", import.meta.url),
    );
    const buildCall = runner.mock.calls.find(
      ([command, args]) => command === "sam" && args[0] === "build",
    );
    expect(buildCall).toBeDefined();
    const buildArgs = buildCall?.[1] ?? [];
    const derivedTemplate =
      buildArgs.at(buildArgs.indexOf("--template-file") + 1) ?? "";
    expect(derivedTemplate).toContain("hayasend-deploy-");
    expect(derivedTemplate).not.toBe(packagedTemplate);
    expect(buildArgs).not.toContain(
      join(unrelatedWorkingDirectory, "template.yaml"),
    );
    expect(buildArgs.at(buildArgs.indexOf("--base-dir") + 1)).toBe(
      dirname(packagedTemplate),
    );
    expect(buildCall?.[2].cwd).toBe(unrelatedWorkingDirectory);
  });

  it("fails closed on account mismatch before reading SES or CloudFormation", async () => {
    const runner = baseRunner((command, args) => {
      if (command === "aws" && args[0] === "sts") {
        return json({
          Account: "999999999999",
          Arn: "arn:aws:sts::999999999999:assumed-role/Wrong/session",
        });
      }
      return undefined;
    });

    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: runner,
        },
      ),
    ).rejects.toThrow("does not match --account");

    expect(
      runner.mock.calls.some(
        ([command, args]) => command === "aws" && args[0] === "sesv2",
      ),
    ).toBe(false);
    expect(
      runner.mock.calls.some(
        ([command, args]) => command === "aws" && args[0] === "cloudformation",
      ),
    ).toBe(false);
  });

  it("refuses a stack with an operation already in progress", async () => {
    const runner = baseRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        return json({
          Stacks: [
            {
              StackStatus: "UPDATE_IN_PROGRESS",
              Parameters: [],
              Outputs: [],
            },
          ],
        });
      }
      return undefined;
    });

    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: runner,
        },
      ),
    ).rejects.toThrow("recover it before deploying");

    expect(
      runner.mock.calls.some(
        ([command, args]) => command === "sam" && args[0] === "validate",
      ),
    ).toBe(false);
  });

  it("rejects a CloudFormation role outside the exact account or partition", async () => {
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--cloudformation-role-arn",
          "arn:aws:iam::999999999999:role/HayaSendCloudFormation",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: baseRunner(),
        },
      ),
    ).rejects.toThrow("exact expected AWS account and partition");

    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--cloudformation-role-arn",
          "arn:aws-cn:iam::123456789012:role/HayaSendCloudFormation",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: baseRunner(),
        },
      ),
    ).rejects.toThrow("exact expected AWS account and partition");
  });

  it("creates, inspects, and executes one exact additive change set", async () => {
    const capture = capturingIo();
    let stackReads = 0;
    let changeSetReads = 0;
    const changeSetArn =
      "arn:aws:cloudformation:ap-northeast-1:123456789012:" +
      "changeSet/hayasend-cli/1234";
    const runner = baseRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        stackReads += 1;
        if (stackReads === 1) {
          return missingStack();
        }
        return json({
          Stacks: [
            {
              StackStatus: "CREATE_COMPLETE",
              RoleARN: "arn:aws:iam::123456789012:role/HayaSendCloudFormation",
              EnableTerminationProtection: true,
              Parameters: [],
              Outputs: [
                {
                  OutputKey: "ApiBaseUrl",
                  OutputValue: "https://api.example.test",
                },
                {
                  OutputKey: "BootstrapSecretArn",
                  OutputValue:
                    "arn:aws:secretsmanager:ap-northeast-1:" +
                    "123456789012:secret:hayasend",
                },
                {
                  OutputKey: "AlarmTopicArn",
                  OutputValue: "arn:aws:sns:ap-northeast-1:123456789012:alarms",
                },
                {
                  OutputKey: "OperationsDashboardName",
                  OutputValue: "hayasend-operations",
                },
              ],
            },
          ],
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "list-change-sets"
      ) {
        changeSetReads += 1;
        return changeSetReads === 1
          ? missingStack()
          : json({
              Summaries: [
                { ChangeSetId: changeSetArn, Status: "CREATE_COMPLETE" },
              ],
            });
      }
      if (command === "sam" && args[0] === "deploy") {
        return result("Changeset created");
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-change-set"
      ) {
        return json({
          ChangeSetId: changeSetArn,
          StackName: "hayasend",
          ExecutionStatus: "AVAILABLE",
          Status: "CREATE_COMPLETE",
          Changes: [
            {
              ResourceChange: {
                Action: "Add",
                LogicalResourceId: "ApiFunction",
                ResourceType: "AWS::Lambda::Function",
                Replacement: "False",
                Scope: [],
              },
            },
          ],
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        ["execute-change-set", "wait"].includes(args[1] ?? "")
      ) {
        return result();
      }
      return undefined;
    });

    await runCli(
      [
        "deploy",
        "aws",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
        "--stack",
        "hayasend",
        "--worker-reserved-concurrency",
        "0",
        "--cloudformation-role-arn",
        "arn:aws:iam::123456789012:role/HayaSendCloudFormation",
        "--artifact-bucket",
        "hayasend-artifacts-123456789012",
        "--apply",
        "--tag",
        "Purpose=IntegrationTest",
      ],
      {
        cwd: process.cwd(),
        env: {},
        io: capture.io,
        runCommand: runner,
      },
    );

    expect(capture.logs.map((line) => JSON.parse(line).object)).toEqual([
      "aws_deployment_plan",
      "aws_change_set_plan",
      "aws_deployment_result",
    ]);
    expect(JSON.parse(capture.logs[1] ?? "{}")).toMatchObject({
      ok: true,
      change_set_id: changeSetArn,
      destructive_changes: [],
      changes: [
        {
          action: "Add",
          logical_resource_id: "ApiFunction",
          resource_type: "AWS::Lambda::Function",
        },
      ],
    });
    expect(JSON.parse(capture.logs[2] ?? "{}")).toMatchObject({
      ok: true,
      applied: true,
      status: "CREATE_COMPLETE",
      protections: {
        termination_protection: true,
        retained_resource_stack_policy: true,
      },
      outputs: {
        ApiBaseUrl: "https://api.example.test",
        AlarmTopicArn: "arn:aws:sns:ap-northeast-1:123456789012:alarms",
        OperationsDashboardName: "hayasend-operations",
      },
      next: {
        environment: {
          HAYASEND_BASE_URL: "https://api.example.test",
        },
        retrieve_bootstrap_key: {
          assign_stdout_to: "HAYASEND_API_KEY",
          command: expect.arrayContaining([
            "aws",
            "get-secret-value",
            "--output",
            "text",
          ]),
        },
        doctor_command: ["npm", "run", "cli", "--", "doctor"],
      },
    });
    expect(
      JSON.parse(capture.logs[2] ?? "{}").next.enable_gradual_deployments
        .command,
    ).toEqual(
      expect.arrayContaining([
        "--cloudformation-role-arn",
        "arn:aws:iam::123456789012:role/HayaSendCloudFormation",
        "--artifact-bucket",
        "hayasend-artifacts-123456789012",
      ]),
    );

    const deployCall = runner.mock.calls.find(
      ([command, args]) => command === "sam" && args[0] === "deploy",
    );
    expect(deployCall?.[1]).toEqual(
      expect.arrayContaining([
        "--no-execute-changeset",
        "--no-confirm-changeset",
        "--no-fail-on-empty-changeset",
        "--role-arn",
        "arn:aws:iam::123456789012:role/HayaSendCloudFormation",
        "--s3-bucket",
        "hayasend-artifacts-123456789012",
        "EnableInbound=false",
        "WorkerReservedConcurrency=0",
        "Purpose=IntegrationTest",
      ]),
    );
    expect(deployCall?.[1]).not.toContain("--resolve-s3");
    expect(deployCall?.[1]).not.toContain("BootstrapSecretArn=");
    const executeCall = runner.mock.calls.find(
      ([command, args]) =>
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "execute-change-set",
    );
    expect(executeCall?.[1]).toContain(changeSetArn);
    const policyCall = runner.mock.calls.find(
      ([command, args]) =>
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "set-stack-policy",
    );
    const policyBody =
      policyCall?.[1][
        (policyCall?.[1].indexOf("--stack-policy-body") ?? -2) + 1
      ];
    expect(policyBody).toContain("LogicalResourceId/DataTable");
    expect(policyBody).toContain("LogicalResourceId/PayloadBucket");
    expect(policyBody).toContain("LogicalResourceId/BackupVault");
    expect(policyBody).not.toContain("LogicalResourceId/InboundBucket");
    expect(policyBody).not.toContain("LogicalResourceId/InboundKey");
    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === "aws" &&
          args[0] === "cloudformation" &&
          args[1] === "update-termination-protection" &&
          args.includes("--enable-termination-protection"),
      ),
    ).toBe(true);
    expect(runner.mock.calls.some(([, args]) => args.includes("route53"))).toBe(
      false,
    );
  });

  it("leaves a destructive change set unexecuted without a second acknowledgement", async () => {
    const capture = capturingIo();
    let changeSetReads = 0;
    const oldChangeSet =
      "arn:aws:cloudformation:ap-northeast-1:123456789012:" + "changeSet/old/1";
    const newChangeSet =
      "arn:aws:cloudformation:ap-northeast-1:123456789012:" + "changeSet/new/2";
    const runner = baseRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        return json({
          Stacks: [
            {
              StackStatus: "UPDATE_COMPLETE",
              Parameters: [
                {
                  ParameterKey: "ApiThrottlingRateLimit",
                  ParameterValue: "7.5",
                },
                {
                  ParameterKey: "ApiThrottlingBurstLimit",
                  ParameterValue: "11",
                },
                { ParameterKey: "EnableInbound", ParameterValue: "false" },
                { ParameterKey: "LogRetentionDays", ParameterValue: "90" },
                {
                  ParameterKey: "WebhookDeliveryRetentionDays",
                  ParameterValue: "14",
                },
                {
                  ParameterKey: "RemovedLegacyParameter",
                  ParameterValue: "do-not-replay",
                },
              ],
              Outputs: [],
              Tags: [{ Key: "Owner", Value: "platform" }],
            },
          ],
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "list-change-sets"
      ) {
        changeSetReads += 1;
        return json({
          Summaries:
            changeSetReads === 1
              ? [{ ChangeSetId: oldChangeSet, Status: "CREATE_COMPLETE" }]
              : [
                  { ChangeSetId: oldChangeSet, Status: "CREATE_COMPLETE" },
                  { ChangeSetId: newChangeSet, Status: "CREATE_COMPLETE" },
                ],
        });
      }
      if (command === "sam" && args[0] === "deploy") {
        return result("Changeset created");
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-change-set"
      ) {
        return json({
          ChangeSetId: newChangeSet,
          StackName: "hayasend",
          ExecutionStatus: "AVAILABLE",
          Status: "CREATE_COMPLETE",
          Changes: [
            {
              ResourceChange: {
                Action: "Modify",
                LogicalResourceId: "DataTable",
                ResourceType: "AWS::DynamoDB::Table",
                Replacement: "Conditional",
                Scope: ["Properties"],
                PolicyAction: "Delete",
              },
            },
            {
              ResourceChange: {
                Action: "Dynamic",
                LogicalResourceId: "InboundRuleSet",
                ResourceType: "AWS::SES::ReceiptRuleSet",
              },
            },
          ],
        });
      }
      return undefined;
    });

    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--apply",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capture.io,
          runCommand: runner,
        },
      ),
    ).rejects.toThrow("--allow-destructive-changes");

    expect(JSON.parse(capture.logs[1] ?? "{}")).toMatchObject({
      ok: false,
      requires_destructive_acknowledgement: true,
      destructive_changes: [
        {
          logical_resource_id: "DataTable",
          replacement: "Conditional",
          policy_action: "Delete",
        },
        {
          action: "Dynamic",
          logical_resource_id: "InboundRuleSet",
          replacement: "Unknown",
        },
      ],
    });
    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === "aws" &&
          args[0] === "cloudformation" &&
          args[1] === "execute-change-set",
      ),
    ).toBe(false);

    const deployCall = runner.mock.calls.find(
      ([command, args]) => command === "sam" && args[0] === "deploy",
    );
    expect(deployCall?.[1]).toContain("WebhookDeliveryRetentionDays=14");
    expect(deployCall?.[1]).toContain("ApiThrottlingRateLimit=7.5");
    expect(deployCall?.[1]).toContain("ApiThrottlingBurstLimit=11");
    expect(deployCall?.[1]).toContain("LogRetentionDays=90");
    expect(deployCall?.[1]).toContain("Owner=platform");
    expect(deployCall?.[1]).not.toContain(
      "RemovedLegacyParameter=do-not-replay",
    );
  });

  it("preserves the previous fixed throttle when upgrading a legacy stack", async () => {
    const capture = capturingIo();
    const runner = baseRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        return json({
          Stacks: [
            {
              StackStatus: "UPDATE_COMPLETE",
              RoleARN: "arn:aws:iam::123456789012:role/HayaSendCloudFormation",
              EnableTerminationProtection: true,
              Parameters: [],
              Outputs: [],
            },
          ],
        });
      }
      return undefined;
    });

    await runCli(
      [
        "deploy",
        "aws",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
      ],
      {
        cwd: process.cwd(),
        env: {},
        io: capture.io,
        runCommand: runner,
      },
    );

    expect(JSON.parse(capture.logs[0] ?? "{}").parameters).toMatchObject({
      ApiThrottlingRateLimit: "50",
      ApiThrottlingBurstLimit: "100",
    });
  });

  it("reports an empty change set without executing CloudFormation", async () => {
    const capture = capturingIo();
    const unchangedChangeSet =
      "arn:aws:cloudformation:region:account:changeSet/existing/1";
    const runner = baseRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        return json({
          Stacks: [
            {
              StackStatus: "UPDATE_COMPLETE",
              RoleARN: "arn:aws:iam::123456789012:role/HayaSendCloudFormation",
              EnableTerminationProtection: true,
              Parameters: [],
              Outputs: [
                {
                  OutputKey: "ApiBaseUrl",
                  OutputValue: "https://existing.example.test",
                },
              ],
            },
          ],
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "list-change-sets"
      ) {
        return json({
          Summaries: [
            {
              ChangeSetId: unchangedChangeSet,
              Status: "CREATE_COMPLETE",
            },
          ],
        });
      }
      if (command === "sam" && args[0] === "deploy") {
        return result("No changes to deploy");
      }
      return undefined;
    });

    await runCli(
      [
        "deploy",
        "aws",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
        "--apply",
      ],
      {
        cwd: process.cwd(),
        env: {},
        io: capture.io,
        runCommand: runner,
      },
    );

    expect(JSON.parse(capture.logs[1] ?? "{}")).toMatchObject({
      object: "aws_deployment_result",
      ok: true,
      applied: true,
      no_changes: true,
      protections: {
        termination_protection: true,
        retained_resource_stack_policy: true,
      },
      cloudformation: {
        service_role_arn:
          "arn:aws:iam::123456789012:role/HayaSendCloudFormation",
      },
      outputs: { ApiBaseUrl: "https://existing.example.test" },
    });
    const deployCall = runner.mock.calls.find(
      ([command, args]) => command === "sam" && args[0] === "deploy",
    );
    expect(deployCall?.[1]).toEqual(
      expect.arrayContaining([
        "--role-arn",
        "arn:aws:iam::123456789012:role/HayaSendCloudFormation",
      ]),
    );
    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === "aws" &&
          args[0] === "cloudformation" &&
          args[1] === "execute-change-set",
      ),
    ).toBe(false);
  });

  it("refuses concurrent change-set activity without guessing which ARN to execute", async () => {
    let changeSetReads = 0;
    const runner = baseRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "list-change-sets"
      ) {
        changeSetReads += 1;
        return changeSetReads === 1
          ? missingStack()
          : json({
              Summaries: [
                {
                  ChangeSetId:
                    "arn:aws:cloudformation:region:account:changeSet/one/1",
                  Status: "CREATE_COMPLETE",
                },
                {
                  ChangeSetId:
                    "arn:aws:cloudformation:region:account:changeSet/two/2",
                  Status: "CREATE_COMPLETE",
                },
              ],
            });
      }
      if (command === "sam" && args[0] === "deploy") {
        return result("Changeset created");
      }
      return undefined;
    });

    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--apply",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: runner,
        },
      ),
    ).rejects.toThrow("concurrent deployment activity");

    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === "aws" &&
          args[0] === "cloudformation" &&
          args[1] === "execute-change-set",
      ),
    ).toBe(false);
  });

  it("reports redacted CloudFormation events when a stack wait fails", async () => {
    let changeSetReads = 0;
    let stackReads = 0;
    const changeSetArn =
      "arn:aws:cloudformation:ap-northeast-1:123456789012:" +
      "changeSet/hayasend-cli/failed";
    const runner = baseRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        stackReads += 1;
        return stackReads === 1
          ? missingStack()
          : json({
              Stacks: [
                {
                  StackStatus: "ROLLBACK_COMPLETE",
                  Parameters: [],
                  Outputs: [],
                },
              ],
            });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "list-change-sets"
      ) {
        changeSetReads += 1;
        return changeSetReads === 1
          ? missingStack()
          : json({
              Summaries: [
                { ChangeSetId: changeSetArn, Status: "CREATE_COMPLETE" },
              ],
            });
      }
      if (command === "sam" && args[0] === "deploy") {
        return result("Changeset created");
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-change-set"
      ) {
        return json({
          ChangeSetId: changeSetArn,
          StackName: "hayasend",
          ExecutionStatus: "AVAILABLE",
          Status: "CREATE_COMPLETE",
          Changes: [
            {
              ResourceChange: {
                Action: "Add",
                LogicalResourceId: "ApiFunction",
                ResourceType: "AWS::Lambda::Function",
                Replacement: "False",
              },
            },
          ],
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "execute-change-set"
      ) {
        return result();
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "wait"
      ) {
        return result("", 255, "waiter failed");
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stack-events"
      ) {
        return json([
          [
            "2026-07-26T00:00:00Z",
            "ApiFunction",
            "CREATE_FAILED",
            "authorization=private-token re_private_diagnostic",
          ],
        ]);
      }
      return undefined;
    });

    let failure: unknown;
    try {
      await runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--apply",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: runner,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("ROLLBACK_COMPLETE");
    expect((failure as Error).message).toContain("Recent failure events");
    expect((failure as Error).message).not.toContain("private-token");
    expect((failure as Error).message).not.toContain("re_private_diagnostic");
  });

  it("validates high-risk options before running external commands", async () => {
    const runner = baseRunner();
    const dependencies = {
      cwd: process.cwd(),
      env: {},
      io: capturingIo().io,
      runCommand: runner,
    };

    await expect(
      runCli(["deploy", "aws", "--region", "ap-northeast-1"], dependencies),
    ).rejects.toThrow("--account or HAYASEND_AWS_ACCOUNT_ID");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--allow-destructive-changes",
        ],
        dependencies,
      ),
    ).rejects.toThrow("requires --apply");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--enable-inbound",
          "--disable-inbound",
        ],
        dependencies,
      ),
    ).rejects.toThrow("cannot be combined");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--tag",
          "aws:Owner=forbidden",
        ],
        dependencies,
      ),
    ).rejects.toThrow("reserved aws:");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--enable-inbound",
        ],
        dependencies,
      ),
    ).rejects.toThrow("non-.invalid recipient suffixes");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--bootstrap-secret-arn",
          "arn:aws:secretsmanager:ap-northeast-1:" +
            "999999999999:secret:wrong-account",
        ],
        dependencies,
      ),
    ).rejects.toThrow("expected account and Region");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--inbound-recipient-suffixes",
          "@bad..example.com",
        ],
        dependencies,
      ),
    ).rejects.toThrow("comma-separated @domain suffixes");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--enable-inbound",
          "--inbound-recipient-suffixes",
          "@mail.EXAMPLE.INVALID",
        ],
        dependencies,
      ),
    ).rejects.toThrow("non-.invalid recipient suffixes");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--enable-backups",
          "--disable-backups",
        ],
        dependencies,
      ),
    ).rejects.toThrow(
      "--enable-backups and --disable-backups cannot be combined",
    );
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--enable-restore-testing",
          "--disable-restore-testing",
        ],
        dependencies,
      ),
    ).rejects.toThrow(
      "--enable-restore-testing and --disable-restore-testing cannot be combined",
    );
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--enable-restore-testing",
          "--disable-backups",
        ],
        dependencies,
      ),
    ).rejects.toThrow(
      "--enable-restore-testing cannot be combined with --disable-backups",
    );
    const callsBeforeTemplateHistoryValidation = runner.mock.calls.length;
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--api-rate-limit",
          "0",
        ],
        dependencies,
      ),
    ).rejects.toThrow("--api-rate-limit must be between 1 and 10000");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--api-rate-limit",
          "1e2",
        ],
        dependencies,
      ),
    ).rejects.toThrow("--api-rate-limit must be a plain decimal number");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--api-burst-limit",
          "5001",
        ],
        dependencies,
      ),
    ).rejects.toThrow("--api-burst-limit must be between 1 and 5000");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--template-history-retention-days",
          "366",
        ],
        dependencies,
      ),
    ).rejects.toThrow(
      "--template-history-retention-days must be between 1 and 365",
    );
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--template-history-limit",
          "51",
        ],
        dependencies,
      ),
    ).rejects.toThrow("--template-history-limit must be between 1 and 50");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--worker-reserved-concurrency",
          "1001",
        ],
        dependencies,
      ),
    ).rejects.toThrow(
      "--worker-reserved-concurrency must be between 0 and 1000",
    );
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--log-retention-days",
          "2",
        ],
        dependencies,
      ),
    ).rejects.toThrow(
      "--log-retention-days must be a supported CloudWatch Logs retention value",
    );
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--backup-retention-days",
          "366",
        ],
        dependencies,
      ),
    ).rejects.toThrow("--backup-retention-days must be between 1 and 365");
    await expect(
      runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--payload-noncurrent-version-retention-days",
          "31",
        ],
        dependencies,
      ),
    ).rejects.toThrow(
      "--payload-noncurrent-version-retention-days must be between 1 and 30",
    );
    expect(runner.mock.calls).toHaveLength(
      callsBeforeTemplateHistoryValidation,
    );
  });

  it("redacts secrets in external command failures", async () => {
    const runner = baseRunner((command, args) => {
      if (command === "sam" && args[0] === "validate") {
        return result(
          "",
          1,
          "aws_secret_access_key=very-secret-value re_private_diagnostic",
        );
      }
      return undefined;
    });

    let failure: unknown;
    try {
      await runCli(
        [
          "deploy",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: runner,
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("very-secret-value");
    expect((failure as Error).message).not.toContain("re_private_diagnostic");
  });

  it("redacts AWS, HayaSend, and authorization secrets from diagnostics", () => {
    const awsAccessKey = ["AKIA", "1234567890ABCDEF"].join("");
    const awsTemporaryAccessKey = ["ASIA", "1234567890ABCDEF"].join("");
    const redacted = redactAwsDiagnostics(
      [
        "aws_secret_access_key=very-secret-value",
        "aws_session_token:temporary-token",
        "Authorization=Bearer-secret",
        awsAccessKey,
        awsTemporaryAccessKey,
        "re_super_private_key",
        "whsec_super_private_key",
      ].join(" "),
    );

    expect(redacted).not.toContain("very-secret-value");
    expect(redacted).not.toContain("temporary-token");
    expect(redacted).not.toContain("Bearer-secret");
    expect(redacted).not.toContain(awsAccessKey);
    expect(redacted).not.toContain(awsTemporaryAccessKey);
    expect(redacted).not.toContain("re_super_private_key");
    expect(redacted).not.toContain("whsec_super_private_key");
  });
});
