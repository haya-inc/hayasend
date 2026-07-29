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
    expect(workflow).toContain('artifact_prefix="hayasend/$STACK_NAME/"');
    expect(workflow).toContain('--prefix "$artifact_prefix"');
    expect(workflow).toContain('--confirm-prefix "$artifact_prefix"');
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
    expect(workflow).toContain("stack_parameter RestoreTestingPlanName");
    expect(workflow).toContain(
      '--restore-plan-name "$RESTORE_TESTING_PLAN_NAME"',
    );
    expect(proof).toContain("put-restore-validation-result");
    expect(workflow).toContain("delete-backup-vault");
    expect(workflow).toContain(
      "role-duration-seconds: ${{ inputs.prove_backup_restore && 21600 || 3600 }}",
    );
  });

  it("proves a stack-owned alarm rollback without leaving the checkout mutated", () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL("../.github/workflows/aws-integration.yml", import.meta.url),
      ),
      "utf8",
    );
    expect(workflow).toContain("prove_canary_rollback:");
    expect(workflow).toContain('source_file="src/aws/api.ts"');
    expect(workflow).toContain('--alarm-name "$API_ALIAS_ALARM"');
    expect(workflow).toContain("aws deploy list-deployment-groups");
    expect(workflow).toContain(
      '--deployment-group-name "$deployment_group_name"',
    );
    expect(workflow).toContain(
      '--deployment-group-name "$triggering_deployment_group"',
    );
    expect(workflow).toContain("--query deployments");
    expect(workflow).not.toContain("--query deploymentIds");
    expect(workflow).toContain("DEPLOYMENT_STOP_ON_ALARM");
    expect(workflow).toContain(".rollbackInfo.rollbackTriggeringDeploymentId");
    expect(workflow).toContain(
      '"$current_alias_version" != "$baseline_alias_version"',
    );
    expect(workflow).toContain('git show "HEAD:$source_file" > "$source_file"');
    expect(workflow).toContain(
      'if [[ "$stack_status" != "UPDATE_ROLLBACK_COMPLETE" ]]',
    );
    expect(workflow).toContain('"$API_BASE_URL/health" >/dev/null');
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
    expect(workflow).toContain("was not created or was already removed.");
  });
});
