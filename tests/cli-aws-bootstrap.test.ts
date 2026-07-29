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

function missingStack() {
  return result(
    "",
    254,
    "An error occurred (ValidationError): Stack does not exist",
  );
}

function outputs() {
  return [
    {
      OutputKey: "CloudFormationRoleArn",
      OutputValue:
        "arn:aws:iam::123456789012:role/hayasend-bootstrap-ServiceRole",
    },
    {
      OutputKey: "ArtifactBucketName",
      OutputValue: "hayasend-bootstrap-artifacts-123456789012",
    },
    {
      OutputKey: "OperatorPolicyArn",
      OutputValue:
        "arn:aws:iam::123456789012:policy/hayasend-bootstrap-OperatorPolicy",
    },
  ];
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
      return result("", 0, "aws-cli/2.36.10 Python/3.13");
    }
    if (command === "aws" && args[0] === "sts") {
      return json({
        Account: "123456789012",
        Arn: "arn:aws:sts::123456789012:assumed-role/Admin/session",
      });
    }
    if (
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "validate-template"
    ) {
      return json({ Capabilities: ["CAPABILITY_IAM"] });
    }
    if (
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "describe-stacks"
    ) {
      return missingStack();
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
}

describe("AWS least-privilege deployment bootstrap", () => {
  it("renders a non-mutating exact-account bootstrap plan", async () => {
    const capture = capturingIo();
    const runner = baseRunner();

    await runCli(
      [
        "bootstrap",
        "aws",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
        "--application-stack-prefix",
        "hayasend-prod",
        "--artifact-retention-days",
        "180",
      ],
      {
        cwd: process.cwd(),
        env: {},
        io: capture.io,
        runCommand: runner,
      },
    );

    expect(capture.logs).toHaveLength(1);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      object: "aws_bootstrap_plan",
      ok: true,
      mutating: false,
      application_stack_name_prefix: "hayasend-prod",
      artifact_retention_days: 180,
      permissions_boundary_arn: null,
      stack: {
        name: "HayaSendDeploymentBootstrap",
        exists: false,
      },
      template: {
        source: "package:deploy/aws-cloudformation-bootstrap.yaml",
        validation: "pass",
      },
      apply_command: expect.arrayContaining([
        "bootstrap",
        "aws",
        "--confirm-account",
        "123456789012",
      ]),
    });
    expect(
      runner.mock.calls.some(
        ([, args]) =>
          args[0] === "cloudformation" && args[1] === "create-change-set",
      ),
    ).toBe(false);
  });

  it("preserves existing bootstrap parameters when an update omits them", async () => {
    const capture = capturingIo();
    const runner = baseRunner((command, args) =>
      command === "aws" &&
      args[0] === "cloudformation" &&
      args[1] === "describe-stacks"
        ? json({
            Stacks: [
              {
                StackStatus: "UPDATE_COMPLETE",
                Parameters: [
                  {
                    ParameterKey: "ApplicationStackNamePrefix",
                    ParameterValue: "mail-prod",
                  },
                  {
                    ParameterKey: "ArtifactRetentionDays",
                    ParameterValue: "365",
                  },
                  {
                    ParameterKey: "PermissionsBoundaryArn",
                    ParameterValue:
                      "arn:aws:iam::123456789012:policy/HayaSendBoundary",
                  },
                ],
              },
            ],
          })
        : undefined,
    );

    await runCli(
      [
        "bootstrap",
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

    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      application_stack_name_prefix: "mail-prod",
      artifact_retention_days: 365,
      permissions_boundary_arn:
        "arn:aws:iam::123456789012:policy/HayaSendBoundary",
      apply_command: expect.arrayContaining([
        "--application-stack-prefix",
        "mail-prod",
        "--artifact-retention-days",
        "365",
        "--permissions-boundary-arn",
        "arn:aws:iam::123456789012:policy/HayaSendBoundary",
      ]),
    });
  });

  it("creates and executes one reviewed bootstrap change set", async () => {
    const capture = capturingIo();
    let stackReads = 0;
    let changeSetId = "";
    let terminationProtection = false;
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
                  StackStatus: "CREATE_COMPLETE",
                  EnableTerminationProtection: terminationProtection,
                  Outputs: outputs(),
                },
              ],
            });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "create-change-set"
      ) {
        const name = args.at(args.indexOf("--change-set-name") + 1);
        changeSetId =
          "arn:aws:cloudformation:ap-northeast-1:123456789012:" +
          `changeSet/${name}/abc`;
        return json({
          Id: changeSetId,
          StackId:
            "arn:aws:cloudformation:ap-northeast-1:123456789012:" +
            "stack/HayaSendDeploymentBootstrap/stack-id",
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "describe-change-set"
      ) {
        return json({
          ChangeSetId: changeSetId,
          StackId:
            "arn:aws:cloudformation:ap-northeast-1:123456789012:" +
            "stack/HayaSendDeploymentBootstrap/stack-id",
          Status: "CREATE_COMPLETE",
          Changes: [
            {
              ResourceChange: {
                Action: "Add",
                LogicalResourceId: "CloudFormationServiceRole",
                ResourceType: "AWS::IAM::Role",
                Replacement: "False",
              },
            },
          ],
        });
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        args[1] === "update-termination-protection"
      ) {
        terminationProtection = args.includes(
          "--enable-termination-protection",
        );
        return result();
      }
      if (
        command === "aws" &&
        args[0] === "cloudformation" &&
        ["wait", "execute-change-set"].includes(args[1] ?? "")
      ) {
        return result();
      }
      return undefined;
    });

    await runCli(
      [
        "bootstrap",
        "aws",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
        "--apply",
        "--confirm-account",
        "123456789012",
      ],
      {
        cwd: process.cwd(),
        env: {},
        io: capture.io,
        runCommand: runner,
      },
    );

    expect(capture.logs.map((line) => JSON.parse(line).object)).toEqual([
      "aws_bootstrap_plan",
      "aws_bootstrap_change_set_plan",
      "aws_bootstrap_result",
    ]);
    expect(JSON.parse(capture.logs[2] ?? "{}")).toMatchObject({
      ok: true,
      applied: true,
      outputs: {
        cloudformation_role_arn:
          "arn:aws:iam::123456789012:role/hayasend-bootstrap-ServiceRole",
        artifact_bucket: "hayasend-bootstrap-artifacts-123456789012",
        operator_policy_arn:
          "arn:aws:iam::123456789012:policy/hayasend-bootstrap-OperatorPolicy",
      },
      protections: {
        termination_protection: true,
      },
      next: {
        deploy_plan_command: expect.arrayContaining([
          "--cloudformation-role-arn",
          "arn:aws:iam::123456789012:role/hayasend-bootstrap-ServiceRole",
          "--artifact-bucket",
          "hayasend-bootstrap-artifacts-123456789012",
        ]),
      },
    });
    expect(
      runner.mock.calls.some(
        ([command, args]) =>
          command === "aws" &&
          args[0] === "cloudformation" &&
          args[1] === "update-termination-protection" &&
          args.includes("--enable-termination-protection"),
      ),
    ).toBe(true);
  });

  it("requires exact confirmation before creating IAM resources", async () => {
    await expect(
      runCli(
        [
          "bootstrap",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--apply",
          "--confirm-account",
          "999999999999",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: baseRunner(),
        },
      ),
    ).rejects.toThrow(
      "bootstrap aws --apply requires --confirm-account 123456789012",
    );
  });

  it("rejects cross-account or cross-partition boundaries", async () => {
    await expect(
      runCli(
        [
          "bootstrap",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--permissions-boundary-arn",
          "arn:aws:iam::999999999999:policy/HayaSendBoundary",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: baseRunner(),
        },
      ),
    ).rejects.toThrow("expected partition");
  });

  it("rejects an application prefix that could mutate the bootstrap stack", async () => {
    await expect(
      runCli(
        [
          "bootstrap",
          "aws",
          "--account",
          "123456789012",
          "--region",
          "ap-northeast-1",
          "--stack",
          "hayasend-bootstrap",
          "--application-stack-prefix",
          "hayasend",
        ],
        {
          cwd: process.cwd(),
          env: {},
          io: capturingIo().io,
          runCommand: baseRunner(),
        },
      ),
    ).rejects.toThrow("must not match the bootstrap stack");
  });
});
