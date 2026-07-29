import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const application = readFileSync(
  new URL("../template.yaml", import.meta.url),
  "utf8",
);
const bootstrap = readFileSync(
  new URL("../deploy/aws-cloudformation-bootstrap.yaml", import.meta.url),
  "utf8",
);

const servicePrefixesByResourceType: Record<string, string[]> = {
  "AWS::Backup::BackupPlan": ["backup"],
  "AWS::Backup::BackupSelection": ["backup"],
  "AWS::Backup::BackupVault": ["backup"],
  "AWS::Backup::RestoreTestingPlan": ["backup"],
  "AWS::Backup::RestoreTestingSelection": ["backup"],
  "AWS::CloudWatch::Alarm": ["cloudwatch"],
  "AWS::CloudWatch::Dashboard": ["cloudwatch"],
  "AWS::DynamoDB::Table": ["dynamodb"],
  "AWS::IAM::Role": ["iam"],
  "AWS::KMS::Key": ["kms"],
  "AWS::Logs::LogGroup": ["logs"],
  "AWS::S3::Bucket": ["s3"],
  "AWS::S3::BucketPolicy": ["s3"],
  "AWS::SES::ConfigurationSet": ["ses"],
  "AWS::SES::ConfigurationSetEventDestination": ["ses"],
  "AWS::SES::MailManagerIngressPoint": ["ses"],
  "AWS::SES::MailManagerRuleSet": ["ses"],
  "AWS::SES::MailManagerTrafficPolicy": ["ses"],
  "AWS::SNS::Topic": ["sns"],
  "AWS::SNS::TopicPolicy": ["sns"],
  "AWS::SQS::Queue": ["sqs"],
  "AWS::Scheduler::ScheduleGroup": ["scheduler"],
  "AWS::SecretsManager::Secret": ["secretsmanager"],
  "AWS::Serverless::Function": ["lambda", "iam", "logs", "codedeploy"],
  "AWS::Serverless::HttpApi": ["apigateway"],
  "Custom::HayaSendLogRetention": ["lambda"],
};

