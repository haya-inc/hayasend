import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AWS SES terminal delivery workflow", () => {
  it("pins the toolchain and fails closed around production access and cleanup", async () => {
    const workflow = await readFile(
      new URL(
        "../.github/workflows/aws-terminal-delivery.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("environment: aws-integration");
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(workflow).toContain(
      'test "$AWS_TEST_ACCOUNT_KIND" = "general-purpose-test"',
    );
    expect(workflow).toContain('test "$AWS_TEST_ACCOUNT_ID" = "330599756148"');
    expect(workflow).toContain('test "$AWS_REGION" = "ap-northeast-1"');
    expect(workflow).toContain(
      'test "$production_access" = "true"',
    );
    expect(workflow).toContain('test "$sending_enabled" = "true"');
    expect(workflow).toContain('test "$verification_status" = "SUCCESS"');
    expect(workflow).toContain('test "$verified_for_sending" = "true"');
    // Reserving any concurrency requires the account to keep 10 unreserved
    // executions, which a low-quota account cannot satisfy. The proof relies on
    // WorkerMaximumConcurrency to bound the worker instead.
    expect(workflow).toContain("--worker-reserved-concurrency 0");
    // The submitted flag and the plan assertion that gates the send must agree;
    // a mismatch fails the proof after it has already assumed the AWS role.
    expect(workflow).toContain(
      'plan.parameters.WorkerReservedConcurrency !== "0"',
    );
    expect(workflow).toContain(
      'plan.parameters.WorkerMaximumConcurrency !== "10"',
    );
    // The proof covers send, provider events, ledger convergence, and receipt.
    // A backup plan is outside that scope, and its service role is the one
    // resource the integration role cannot create or detach under this stack
    // name, which would leave residue the proof must not leave behind.
    // The integration role's policy scopes every resource ARN to hayasend-it-*.
    // A stack named outside that prefix cannot create its own S3 bucket, IAM
    // role, or table, and cannot delete them either, so the proof would fail
    // its own zero-residue criterion.
    expect(workflow).toContain("STACK_NAME: hayasend-it-");
    // A successful deploy always enables termination protection, so the proof
    // cannot delete the stack it just sent from without disabling it first.
    expect(workflow).toContain(
      "aws cloudformation update-termination-protection",
    );
    expect(workflow).toContain("--no-enable-termination-protection");
    expect(workflow).toContain(
      "Termination protection remains enabled; refusing to leave it unverified.",
    );
    // The payload bucket is versioned; `aws s3 rm --recursive` leaves
    // noncurrent versions behind and the bucket then cannot be deleted.
    expect(workflow).toContain("node scripts/aws-versioned-bucket.mjs purge");
    expect(workflow).not.toContain("aws s3 rm ");
    expect(workflow).toContain("--disable-backups");
    expect(workflow).toContain('plan.parameters.EnableBackups !== "false"');
    expect(workflow).toContain("node scripts/aws-terminal-delivery.mjs");
    expect(workflow).toContain("node scripts/aws-terminal-ledger.mjs");
    expect(workflow).toContain("Verify zero run-scoped residue");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(workflow).toMatch(
      /aws-actions\/configure-aws-credentials@[0-9a-f]{40}/,
    );
    expect(workflow).toContain("node-version: 24.18.1");
    expect(workflow).toContain("version: 1.165.0");
    expect(workflow).toContain("npm@12.0.2");
    expect(workflow).toContain("retain_stack");
    expect(workflow).toContain("if-no-files-found: error");
  });
});
