import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  new URL("../template.yaml", import.meta.url),
  "utf8",
);

describe("SAM log retention resources", () => {
  it("declares the conservative default and every CloudWatch-supported value", () => {
    const parameter = template.match(
      /  LogRetentionDays:\n([\s\S]*?)    Description: CloudWatch Logs retention/,
    )?.[1];
    expect(parameter).toContain("Type: Number");
    expect(parameter).toContain("Default: 30");
    for (const days of [
      1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
      2192, 2557, 2922, 3288, 3653,
    ]) {
      expect(parameter).toContain(`- ${days}`);
    }
  });

  it("routes every function to a stack-owned finite log group", () => {
    for (const [functionName, logGroup] of [
      ["ApiFunction", "ApiLogGroup"],
      ["WorkerFunction", "WorkerLogGroup"],
      ["DispatcherFunction", "DispatcherLogGroup"],
      ["SesEventsFunction", "SesEventsLogGroup"],
      ["InboundFunction", "InboundLogGroup"],
      ["LogRetentionFunction", "LogRetentionFunctionLogGroup"],
    ]) {
      const resource = template.match(
        new RegExp(`  ${functionName}:\\n([\\s\\S]*?)(?=\\n  [A-Z])`),
      )?.[1];
      expect(resource).toContain("Type: AWS::Serverless::Function");
      expect(resource).toContain(`LogGroup: !Ref ${logGroup}`);
    }
    expect(template.match(/Type: AWS::Logs::LogGroup/g)).toHaveLength(6);
    expect(
      template.match(/RetentionInDays: !Ref LogRetentionDays/g),
    ).toHaveLength(7);
  });

  it("creates no inbound log resource or legacy target when inbound is disabled", () => {
    const inboundGroup = template.match(
      /  InboundLogGroup:\n([\s\S]*?)(?=\n  LogRetentionFunctionLogGroup:)/,
    )?.[1];
    expect(inboundGroup).toContain("Condition: InboundEnabled");

    const legacyResource = template.match(
      /  LegacyFunctionLogRetention:\n([\s\S]*?)(?=\n  InboundKey:)/,
    )?.[1];
    expect(legacyResource).toContain("- InboundEnabled");
    expect(legacyResource).toContain("!Sub /aws/lambda/${InboundFunction}");
    expect(legacyResource).toContain("!Sub /aws/lambda/${DispatcherFunction}");
    expect(legacyResource).toContain("!Ref AWS::NoValue");
  });

  it("removes only the provider group after a quiet delete callback", () => {
    const legacyResource = template.match(
      /  LegacyFunctionLogRetention:\n([\s\S]*?)(?=\n  InboundKey:)/,
    )?.[1];
    expect(legacyResource).toContain(
      "DependsOn:\n      - LogRetentionFunctionLogGroup",
    );

    const provider = template.match(
      /  LogRetentionFunction:\n([\s\S]*?)(?=\n  LegacyFunctionLogRetention:)/,
    )?.[1];
    expect(provider).toContain("ApplicationLogLevel: ERROR");
    expect(provider).toContain("LogFormat: JSON");
    expect(provider).toContain("SystemLogLevel: WARN");
    expect(provider).toContain("logs:DeleteLogGroup");
    expect(provider).toContain("log-group:${LogRetentionFunctionLogGroup}:*");
  });

  it("limits the migration role to retention metadata operations", () => {
    const resource = template.match(
      /  LogRetentionFunction:\n([\s\S]*?)(?=\n  LegacyFunctionLogRetention:)/,
    )?.[1];
    expect(resource).toContain("logs:DescribeLogGroups");
    expect(resource).toContain("logs:PutRetentionPolicy");
    expect(resource).toContain("logs:DeleteRetentionPolicy");
    expect(resource).not.toMatch(/logs:(?:Get|Filter)LogEvents/);
  });
});
