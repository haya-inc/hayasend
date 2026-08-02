import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { npmPackageIntegrity } from "../scripts/npm-package-integrity.mjs";
import { HAYASEND_VERSION } from "../src/version.js";

describe("npm CLI distribution", () => {
  it("publishes a public package tied to the canonical repository", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    expect(packageJson).not.toHaveProperty("private");
    expect(packageJson.version).toBe(HAYASEND_VERSION);
    expect(packageJson).toMatchObject({
      name: "@haya-inc/hayasend",
      homepage: "https://hayasend.com/",
      repository: {
        type: "git",
        url: "git+https://github.com/haya-inc/hayasend.git",
      },
      bugs: {
        url: "https://github.com/haya-inc/hayasend/issues",
      },
      bin: {
        hayasend: "dist/cli.js",
      },
      files: expect.arrayContaining([
        "dist",
        "NOTICE",
        "scripts/npm-sam-compat.mjs",
        "schemas",
        "src",
        "template.yaml",
      ]),
      dependencies: expect.objectContaining({
        esbuild: "0.28.1",
      }),
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
      },
    });
  });

  it("computes the registry integrity of the exact tarball bytes", () => {
    const content = Buffer.from("attestable HayaSend package");

    expect(npmPackageIntegrity(content)).toBe(
      `sha512-${createHash("sha512").update(content).digest("base64")}`,
    );
  });

  it("ships guarded hosted recovery helpers within a bounded package", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(workflow).toContain(".entryCount <= 639");
    expect(workflow).toContain(".size < 900000");
    expect(workflow).toContain(".unpackedSize < 4600000");
    expect(workflow).toContain(
      'index("dist/cli-resend-migration.js") != null',
    );
    expect(workflow).toContain(
      'index("src/cli-resend-migration.ts") != null',
    );
    expect(workflow).toContain('index("dist/cli-aws-bootstrap.js") != null');
    expect(workflow).toContain('index("dist/operator-console.js") != null');
    expect(workflow).toContain('index("src/operator-console.ts") != null');
    expect(workflow).toContain(
      'index("dist/operator-console-view.js") != null',
    );
    expect(workflow).toContain(
      'index("src/operator-console-view.tsx") != null',
    );
    expect(workflow).toContain('index("dist/console-auth.js") != null');
    expect(workflow).toContain('index("src/console-auth.ts") != null');
    expect(workflow).toContain(
      'index("deploy/aws-cloudformation-bootstrap.yaml") != null',
    );
    expect(workflow).toContain(
      'index("dist/portable/backup-restore-proof.js") != null',
    );
    expect(workflow).toContain(
      'test -f \\\n            "$package_root/dist/portable/backup-restore-proof.js"',
    );
    expect(workflow).toContain(
      'index("dist/portable/backup-restore-seed.js") != null',
    );
    expect(workflow).toContain(
      'index("dist/portable/backup-restore-verify.js") != null',
    );
    expect(packageJson.scripts?.["proof:portable-backup-seed"]).toBe(
      "node dist/portable/backup-restore-seed.js",
    );
    expect(packageJson.scripts?.["proof:portable-backup-restore"]).toBe(
      "node dist/portable/backup-restore-verify.js",
    );
    for (const provider of ["cloud-run", "render", "railway"]) {
      expect(workflow).toContain(
        `index("deploy/${provider}/rollback.sh") != null`,
      );
      expect(workflow).toContain(
        `test -x "$package_root/deploy/${provider}/rollback.sh"`,
      );
    }
  });

  it("publishes the attested release tarball idempotently", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("ref: ${{ inputs.release_tag || github.ref }}");
    expect(workflow).toContain("if: github.event_name == 'push'");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain(
      "npm install --global --ignore-scripts npm@12.0.2",
    );
    expect(workflow).toContain(
      'npm_archive="haya-inc-hayasend-${VERSION}.tgz"',
    );
    expect(workflow).toContain(
      'node scripts/npm-package-integrity.mjs < "$archive"',
    );
    expect(workflow).toContain(
      'npm view "${package_name}@${VERSION}" dist.integrity',
    );
    expect(workflow).toContain("--userconfig=/dev/null");
    expect(workflow).toContain("--registry=https://registry.npmjs.org/");
    expect(workflow).toContain("--prefer-online");
    expect(workflow).toContain('elif type == "array" then');
    expect(workflow).toContain(
      'map(select(type == "string")) | first // empty',
    );
    expect(workflow).toContain(
      'if [ "$published_integrity" != "$local_integrity" ]',
    );
    expect(workflow).toContain(
      'archive="./release/haya-inc-hayasend-${VERSION}.tgz"',
    );
    expect(workflow).toContain('npm publish "$archive"');
    expect(workflow).toContain("--provenance");
    expect(workflow).toContain('--tag "$npm_tag"');
  });
});
