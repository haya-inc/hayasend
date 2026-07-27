import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectWorkersBoundaryViolations,
} from "../scripts/check-workers-boundary.mjs";
import worker, {
  CLOUDFLARE_WORKER_CAPABILITY,
} from "../src/workers/index.js";

describe("Cloudflare Workers runtime skeleton", () => {
  it("declares its incomplete, non-production capability honestly", async () => {
    expect(CLOUDFLARE_WORKER_CAPABILITY).toMatchObject({
      runtime: "cloudflare-workers",
      maturity: "experimental-skeleton",
      production_ready: false,
      api: {
        health: true,
        capabilities: true,
        email_api: false,
      },
      adapters: {
        metadata_store: false,
        payload_storage: false,
        queue: false,
        scheduler: false,
        mail_transport: false,
        inbound_email: false,
      },
    });
    expect(CLOUDFLARE_WORKER_CAPABILITY.capability_digest).toMatch(
      /^[0-9a-f]{64}$/,
    );

    const response = worker.fetch(
      new Request("https://workers.invalid/capabilities"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      CLOUDFLARE_WORKER_CAPABILITY,
    );
  });

  it("exposes only skeleton health and capability routes", async () => {
    const health = worker.fetch(
      new Request("https://workers.invalid/healthz"),
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      runtime: "cloudflare-workers",
      status: "skeleton",
      production_ready: false,
    });

    const emailApi = worker.fetch(
      new Request("https://workers.invalid/emails"),
    );
    expect(emailApi.status).toBe(404);
    await expect(emailApi.json()).resolves.toMatchObject({
      error: {
        name: "not_found",
      },
    });
  });

  it("reports forbidden Node and AWS dependency paths", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "hayasend-workers-boundary-"));
    for (const directory of [
      "src/core",
      "src/ports",
      "src/services",
      "src/workers",
    ]) {
      await mkdir(join(fixture, directory), { recursive: true });
    }
    for (const file of ["src/app.ts", "src/schemas.ts", "src/version.ts"]) {
      await writeFile(join(fixture, file), "export {};\n");
    }
    await writeFile(
      join(fixture, "src/services/forbidden.ts"),
      [
        'import { readFile } from "node:fs/promises";',
        'import { S3Client } from "@aws-sdk/client-s3";',
        "export const read = readFile;",
        "export const client = new S3Client();",
      ].join("\n"),
    );

    await expect(
      collectWorkersBoundaryViolations(fixture),
    ).resolves.toEqual([
      'src/services/forbidden.ts imports forbidden module "node:fs/promises"',
      'src/services/forbidden.ts imports forbidden module "@aws-sdk/client-s3"',
    ]);
  });
});
