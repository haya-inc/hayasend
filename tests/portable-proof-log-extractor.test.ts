import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const extractor = resolve("scripts/extract-portable-hosted-proof.mjs");

describe("portable hosted proof log extractor", () => {
  it("extracts one pretty-printed proof from provider noise", async () => {
    const input = [
      "provider init {not-json}",
      JSON.stringify(
        {
          object: "portable_hosted_semantic_proof",
          nested: {
            braces: "a {quoted} value",
          },
        },
        null,
        2,
      ),
      "provider shutdown",
    ].join("\n");

    const result = spawnSync(process.execPath, [extractor], {
      encoding: "utf8",
      input,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      object: "portable_hosted_semantic_proof",
      nested: { braces: "a {quoted} value" },
    });
  });

  it("fails closed when multiple proof objects are present", async () => {
    const proof = JSON.stringify({
      object: "portable_hosted_semantic_proof",
    });

    const result = spawnSync(process.execPath, [extractor], {
      encoding: "utf8",
      input: `${proof}\n${proof}\n`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Expected exactly one portable hosted proof",
    );
  });
});
