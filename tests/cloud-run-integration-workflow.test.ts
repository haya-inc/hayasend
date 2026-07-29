import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Cloud Run hosted lifecycle workflow", () => {
  it("uses keyless auth, a disposable proof job, exact costs, and failure cleanup", async () => {
    const workflow = await readFile(
      new URL(
        "../.github/workflows/cloud-run-integration.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("environment: cloud-run-integration");
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain(
      'if [[ "$GITHUB_REF" != "refs/heads/main" ]]',
    );
    expect(workflow).toContain(
      '[[ "${GITHUB_REF_PROTECTED:-false}" != "true" ]]',
    );
    expect(workflow).toContain(
      '${{ inputs.confirm_cost_ceiling_usd }}',
    );
    expect(workflow).toContain(
      '[[ "$GCP_TEST_COST_CEILING_USD" != "25" ]]',
    );
    expect(workflow).toContain(
      '[[ "$GCP_TEST_DURATION_MINUTES" != "45" ]]',
    );
    expect(workflow).toContain(
      "google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093",
    );
    expect(workflow).not.toContain("credentials_json:");
    expect(workflow).toContain("GCLOUD_VERSION: 578.0.0");
    expect(workflow).toContain(
      "TF_VAR_enable_hosted_proof_job: \"true\"",
    );
    expect(workflow).toContain("TF_VAR_transport: console");
    expect(workflow).not.toContain("SENDGRID_API_KEY");
    expect(workflow).toContain(
      "ghcr.io/haya-inc/hayasend@sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979",
    );
    expect(workflow).toContain(
      "gcloud run jobs execute \"$proof_job\"",
    );
    expect(workflow).toContain(
      'labels.execution_name=\\"$execution\\"',
    );
    expect(workflow).toContain(
      ".checks.scheduled_horizon_seconds == 2592000",
    );
    expect(workflow).toContain(
      "HAYASEND_CLOUD_RUN_ALLOW_PARTIAL: \"true\"",
    );
    expect(workflow).toContain("deploy/cloud-run/cleanup.sh");
    expect(workflow).toContain(
      "steps.inventory_guard.outputs.validated == 'true'",
    );
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(
      /actions\/upload-artifact@[0-9a-f]{40}/,
    );
  });
});
