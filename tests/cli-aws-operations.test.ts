import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
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

function missingStack(name = "hayasend") {
  return result(
    "",
    254,
    `An error occurred (ValidationError): Stack with id ${name} does not exist`,
  );
}

function existingStack(overrides: Record<string, unknown> = {}) {
  return json({
    Stacks: [
      {
        StackStatus: "UPDATE_COMPLETE",
        RoleARN:
          "arn:aws:iam::123456789012:role/HayaSendCloudFormationServiceRole",
        CreationTime: "2026-07-28T00:00:00.000Z",
        LastUpdatedTime: "2026-07-29T00:00:00.000Z",
        EnableTerminationProtection: true,
        DriftInformation: {
          StackDriftStatus: "IN_SYNC",
          LastCheckTimestamp: "2026-07-29T00:01:00.000Z",
        },
        Parameters: [
          {
            ParameterKey: "EnableGradualDeployments",
            ParameterValue: "true",
          },
          {
            ParameterKey: "DeploymentPreferenceType",
            ParameterValue: "Canary10Percent5Minutes",
          },
          { ParameterKey: "EnableInbound", ParameterValue: "false" },
          { ParameterKey: "EnableBackups", ParameterValue: "true" },
          { ParameterKey: "BackupRetentionDays", ParameterValue: "35" },
          {
            ParameterKey: "PayloadNoncurrentVersionRetentionDays",
            ParameterValue: "7",
          },
          { ParameterKey: "EnableRestoreTesting", ParameterValue: "true" },
          {
            ParameterKey: "RestoreTestingPlanName",
            ParameterValue: "HayaSend_hayasend_1234567890",
          },
        ],
        Outputs: [
          {
            OutputKey: "ApiBaseUrl",
            OutputValue: "https://api.example.test",
          },
          {
            OutputKey: "BootstrapSecretArn",
            OutputValue:
              "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:hayasend",
          },
          {
            OutputKey: "AlarmTopicArn",
            OutputValue:
              "arn:aws:sns:ap-northeast-1:123456789012:hayasend-alarms",
          },
          {
            OutputKey: "OperationsDashboardName",
            OutputValue: "hayasend-operations",
          },
        ],
        Tags: [
          { Key: "Project", Value: "HayaSend" },
          { Key: "ManagedBy", Value: "HayaSendCLI" },
        ],
        ...overrides,
      },
    ],
  });
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

function stackResources() {
  return json({
    StackResourceSummaries: [
      {
        LogicalResourceId: "Api",
        PhysicalResourceId: "api-123",
        ResourceType: "AWS::ApiGatewayV2::Api",
        ResourceStatus: "CREATE_COMPLETE",
      },
      {
        LogicalResourceId: "WorkerErrorAlarm",
        PhysicalResourceId: "hayasend-worker-errors",
        ResourceType: "AWS::CloudWatch::Alarm",
        ResourceStatus: "CREATE_COMPLETE",
      },
      {
        LogicalResourceId: "DataTable",
        PhysicalResourceId: "hayasend-data",
        ResourceType: "AWS::DynamoDB::Table",
        ResourceStatus: "CREATE_COMPLETE",
      },
      {
        LogicalResourceId: "PayloadBucket",
        PhysicalResourceId: "hayasend-payloads-123456789012",
        ResourceType: "AWS::S3::Bucket",
        ResourceStatus: "CREATE_COMPLETE",
      },
      ...[
        "ApiFunction",
        "WorkerFunction",
        "DispatcherFunction",
        "SesEventsFunction",
      ].flatMap((name) => [
        {
          LogicalResourceId: `${name}Aliaslive`,
          PhysicalResourceId: "live",
          ResourceType: "AWS::Lambda::Alias",
          ResourceStatus: "UPDATE_COMPLETE",
        },
        {
          LogicalResourceId: `${name}DeploymentGroup`,
          PhysicalResourceId: `hayasend-${name}`,
          ResourceType: "AWS::CodeDeploy::DeploymentGroup",
          ResourceStatus: "UPDATE_COMPLETE",
        },
      ]),
      ...[
        ["BackupServiceRole", "AWS::IAM::Role"],
        ["BackupVault", "AWS::Backup::BackupVault"],
        ["BackupPlan", "AWS::Backup::BackupPlan"],
        ["BackupSelection", "AWS::Backup::BackupSelection"],
        ["RestoreTestingServiceRole", "AWS::IAM::Role"],
        ["RestoreTestingPlan", "AWS::Backup::RestoreTestingPlan"],
        [
          "DynamoDbRestoreTestingSelection",
          "AWS::Backup::RestoreTestingSelection",
        ],
        ["S3RestoreTestingSelection", "AWS::Backup::RestoreTestingSelection"],
      ].map(([LogicalResourceId, ResourceType]) => ({
        LogicalResourceId,
        PhysicalResourceId:
          LogicalResourceId === "BackupVault"
            ? "HayaSend_hayasend_1234567890"
            : `hayasend-${LogicalResourceId}`,
        ResourceType,
        ResourceStatus: "UPDATE_COMPLETE",
      })),
    ],
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

function awsRunner(
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
      return result("", 0, "aws-cli/2.36.10 Python/3.13");
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
        Arn: "arn:aws:sts::123456789012:assumed-role/HayaSend/session",
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
      args[1] === "describe-stacks"
    ) {
      return existingStack();
    }
    if (
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "list-stack-resources"
    ) {
      return stackResources();
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
      args[0] === "cloudwatch" &&
      args[1] === "describe-alarms"
    ) {
      return json({
        MetricAlarms: [
          {
            AlarmName: "hayasend-worker-errors",
            StateValue: "OK",
            StateReason: "Threshold not crossed.",
          },
        ],
      });
    }
    if (command === "sam" && ["validate", "build"].includes(args[0] ?? "")) {
      return result("ok");
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
}

const awsEnvironment = {
  HAYASEND_AWS_ACCOUNT_ID: "123456789012",
  AWS_REGION: "ap-northeast-1",
};

describe("AWS lifecycle operations", () => {
  it("shows one production-readiness status without requiring SAM", async () => {
    const capture = capturingIo();
    const runner = awsRunner();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        service: "hayasend",
        version: "0.3.4",
      }),
    );

    await runCli(["status", "aws"], {
      env: awsEnvironment,
      io: capture.io,
      runCommand: runner,
      fetch: fetcher,
    });

    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      object: "aws_status",
      ok: true,
      operational: true,
      send_ready: true,
      stack: {
        name: "hayasend",
        exists: true,
        status: "UPDATE_COMPLETE",
        termination_protection: true,
        stack_policy: {
          retained_resources_protected: true,
        },
        drift: { status: "IN_SYNC" },
        resources: { total: 20, problems: [] },
        deployments: {
          enabled: true,
          aliases_ready: true,
          deployment_groups_ready: true,
          strategy: "Canary10Percent5Minutes",
        },
        backups: {
          enabled: true,
          retention_days: 35,
          payload_noncurrent_version_retention_days: 7,
          resources_ready: true,
          restore_testing: {
            enabled: true,
            resources_ready: true,
          },
        },
      },
      alarms: {
        total: 1,
        ok: 1,
        alarm: 0,
        insufficient_data: 0,
        problems: [],
      },
      public_health: { ok: true, http_status: 200 },
      next: {
        dashboard: { name: "hayasend-operations" },
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/healthz",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
    expect(runner.mock.calls.some(([command]) => command === "sam")).toBe(
      false,
    );
  });

  it("runs fresh drift detection and exposes metadata without property values", async () => {
    const capture = capturingIo();
    const detectionId = "8c3087d0-c67f-4a74-8383-e71e96b64b09";
    const runner = awsRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "detect-stack-drift"
      ) {
        return json({ StackDriftDetectionId: detectionId });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stack-drift-detection-status"
      ) {
        return json({
          StackDriftDetectionId: detectionId,
          StackDriftStatus: "DRIFTED",
          DetectionStatus: "DETECTION_COMPLETE",
          DriftedStackResourceCount: 1,
          Timestamp: "2026-07-29T02:00:00.000Z",
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stack-resource-drifts"
      ) {
        return json({
          StackResourceDrifts: [
            {
              LogicalResourceId: "DataTable",
              ResourceType: "AWS::DynamoDB::Table",
              StackResourceDriftStatus: "MODIFIED",
              PropertyDifferences: [
                {
                  PropertyPath: "/Sensitive",
                  ActualValue: "must-not-be-logged",
                },
              ],
            },
          ],
        });
      }
      return undefined;
    });

    await runCli(["status", "aws", "--detect-drift"], {
      env: awsEnvironment,
      io: capture.io,
      runCommand: runner,
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({
          ok: true,
          service: "hayasend",
          version: "0.3.4",
        }),
      ),
    });

    const rawStatus = capture.logs[0] ?? "{}";
    expect(rawStatus).not.toContain("must-not-be-logged");
    expect(JSON.parse(rawStatus)).toMatchObject({
      operational: false,
      send_ready: false,
      stack: {
        drift: {
          status: "DRIFTED",
          checked_at: "2026-07-29T02:00:00.000Z",
          detected_now: true,
          drifted_resource_count: 1,
          resources: [
            {
              logical_id: "DataTable",
              resource_type: "AWS::DynamoDB::Table",
              status: "MODIFIED",
            },
          ],
        },
      },
    });
  });

  it("bounds drift detection polling", async () => {
    const detectionId = "8c3087d0-c67f-4a74-8383-e71e96b64b09";
    const sleep = vi.fn(async () => undefined);
    const runner = awsRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "detect-stack-drift"
      ) {
        return json({ StackDriftDetectionId: detectionId });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stack-drift-detection-status"
      ) {
        return json({
          StackDriftDetectionId: detectionId,
          DetectionStatus: "DETECTION_IN_PROGRESS",
        });
      }
      return undefined;
    });

    await expect(
      runCli(["status", "aws", "--detect-drift"], {
        env: awsEnvironment,
        runCommand: runner,
        sleep,
      }),
    ).rejects.toThrow("did not complete within 10 minutes");
    expect(sleep).toHaveBeenCalledTimes(119);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("shows the exact deploy command when the stack does not exist", async () => {
    const capture = capturingIo();
    const runner = awsRunner((command, args) =>
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "describe-stacks"
        ? missingStack()
        : undefined,
    );

    await runCli(["status", "aws"], {
      env: awsEnvironment,
      io: capture.io,
      runCommand: runner,
    });

    const status = JSON.parse(capture.logs[0] ?? "{}");
    expect(status).toMatchObject({
      object: "aws_status",
      ok: false,
      operational: false,
      send_ready: false,
      stack: { exists: false },
    });
    expect(status.next.deploy_plan_command).toContain("deploy");
  });

  it("stops at the account gate before reading SES or CloudFormation", async () => {
    const runner = awsRunner((command, args) =>
      command === "aws" && args[0] === "sts"
        ? json({
            Account: "999999999999",
            Arn: "arn:aws:iam::999999999999:user/wrong",
          })
        : undefined,
    );

    await expect(
      runCli(["status", "aws"], {
        env: awsEnvironment,
        runCommand: runner,
      }),
    ).rejects.toThrow("does not match --account");
    expect(
      runner.mock.calls.some(
        ([command, args]) => command === "aws" && args[0] === "sesv2",
      ),
    ).toBe(false);
  });

  it("reports alarms as an actionable non-operational state", async () => {
    const capture = capturingIo();
    const runner = awsRunner((command, args) =>
      command === "aws" &&
      args[0] === "cloudwatch" &&
      args[1] === "describe-alarms"
        ? json({
            MetricAlarms: [
              {
                AlarmName: "hayasend-worker-errors",
                StateValue: "ALARM",
                StateReason: "Threshold crossed.",
              },
            ],
          })
        : undefined,
    );

    await runCli(["status", "aws"], {
      env: awsEnvironment,
      io: capture.io,
      runCommand: runner,
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({
          ok: true,
          service: "hayasend",
          version: "0.3.4",
        }),
      ),
    });

    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      ok: false,
      operational: false,
      send_ready: false,
      alarms: {
        alarm: 1,
        problems: [
          {
            logical_id: "WorkerErrorAlarm",
            state: "ALARM",
          },
        ],
      },
    });
  });

  it("does not report an unprotected stack as operational", async () => {
    const capture = capturingIo();
    const runner = awsRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "get-stack-policy"
      ) {
        return json({});
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        return existingStack({ EnableTerminationProtection: false });
      }
      return undefined;
    });

    await runCli(["status", "aws"], {
      env: awsEnvironment,
      io: capture.io,
      runCommand: runner,
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({
          ok: true,
          service: "hayasend",
          version: "0.3.4",
        }),
      ),
    });

    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      operational: false,
      send_ready: false,
      stack: {
        termination_protection: false,
        stack_policy: {
          present: false,
          retained_resources_protected: false,
        },
      },
    });
  });

  it("requires an existing stack for upgrade and uses an upgrade apply command", async () => {
    const missingRunner = awsRunner((command, args) =>
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "describe-stacks"
        ? missingStack()
        : undefined,
    );
    await expect(
      runCli(["upgrade", "aws"], {
        env: awsEnvironment,
        runCommand: missingRunner,
      }),
    ).rejects.toThrow("run deploy aws first");
    expect(
      missingRunner.mock.calls.some(([command]) => command === "sam"),
    ).toBe(false);

    const capture = capturingIo();
    await runCli(["upgrade", "aws"], {
      env: awsEnvironment,
      io: capture.io,
      runCommand: awsRunner(),
    });
    const plan = JSON.parse(capture.logs[0] ?? "{}");
    expect(plan.operation).toBe("upgrade");
    expect(plan.apply_command).toContain("upgrade");
    expect(plan.apply_command).not.toContain("deploy");
  });

  it("plans cleanup with retained data and performs no mutation", async () => {
    const capture = capturingIo();
    const runner = awsRunner();

    await runCli(["cleanup", "aws"], {
      env: awsEnvironment,
      io: capture.io,
      runCommand: runner,
    });

    const plan = JSON.parse(capture.logs[0] ?? "{}");
    expect(plan).toMatchObject({
      object: "aws_cleanup_plan",
      mutating: false,
      stack: { resource_count: 20 },
      deletion: {
        retained_resources: [
          {
            logical_id: "DataTable",
            physical_id: "hayasend-data",
          },
          {
            logical_id: "PayloadBucket",
            physical_id: "hayasend-payloads-123456789012",
          },
          {
            logical_id: "BackupVault",
            physical_id: "HayaSend_hayasend_1234567890",
          },
        ],
      },
    });
    expect(plan.apply_command).toEqual(
      expect.arrayContaining([
        "--cloudformation-role-arn",
        "arn:aws:iam::123456789012:role/HayaSendCloudFormationServiceRole",
        "--apply",
        "--confirm-stack",
        "hayasend",
      ]),
    );
    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === "aws" &&
          args[0] === "cloudformation" &&
          args[1] === "delete-stack",
      ),
    ).toBe(false);
  });

  it("allows cleanup after a failed initial deployment rolled back", async () => {
    const capture = capturingIo();
    const runner = awsRunner((command, args) =>
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "describe-stacks"
        ? existingStack({ StackStatus: "ROLLBACK_COMPLETE" })
        : undefined,
    );

    await runCli(["cleanup", "aws"], {
      env: awsEnvironment,
      io: capture.io,
      runCommand: runner,
    });

    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      object: "aws_cleanup_plan",
      mutating: false,
      stack: {
        status: "ROLLBACK_COMPLETE",
      },
    });
    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === "aws" &&
          args[0] === "cloudformation" &&
          args[1] === "delete-stack",
      ),
    ).toBe(false);
  });

  it("requires exact cleanup confirmation and refuses unmanaged stacks", async () => {
    await expect(
      runCli(["cleanup", "aws", "--apply"], {
        env: awsEnvironment,
        runCommand: awsRunner(),
      }),
    ).rejects.toThrow("--confirm-stack hayasend");

    const unmanaged = awsRunner((command, args) =>
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "describe-stacks"
        ? existingStack({ Tags: [] })
        : undefined,
    );
    await expect(
      runCli(["cleanup", "aws"], {
        env: awsEnvironment,
        runCommand: unmanaged,
      }),
    ).rejects.toThrow("not tagged Project=HayaSend");
  });

  it("requires explicit termination-protection disable and verifies applied deletion", async () => {
    const protectedPlan = capturingIo();
    const protectedRunner = awsRunner((command, args) =>
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "describe-stacks"
        ? existingStack({ EnableTerminationProtection: true })
        : undefined,
    );
    await runCli(["cleanup", "aws"], {
      env: awsEnvironment,
      io: protectedPlan.io,
      runCommand: protectedRunner,
    });
    expect(JSON.parse(protectedPlan.logs[0] ?? "{}")).toMatchObject({
      stack: { termination_protection: true },
      apply_command: expect.arrayContaining([
        "--disable-termination-protection",
      ]),
    });
    await expect(
      runCli(["cleanup", "aws", "--apply", "--confirm-stack", "hayasend"], {
        env: awsEnvironment,
        runCommand: protectedRunner,
      }),
    ).rejects.toThrow("--disable-termination-protection");

    let protectionEnabled = true;
    let deleting = false;
    const capture = capturingIo();
    const runner = awsRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "update-termination-protection"
      ) {
        protectionEnabled = args.includes("--enable-termination-protection");
        return json({
          StackId:
            "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/hayasend/id",
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "delete-stack"
      ) {
        deleting = true;
        return result();
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "wait"
      ) {
        return result();
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        return deleting
          ? missingStack()
          : existingStack({
              EnableTerminationProtection: protectionEnabled,
            });
      }
      return undefined;
    });
    await runCli(
      [
        "cleanup",
        "aws",
        "--apply",
        "--confirm-stack",
        "hayasend",
        "--disable-termination-protection",
      ],
      {
        env: awsEnvironment,
        io: capture.io,
        runCommand: runner,
      },
    );

    expect(JSON.parse(capture.logs.at(-1) ?? "{}")).toMatchObject({
      object: "aws_cleanup_result",
      ok: true,
      deleted: true,
      stack: "hayasend",
    });
    const deleteCall = runner.mock.calls.find(
      ([command, args]) =>
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "delete-stack",
    );
    const disableCall = runner.mock.calls.find(
      ([command, args]) =>
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "update-termination-protection" &&
        args.includes("--no-enable-termination-protection"),
    );
    expect(disableCall?.[1]).not.toContain("--disable-termination-protection");
    expect(deleteCall?.[1]).toEqual(
      expect.arrayContaining([
        "--role-arn",
        "arn:aws:iam::123456789012:role/HayaSendCloudFormationServiceRole",
      ]),
    );
  });

  it("re-enables termination protection when delete submission fails", async () => {
    let protectionEnabled = true;
    const protectionCalls: string[] = [];
    const runner = awsRunner((command, args) => {
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "update-termination-protection"
      ) {
        protectionEnabled = args.includes("--enable-termination-protection");
        protectionCalls.push(protectionEnabled ? "enable" : "disable");
        return result();
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        return existingStack({
          EnableTerminationProtection: protectionEnabled,
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "delete-stack"
      ) {
        return result("", 254, "delete rejected");
      }
      return undefined;
    });

    await expect(
      runCli(
        [
          "cleanup",
          "aws",
          "--apply",
          "--confirm-stack",
          "hayasend",
          "--disable-termination-protection",
        ],
        {
          env: awsEnvironment,
          runCommand: runner,
        },
      ),
    ).rejects.toThrow("Termination protection was re-enabled");
    expect(protectionCalls).toEqual(["disable", "enable"]);
    expect(protectionEnabled).toBe(true);
  });
});
