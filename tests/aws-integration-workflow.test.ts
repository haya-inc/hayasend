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

  it("gates the semantic restore proof and validates cleanup", () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL("../.github/workflows/aws-integration.yml", import.meta.url),
      ),
      "utf8",
    );
    const proof = readFileSync(
      fileURLToPath(
        new URL("../scripts/aws-backup-restore-proof.mjs", import.meta.url),
      ),
      "utf8",
    );
    expect(workflow).toContain("prove_backup_restore:");
    expect(workflow).toContain(
      "node scripts/aws-backup-restore-proof.mjs prove",
    );
    expect(workflow).toContain(
      "node scripts/aws-backup-restore-proof.mjs cleanup",
    );
    expect(proof).toContain("put-restore-validation-result");
    expect(workflow).toContain("delete-backup-vault");
    expect(workflow).toContain(
      "role-duration-seconds: ${{ inputs.prove_backup_restore && 21600 || 3600 }}",
    );
  });

  it("skips backup-vault cleanup when creation never completed", () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL("../.github/workflows/aws-integration.yml", import.meta.url),
      ),
      "utf8",
    );
    expect(workflow).toContain('"$backup_vault_name" != "None"');
    expect(workflow).toContain(
      'if [[ "$backup_vault_error" = *"ResourceNotFoundException"* ]]',
    );
    expect(workflow).toContain(
      "was not created or was already removed.",
    );
  });
});
