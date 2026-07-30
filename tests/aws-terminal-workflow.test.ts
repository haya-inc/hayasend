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
    expect(workflow).toContain("--worker-reserved-concurrency 1");
    expect(workflow).toContain("node scripts/aws-terminal-delivery.mjs");
    expect(workflow).toContain("node scripts/aws-terminal-ledger.mjs");
    expect(workflow).toContain("Verify zero run-scoped residue");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(workflow).toMatch(
      /aws-actions\/configure-aws-credentials@[0-9a-f]{40}/,
    );
    expect(workflow).toContain("node-version: 24.18.0");
    expect(workflow).toContain("version: 1.164.0");
    expect(workflow).toContain("npm@12.0.2");
    expect(workflow).toContain("retain_stack");
    expect(workflow).toContain("if-no-files-found: error");
  });
});
