import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const EMAIL_ID = "email_0123456789abcdef0123456789abcdef";

describe("Cloudflare terminal delivery proof", () => {
  it("recovers an ambiguous SDK timeout with the same idempotency key", async () => {
    const idempotencyKeys: string[] = [];
    let postAttempts = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/emails") {
        postAttempts += 1;
        const idempotencyKey = request.headers["idempotency-key"];
        idempotencyKeys.push(
          Array.isArray(idempotencyKey)
            ? idempotencyKey.join(",")
            : (idempotencyKey ?? ""),
        );
        request.resume();
        if (postAttempts === 1) {
          setTimeout(() => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: EMAIL_ID }));
          }, 100);
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: EMAIL_ID }));
        return;
      }
      if (request.method === "GET" && request.url === `/emails/${EMAIL_ID}`) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: EMAIL_ID, status: "delivered" }));
        return;
      }
      if (
        request.method === "GET" &&
        request.url === `/emails/${EMAIL_ID}/recipients?limit=1`
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            aggregate_status: "delivered",
            data: [{ status: "delivered" }],
            attempt_summary: { delivered: 1 },
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a local TCP address.");
    }
    const evidenceDirectory = await mkdtemp(
      join(tmpdir(), "hayasend-terminal-proof-"),
    );
    const child = spawn(
      process.execPath,
      [
        new URL("../scripts/cloudflare-terminal-delivery.mjs", import.meta.url)
          .pathname,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          CF_ENDPOINT: `http://127.0.0.1:${address.port}`,
          HAYASEND_CLOUDFLARE_API_KEY: "test-api-key",
          CLOUDFLARE_TEST_FROM: "integration@example.com",
          CLOUDFLARE_TEST_TO: "recipient@example.net",
          GITHUB_RUN_ID: "1234",
          GITHUB_RUN_ATTEMPT: "1",
        },
        cwd: evidenceDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const [exitCode] = (await once(child, "exit")) as [number];
    server.close();

    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    expect(exitCode).toBe(0);
    expect(postAttempts).toBe(2);
    expect(new Set(idempotencyKeys)).toEqual(
      new Set(["hayasend-cloudflare-terminal-1234-1"]),
    );
    const observations = Buffer.concat(stdout)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const proof = observations.at(-1);
    expect(proof).toMatchObject({
      object: "cloudflare_terminal_delivery_proof",
      email_id: EMAIL_ID,
      email_status: "delivered",
      aggregate_status: "delivered",
      recipient_status: "delivered",
      send_attempts: 2,
      send_transient_failures: 1,
      terminal: true,
    });
    expect(observations).toContainEqual(
      expect.objectContaining({
        object: "cloudflare_terminal_delivery_observation",
        send_transient_failures: 1,
        terminal: false,
      }),
    );
  });
});
