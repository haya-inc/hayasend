import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Fly.io hosted lifecycle workflow", () => {
  it("proves one exact PostgreSQL 17 graph and deletes only after bucket evidence", async () => {
    const workflow = await readFile(
      new URL(
        "../.github/workflows/flyio-integration.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("environment: flyio-integration");
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
      '[[ "$FLY_TEST_COST_CEILING_USD" != "50" ]]',
    );
    expect(workflow).toContain(
      '[[ "$FLY_TEST_DURATION_MINUTES" != "60" ]]',
    );
    expect(workflow).toContain("FLYCTL_VERSION: 0.4.75");
    expect(workflow).toContain("HAYASEND_TRANSPORT: console");
    expect(workflow).toContain("deploy/flyio/proof.sh");
    expect(workflow).toContain(
      "Establish the reviewed previous compatible baseline",
    );
    expect(workflow).toContain(
      "Upgrade to the reviewed current immutable release",
    );
    expect(workflow).toContain("deploy/flyio/rollback.sh");
    expect(workflow).toContain('object: "flyio_upgrade_proof"');
    expect(workflow).toContain('object: "flyio_rollback_proof"');
    expect(workflow).toContain(
      "sha256:4731fbc644c55088399f6a8c11105d9c3b300acb2b3beda71b581289327f2a4b",
    );
    expect(workflow).toContain(
      "deploy/flyio/cleanup-proof-machine.sh",
    );
    expect(workflow).toContain(
      "deploy/flyio/verify-bucket-empty.sh",
    );
    expect(workflow).toContain(
      "steps.bucket_guard.outputs.empty == 'true'",
    );
    expect(workflow).toContain(
      "HAYASEND_FLY_TIGRIS_EMPTY: \"true\"",
    );
    expect(workflow).toContain("deploy/flyio/cleanup.sh");
    expect(workflow).not.toContain("SENDGRID_API_KEY");
    expect(workflow).not.toContain("flyctl-actions");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(
      /actions\/upload-artifact@[0-9a-f]{40}/,
    );
  });
});
