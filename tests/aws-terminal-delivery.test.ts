import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

const EMAIL_ID = "email_0123456789abcdef0123456789abcdef";

describe("AWS SES terminal delivery proof", () => {
  it("uses one idempotency key, reaches delivered, and revokes its scoped key", async () => {
    const idempotencyKeys: string[] = [];
    const deletedApiKeys: string[] = [];
    let postAttempts = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/api-keys") {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "key_0123456789abcdef",
            token: "re_hs_key_local-proof",
          }),
        );
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url === "/api-keys/key_0123456789abcdef"
      ) {
        deletedApiKeys.push("key_0123456789abcdef");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "key_0123456789abcdef",
            revoked: true,
          }),
        );
        return;
      }
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
            attempt_summary: { accepted: 1 },
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

    const child = spawn(
      process.execPath,
      [
        new URL("../scripts/aws-terminal-delivery.mjs", import.meta.url)
          .pathname,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          HAYASEND_BASE_URL: `http://127.0.0.1:${address.port}`,
          HAYASEND_EXPECTED_API_ID: "unused",
          HAYASEND_BOOTSTRAP_KEY: "re_bootstrap_local",
          AWS_REGION: "ap-northeast-1",
          AWS_TERMINAL_FROM: "sender@example.com",
          AWS_TERMINAL_TO: "recipient@example.net",
          GITHUB_RUN_ID: "1234",
          GITHUB_RUN_ATTEMPT: "1",
        },
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
      new Set(["hayasend-aws-terminal-1234-1"]),
    );
    expect(deletedApiKeys).toEqual(["key_0123456789abcdef"]);
    const observations = Buffer.concat(stdout)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations.at(-1)).toMatchObject({
      object: "aws_ses_terminal_delivery_proof",
      email_id: EMAIL_ID,
      email_status: "delivered",
      aggregate_status: "delivered",
      recipient_status: "delivered",
      send_attempts: 2,
      send_transient_failures: 1,
      scoped_api_key_revoked: true,
      terminal: true,
    });
  });
});
