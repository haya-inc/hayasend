import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Cloudflare hosted evidence scripts", () => {
  it("derives the stable production endpoint instead of a version preview", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "hayasend-cloudflare-evidence-"),
    );
    temporaryDirectories.push(directory);
    const input = join(directory, "deploy.txt");
    const environment = join(directory, "github.env");
    await writeFile(
      input,
      `${JSON.stringify({ object: "cloudflare_deployment_plan" })}\n${JSON.stringify(
        {
          object: "cloudflare_deployment_result",
          version_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          database_id: "11111111-2222-3333-4444-555555555555",
          resources: { worker: "hayasend-proof" },
          targets: [],
        },
        null,
        2,
      )}\n`,
    );

    await execFileAsync(process.execPath, [
      "scripts/extract-cloudflare-deployment-result.mjs",
      "--file",
      input,
      "--github-env",
      environment,
      "--prefix",
      "INITIAL_",
      "--workers-subdomain",
      "controlled-subdomain",
    ]);

    await expect(readFile(environment, "utf8")).resolves.toContain(
      "INITIAL_CF_ENDPOINT=https://hayasend-proof.controlled-subdomain.workers.dev",
    );
  });
});
