import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("AWS integration workflow cleanup", () => {
  it("purges versioned payload data with exact account and bucket gates", () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL("../.github/workflows/aws-integration.yml", import.meta.url),
      ),
      "utf8",
    );
    expect(workflow).toContain("node scripts/aws-versioned-bucket.mjs purge");
    expect(workflow).toContain('--account "$AWS_TEST_ACCOUNT_ID"');
    expect(workflow).toContain('--bucket "$PAYLOAD_BUCKET"');
    expect(workflow).toContain('--confirm-bucket "$PAYLOAD_BUCKET"');
    expect(workflow).not.toContain('aws s3 rm "s3://$PAYLOAD_BUCKET"');
  });
});
