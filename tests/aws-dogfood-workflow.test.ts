import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AWS SES dogfood workflow", () => {
  it("fails closed around the protected long-lived stack and metadata evidence", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/aws-dogfood.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("environment: aws-integration");
    expect(workflow).toContain("AWS_DOGFOOD_ENABLED");
    expect(workflow).toContain("steps.guard.outputs.enabled == 'true'");
    expect(workflow).toContain("AWS_DOGFOOD_START_DATE");
    expect(workflow).toContain("EVENT_SCHEDULE: ${{ github.event.schedule }}");
    expect(workflow).toContain("requireDogfoodRetryWindow");
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(workflow).toContain('test "$AWS_TEST_ACCOUNT_ID" = "330599756148"');
    expect(workflow).toContain(
      'test "$AWS_TEST_ACCOUNT_KIND" = "general-purpose-test"',
    );
    expect(workflow).toContain('test "$AWS_REGION" = "ap-northeast-1"');
    expect(workflow).toContain('test "$STACK_NAME" = "hayasend"');
    expect(workflow).toContain(".EnableTerminationProtection == true");
    expect(workflow).toContain(
      '.DriftInformation.StackDriftStatus == "IN_SYNC"',
    );
    expect(workflow).toContain(".ProductionAccessEnabled == true");
    expect(workflow).toContain('.VerificationStatus == "SUCCESS"');
    expect(workflow).toContain("node scripts/aws-dogfood.mjs");
    expect(workflow).toContain("node scripts/aws-dogfood-ledger.mjs");
    expect(workflow).toContain(".unexplained_loss == 0");
    expect(workflow).toContain(".duplicate_terminal_events == 0");
    expect(workflow).toContain(".alarms.alarm == 0");
    expect(workflow).toContain("email_id_sha256");
    expect(workflow).not.toContain("aws cloudformation delete-stack");
    expect(workflow).not.toContain(
      "aws cloudformation update-termination-protection",
    );
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(workflow).toMatch(
      /aws-actions\/configure-aws-credentials@[0-9a-f]{40}/,
    );
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).toContain("node-version: 24.18.1");
    expect(workflow).toContain("npm@12.0.2");
    expect(workflow).toContain("retention-days: 90");
  });
});
