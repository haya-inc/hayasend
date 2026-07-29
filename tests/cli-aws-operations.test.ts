import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type CommandResult,
  type CommandRunner,
} from "../src/cli-aws-deploy.js";
import { runCli } from "../src/cli.js";

function result(
  stdout = "",
  exitCode = 0,
  stderr = "",
): CommandResult {
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
        CreationTime: "2026-07-28T00:00:00.000Z",
        LastUpdatedTime: "2026-07-29T00:00:00.000Z",
        EnableTerminationProtection: false,
        DriftInformation: {
          StackDriftStatus: "IN_SYNC",
          LastCheckTimestamp: "2026-07-29T00:01:00.000Z",
        },
        Parameters: [],
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
      return result("12.0.1");
    }
    if (
      command === "npm" &&
      args[0] === "root" &&
      args[1] === "--global"
    ) {
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
        version: "0.3.1",
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
        drift: { status: "IN_SYNC" },
        resources: { total: 4, problems: [] },
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
    expect(
      runner.mock.calls.some(([command]) => command === "sam"),
    ).toBe(false);
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
          version: "0.3.1",
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
      stack: { resource_count: 4 },
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
        ],
      },
    });
    expect(plan.apply_command).toEqual(
      expect.arrayContaining([
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

  it("refuses termination protection and verifies applied deletion", async () => {
    const protectedRunner = awsRunner((command, args) =>
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "describe-stacks"
        ? existingStack({ EnableTerminationProtection: true })
        : undefined,
    );
    await expect(
      runCli(["cleanup", "aws"], {
        env: awsEnvironment,
        runCommand: protectedRunner,
      }),
    ).rejects.toThrow("termination protection is enabled");

    let deleting = false;
    const capture = capturingIo();
    const runner = awsRunner((command, args) => {
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
        deleting &&
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-stacks"
      ) {
        return missingStack();
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
  });
});
