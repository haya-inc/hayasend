import { describe, expect, it } from "vitest";
import {
  assertRestoreTestingPlanIdentity,
  restoredResourceTarget,
  stableCanonicalJson,
  summarizeDynamoProbe,
} from "../scripts/aws-backup-restore-proof.mjs";

const emailId = "email_1234567890abcdef";
const attachmentId = "att_0123456789abcdef0123456789abcdef";

function item(PK: string, SK: string, extra = {}) {
  return { PK: { S: PK }, SK: { S: SK }, ...extra };
}

function ledgerItems() {
  const emailPartition = `EMAIL#${emailId}`;
  const outbox = `OUTBOX#outbox:v1:${emailId}:dispatch-message:0`;
  return [
    item(emailPartition, emailPartition),
    item(emailPartition, `DELIVERY_MESSAGE#${emailId}`),
    item(emailPartition, "RECIPIENT#rcpt_a"),
    item(emailPartition, "RECIPIENT#rcpt_b"),
    item(outbox, outbox, {
      entity: { M: { dispatched_at: { S: "2026-07-29T00:00:00.000Z" } } },
    }),
    item("IDEMPOTENCY#hash", "IDEMPOTENCY#hash", {
      email_id: { S: emailId },
    }),
    item(`ATTACHMENT#${attachmentId}`, `ATTACHMENT#${attachmentId}`),
  ];
}

const options = {
  account: "123456789012",
  region: "ap-northeast-1",
  table: "hayasend-source",
  bucket: "hayasend-source-bucket",
  tableArn:
    "arn:aws:dynamodb:ap-northeast-1:123456789012:table/hayasend-source",
  bucketArn: "arn:aws:s3:::hayasend-source-bucket",
  vaultArn: "arn:aws:backup:ap-northeast-1:123456789012:backup-vault:test",
  vaultName: "test",
  restorePlanArn:
    "arn:aws:backup:ap-northeast-1:123456789012:restore-testing-plan:HayaSend_test_1234-867cbaf4-a45d-464e-ba8b-6035bc96770b",
  restorePlanName: "HayaSend_test_1234",
  stateFile: "/tmp/test.json",
};

describe("AWS Backup semantic restore proof", () => {
  it("keeps the exact plan name separate from AWS's ARN identifier", () => {
    expect(
      assertRestoreTestingPlanIdentity(
        {
          RestoreTestingPlanName: options.restorePlanName,
          RestoreTestingPlanArn: options.restorePlanArn,
        },
        options,
      ),
    ).toEqual({
      RestoreTestingPlanName: options.restorePlanName,
      RestoreTestingPlanArn: options.restorePlanArn,
    });
    expect(() =>
      assertRestoreTestingPlanIdentity(
        {
          RestoreTestingPlanName:
            options.restorePlanArn.split(":").at(-1) ?? "",
          RestoreTestingPlanArn: options.restorePlanArn,
        },
        options,
      ),
    ).toThrow("name and ARN do not match exactly");
  });

  it("canonicalizes object keys and DynamoDB sets without reordering lists", () => {
    expect(
      stableCanonicalJson({
        z: { SS: ["b", "a"] },
        a: { L: [{ S: "b" }, { S: "a" }] },
      }),
    ).toBe('{"a":{"L":[{"S":"b"},{"S":"a"}]},"z":{"SS":["a","b"]}}');
  });

  it("requires every atomic delivery record and acknowledged outbox", () => {
    const summary = summarizeDynamoProbe(
      ledgerItems().reverse(),
      emailId,
      attachmentId,
    );
    expect(summary.semantic_counts).toEqual({
      email: 1,
      delivery_message: 1,
      recipients: 2,
      outbox: 1,
      idempotency: 1,
      attachment: 1,
    });
    expect(summary.digest_sha256).toMatch(/^[a-f0-9]{64}$/);

    const missingRecipient = ledgerItems().filter(
      (entry) => entry.SK.S !== "RECIPIENT#rcpt_b",
    );
    expect(() =>
      summarizeDynamoProbe(missingRecipient, emailId, attachmentId),
    ).toThrow("missing required recovery semantics");
  });

  it("accepts only exact-account DynamoDB and isolated AWS Backup S3 targets", () => {
    expect(
      restoredResourceTarget(
        {
          SourceResourceArn: options.tableArn,
          CreatedResourceArn:
            "arn:aws:dynamodb:ap-northeast-1:123456789012:table/awsbackup-restore-test-table",
        },
        options,
      ),
    ).toEqual({
      type: "DynamoDB",
      name: "awsbackup-restore-test-table",
      arn: "arn:aws:dynamodb:ap-northeast-1:123456789012:table/awsbackup-restore-test-table",
    });
    expect(
      restoredResourceTarget(
        {
          SourceResourceArn: options.bucketArn,
          CreatedResourceArn: "arn:aws:s3:::awsbackup-restore-test-1234567890",
        },
        options,
      ),
    ).toEqual({
      type: "S3",
      name: "awsbackup-restore-test-1234567890",
      arn: "arn:aws:s3:::awsbackup-restore-test-1234567890",
    });
    expect(() =>
      restoredResourceTarget(
        {
          SourceResourceArn: options.bucketArn,
          CreatedResourceArn: options.bucketArn,
        },
        options,
      ),
    ).toThrow("not an isolated test bucket");
    expect(() =>
      restoredResourceTarget(
        {
          SourceResourceArn: options.tableArn,
          CreatedResourceArn:
            "arn:aws:dynamodb:ap-northeast-1:999999999999:table/other",
        },
        options,
      ),
    ).toThrow("outside the exact account");
  });
});
