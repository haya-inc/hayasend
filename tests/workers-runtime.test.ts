import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectWorkersBoundaryViolations,
} from "../scripts/check-workers-boundary.mjs";
import worker, {
  CLOUDFLARE_WORKER_CAPABILITY,
  type HayaSendCloudflareEnv,
} from "../src/workers/index.js";

function testEnv(
  overrides: Partial<HayaSendCloudflareEnv> = {},
): HayaSendCloudflareEnv {
  return {
    HAYASEND_API_KEY: "re_cloudflare_test",
    HAYASEND_DEPLOYMENT_ID: "test-deployment",
    HAYASEND_PROVIDER: "cloudflare-email",
    HAYASEND_HEALTH_MODE: "ready",
    PRIMARY_QUEUE_NAME: "test-primary",
    DLQ_QUEUE_NAME: "test-dlq",
    EMAIL_EVENTS_QUEUE_NAME: "test-events",
    ...overrides,
  } as HayaSendCloudflareEnv;
}

describe("Cloudflare Workers runtime substrate", () => {
  it("declares its Beta, non-production capability honestly", async () => {
    expect(CLOUDFLARE_WORKER_CAPABILITY).toMatchObject({
      runtime: "cloudflare-workers",
      maturity: "beta-proof",
      production_ready: false,
      api: {
        health: true,
        capabilities: true,
        email_api: true,
        email_send: true,
      },
      adapters: {
        metadata_store: "d1",
        payload_storage: "r2",
        queue: "cloudflare-queues",
        scheduler: "queue-delay-plus-cron",
        mail_transport: "cloudflare-email-sending-beta",
        inbound_email: false,
      },
    });
    expect(CLOUDFLARE_WORKER_CAPABILITY.capability_digest).toMatch(
      /^[0-9a-f]{64}$/,
    );

    const response = await worker.fetch(
      new Request("https://workers.invalid/capabilities"),
      testEnv(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      CLOUDFLARE_WORKER_CAPABILITY,
    );
  });

  it("exposes health and protects email routes", async () => {
    const health = await worker.fetch(
      new Request("https://workers.invalid/healthz"),
      testEnv(),
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      runtime: "cloudflare-workers",
      status: "ready",
      production_ready: false,
    });

    const emailApi = await worker.fetch(
      new Request("https://workers.invalid/emails"),
      testEnv(),
    );
    expect(emailApi.status).toBe(401);
    await expect(emailApi.json()).resolves.toMatchObject({
      name: "validation_error",
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
