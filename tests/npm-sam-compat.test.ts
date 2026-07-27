import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("AWS SAM npm compatibility adapter", () => {
  it("removes only SAM's obsolete unsafe-perm flag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hayasend-npm-sam-test-"));
    const capturedArguments = join(directory, "arguments.json");
    const fakeNpmCli = join(directory, "npm-cli.mjs");
    await writeFile(
      fakeNpmCli,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(",
        "  process.env.HAYASEND_CAPTURED_ARGUMENTS,",
        "  JSON.stringify(process.argv.slice(2)),",
        ");",
      ].join("\n"),
      "utf8",
    );

    await execFileAsync(
      process.execPath,
      [
        "scripts/npm-sam-compat.mjs",
        "install",
        "--unsafe-perm",
        "--omit=dev",
        "--no-audit",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HAYASEND_CAPTURED_ARGUMENTS: capturedArguments,
          HAYASEND_REAL_NPM_CLI: fakeNpmCli,
        },
      },
    );

    expect(JSON.parse(await readFile(capturedArguments, "utf8"))).toEqual([
      "install",
      "--omit=dev",
      "--no-audit",
    ]);
  });
});
