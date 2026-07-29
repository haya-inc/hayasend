import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Vercel and Neon proof lifecycle security boundaries", () => {
  it("keeps production API origins fixed and lifecycle state off the local file system", async () => {
    const [project, blob, neon] = await Promise.all([
      readFile(
        new URL("../deploy/vercel/project-lifecycle.mjs", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/vercel/blob-store-lifecycle.mjs", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/vercel/neon-branch.mjs", import.meta.url),
        "utf8",
      ),
    ]);

    expect(project).toContain(
      'const PRODUCTION_API_ORIGIN = "https://api.vercel.com";',
    );
    expect(blob).toContain(
      'const PRODUCTION_API_ORIGIN = "https://api.vercel.com";',
    );
    expect(neon).toContain(
      'const PRODUCTION_API_ORIGIN = "https://console.neon.tech";',
    );

    for (const source of [project, blob, neon]) {
      expect(source).not.toContain("process.env.VERCEL_API_ORIGIN");
      expect(source).not.toContain("process.env.NEON_API_ORIGIN");
      expect(source).not.toContain("node:fs");
      expect(source).not.toContain("process.argv");
    }
  });

  it("uses explicit non-log channels for credentials and stdin/stdout for proof extraction", async () => {
    const [workflow, tokenExtractor, proofExtractor] = await Promise.all([
      readFile(
        new URL("../.github/workflows/vercel-integration.yml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../deploy/vercel/extract-production-blob-token.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../scripts/extract-portable-hosted-proof.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

    expect(workflow).toContain('3> "$BLOB_READ_WRITE_TOKEN_FILE"');
    expect(workflow).toContain('> "$NEON_DATABASE_URL_FILE"');
    expect(workflow).toContain("Remove private one-run local state");
    expect(workflow).toContain(': > "$private_file"');
    expect(tokenExtractor).toContain("writeSync(3,");
    expect(tokenExtractor).not.toContain("process.argv");
    expect(proofExtractor).toContain("process.stdin");
    expect(proofExtractor).not.toContain("process.argv");

    const artifactBlock = workflow.slice(
      workflow.indexOf("- name: Upload privacy-safe proof evidence"),
    );
    expect(artifactBlock).not.toContain("vercel-blob-token\n");
    expect(artifactBlock).not.toContain("neon-database-url\n");
  });
});
