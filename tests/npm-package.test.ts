import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { npmPackageIntegrity } from "../scripts/npm-package-integrity.mjs";

describe("npm CLI distribution", () => {
  it("publishes a public package tied to the canonical repository", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    expect(packageJson).not.toHaveProperty("private");
    expect(packageJson).toMatchObject({
      name: "@haya-inc/hayasend",
      homepage: "https://haya-inc.github.io/hayasend/",
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
      files: expect.arrayContaining(["dist", "NOTICE", "schemas"]),
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

  it("publishes the attested release tarball idempotently", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain(
      "npm install --global --ignore-scripts npm@12.0.1",
    );
    expect(workflow).toContain('npm_archive="haya-inc-hayasend-${VERSION}.tgz"');
    expect(workflow).toContain(
      'node scripts/npm-package-integrity.mjs < "$archive"',
    );
    expect(workflow).toContain(
      'npm view "${package_name}@${VERSION}" dist.integrity',
    );
    expect(workflow).toContain('if [ "$published_integrity" != "$local_integrity" ]');
    expect(workflow).toContain('npm publish "$archive"');
    expect(workflow).toContain("--provenance");
    expect(workflow).toContain('--tag "$npm_tag"');
  });
});