describe("AWS CloudFormation deployment bootstrap template", () => {
  it("covers every application resource type with reviewed service actions", () => {
    const resourceSection = application.slice(
      application.indexOf("\nResources:"),
      application.indexOf("\nOutputs:"),
    );
    const resourceTypes = new Set(
      [...resourceSection.matchAll(/^\s{4}Type:\s+([^\s]+)$/gm)].map(
        (match) => match[1] ?? "",
      ),
    );
    expect(resourceTypes.size).toBeGreaterThan(20);
    expect([...resourceTypes].sort()).toEqual(
      Object.keys(servicePrefixesByResourceType).sort(),
    );
    for (const type of resourceTypes) {
      for (const prefix of servicePrefixesByResourceType[type] ?? []) {
        expect(bootstrap).toMatch(
          new RegExp(`^\\s+- ${prefix}:[A-Za-z*]+$`, "m"),
        );
      }
    }
  });

  it("keeps the normal operator outside data-plane provisioning", () => {
    const operatorSection = bootstrap.slice(
      bootstrap.indexOf("  OperatorPolicy:"),
      bootstrap.indexOf("\nOutputs:"),
    );
    expect(operatorSection).toContain("iam:PassedToService");
    expect(operatorSection).toContain("cloudformation.amazonaws.com");
    expect(operatorSection).toContain(
      "Resource: !GetAtt CloudFormationServiceRole.Arn",
    );
    expect(operatorSection).toContain(
      'Resource: !Sub "${ArtifactBucket.Arn}/hayasend/*"',
    );
    expect(operatorSection).toContain("changeSet/samcli-deploy*/*");
    expect(operatorSection).toContain(
      "cloudformation:ChangeSetName: samcli-deploy*",
    );
    expect(operatorSection).toContain("sts:GetCallerIdentity");
    expect(operatorSection).toContain("ses:GetAccount");
    expect(operatorSection).toContain("cloudwatch:DescribeAlarms");
    expect(operatorSection).toContain(
      "cloudformation:BatchDescribeTypeConfigurations",
    );
    expect(operatorSection).toContain(
      "cloudformation:DetectStackResourceDrift",
    );
    expect(operatorSection).toContain("aws:RequestedRegion: !Ref AWS::Region");
    expect(operatorSection).not.toContain("changeSet/*/*");
    expect(operatorSection).not.toMatch(
      /\b(?:lambda|dynamodb|sqs|sns|backup|kms):/,
    );
    expect(operatorSection).not.toMatch(/\bses:(?!GetAccount\b)[A-Za-z*]+/);
    expect(operatorSection).not.toMatch(
      /\bcloudwatch:(?!DescribeAlarms\b)[A-Za-z*]+/,
    );
    expect(operatorSection).not.toContain("Action: *");
    expect(bootstrap).not.toContain("AdministratorAccess");
  });

  it("scopes role creation and passing to application roles and services", () => {
    const serviceRoleSection = bootstrap.slice(
      bootstrap.indexOf("  CloudFormationServiceRole:"),
      bootstrap.indexOf("\n  OperatorPolicy:"),
    );
    expect(serviceRoleSection).toContain("Sid: UseOnlyTheSAMTransform");
    expect(serviceRoleSection).toContain(
      "Action: cloudformation:CreateChangeSet",
    );
    expect(serviceRoleSection).toContain(
      'Resource: !Sub "arn:${AWS::Partition}:cloudformation:${AWS::Region}:aws:transform/Serverless-2016-10-31"',
    );
    expect(serviceRoleSection).not.toContain(
      "arn:${AWS::Partition}:cloudformation:${AWS::Region}:aws:transform/*",
    );
    expect(serviceRoleSection).toContain(
      "Sid: ReadOnlyHayaSendDeploymentArtifacts",
    );
    expect(serviceRoleSection).toContain("Action: s3:GetObject");
    expect(serviceRoleSection).toContain(
      'Resource: !Sub "${ArtifactBucket.Arn}/hayasend/*"',
    );
    expect(serviceRoleSection).toContain(
      "Sid: InvokeOnlyManagedCustomResourceFunctions",
    );
    expect(serviceRoleSection).toContain("Action: lambda:InvokeFunction");
    expect(serviceRoleSection).toContain(
      'Resource: !Sub "arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${ApplicationStackNamePrefix}*"',
    );
    expect(serviceRoleSection).toContain(
      "Sid: GenerateOnlyTheBootstrapSecretValue",
    );
    expect(serviceRoleSection).toContain(
      "Action: secretsmanager:GetRandomPassword",
    );
    expect(serviceRoleSection).toContain(
      "Sid: DeleteSchedulesOnlyFromManagedGroups",
    );
    expect(serviceRoleSection).toContain("Action: scheduler:DeleteSchedule");
    expect(serviceRoleSection).toContain(
      'Resource: !Sub "arn:${AWS::Partition}:scheduler:${AWS::Region}:${AWS::AccountId}:schedule/${ApplicationStackNamePrefix}*/*"',
    );
    expect(serviceRoleSection).toContain("s3:GetBucketCORS");
    expect(serviceRoleSection).toContain("s3:PutBucketCORS");
    expect(serviceRoleSection).toContain(
      "Sid: TagOnlyManagedApiGatewayResources",
    );
    expect(serviceRoleSection).toContain(
      "Sid: UseProviderOperationsOnlyOnManagedApiGatewayResources",
    );
    expect(serviceRoleSection).toContain(
      'Resource: !Sub "arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis/*"',
    );
    expect(serviceRoleSection).toContain(
      "aws:RequestTag/Project: HayaSend",
    );
    expect(serviceRoleSection).toContain(
      "aws:RequestTag/ManagedBy: HayaSendCLI",
    );
    expect(serviceRoleSection).toContain(
      "aws:ResourceTag/Project: HayaSend",
    );
    expect(serviceRoleSection).toContain(
      "aws:ResourceTag/ManagedBy: HayaSendCLI",
    );
    expect(serviceRoleSection).not.toContain(
      'Resource: !Sub "arn:${AWS::Partition}:s3:::*/*"',
    );
    expect(serviceRoleSection).toContain(
      'Resource: !Sub "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${ApplicationStackNamePrefix}*"',
    );
    expect(serviceRoleSection).toContain("iam:PassedToService");
    for (const service of [
      "backup.amazonaws.com",
      "codedeploy.amazonaws.com",
      "lambda.amazonaws.com",
      "scheduler.amazonaws.com",
      "ses.amazonaws.com",
    ]) {
      expect(serviceRoleSection).toContain(service);
    }
    expect(serviceRoleSection).not.toContain("backup-storage:MountCapsule");
  });

  it("retains and hardens the dedicated artifact bucket", () => {
    expect(bootstrap).toContain("DeletionPolicy: Retain");
    expect(bootstrap).toContain("UpdateReplacePolicy: Retain");
    expect(bootstrap).toContain("BucketOwnerEnforced");
    expect(bootstrap).toContain("BlockPublicPolicy: true");
    expect(bootstrap).toContain("RestrictPublicBuckets: true");
    expect(bootstrap).toContain("aws:SecureTransport");
    expect(bootstrap).toContain("VersioningConfiguration:");
  });
});
