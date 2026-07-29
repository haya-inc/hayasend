import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const extractor = resolve(
  "scripts/extract-portable-hosted-proof.mjs",
);

describe("portable hosted proof log extractor", () => {
  it("extracts one pretty-printed proof from provider noise", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-proof-extractor-"),
    );
    const input = resolve(directory, "logs.txt");
    const output = resolve(directory, "proof.json");
    await writeFile(
      input,
      [
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
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      [extractor, input, output],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      JSON.parse(await readFile(output, "utf8")),
    ).toMatchObject({
      object: "portable_hosted_semantic_proof",
      nested: { braces: "a {quoted} value" },
    });
  });

  it("fails closed when multiple proof objects are present", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-proof-extractor-"),
    );
    const input = resolve(directory, "logs.txt");
    const output = resolve(directory, "proof.json");
    const proof = JSON.stringify({
      object: "portable_hosted_semantic_proof",
    });
    await writeFile(input, `${proof}\n${proof}\n`);

    const result = spawnSync(
      process.execPath,
      [extractor, input, output],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Expected exactly one portable hosted proof",
    );
  });
});
