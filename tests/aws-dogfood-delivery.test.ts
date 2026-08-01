import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

describe("AWS SES dogfood sender", () => {
  it("retries idempotently, delivers a slot, and revokes its scoped key", async () => {
    const idempotencyKeys: string[] = [];
    const deletedApiKeys: string[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    const attempts = new Map<string, number>();
    const ids = new Map<string, string>();
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/api-keys") {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "key_0123456789abcdef",
            token: "re_hs_key_local-dogfood",
          }),
        );
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url === "/api-keys/key_0123456789abcdef"
      ) {
        request.resume();
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
        const key = String(request.headers["idempotency-key"] ?? "");
        idempotencyKeys.push(key);
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          payloads.push(JSON.parse(body));
          const attempt = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, attempt);
          const item = Number.parseInt(key.slice(-2), 10);
          const id = `email_${item.toString(16).padStart(32, "0")}`;
          ids.set(key, id);
          if (key.endsWith("01") && attempt === 1) {
            setTimeout(() => {
              response.writeHead(200, {
                "content-type": "application/json",
              });
              response.end(JSON.stringify({ id }));
            }, 100);
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id }));
        });
        return;
      }
      const emailMatch = /^\/emails\/(email_[a-f0-9]{32})$/.exec(
        request.url ?? "",
      );
      if (request.method === "GET" && emailMatch) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ id: emailMatch[1], status: "delivered" }),
        );
        return;
      }
      const recipientMatch =
        /^\/emails\/(email_[a-f0-9]{32})\/recipients\?limit=1$/.exec(
          request.url ?? "",
        );
      if (request.method === "GET" && recipientMatch) {
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
      [new URL("../scripts/aws-dogfood.mjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          HAYASEND_BASE_URL: `http://127.0.0.1:${address.port}`,
          HAYASEND_EXPECTED_API_ID: "unused",
          HAYASEND_BOOTSTRAP_KEY: "re_bootstrap_local",
          HAYASEND_DOGFOOD_BATCH_SIZE: "4",
          AWS_REGION: "ap-northeast-1",
          AWS_DOGFOOD_FROM: "HayaSend <dogfood@example.com>",
          AWS_DOGFOOD_TO: "controlled@example.net",
          AWS_DOGFOOD_START_DATE: "2026-08-02",
          AWS_DOGFOOD_RUN_DATE: "2026-08-02",
          AWS_DOGFOOD_SLOT: "0",
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
    expect(idempotencyKeys).toHaveLength(5);
    expect(new Set(idempotencyKeys)).toEqual(
      new Set([
        "hayasend-dogfood-v1-2026-08-02-s0-01",
        "hayasend-dogfood-v1-2026-08-02-s0-02",
        "hayasend-dogfood-v1-2026-08-02-s0-03",
        "hayasend-dogfood-v1-2026-08-02-s0-04",
      ]),
    );
    expect(ids.size).toBe(4);
    expect(payloads).toHaveLength(5);
    expect(
      payloads.every((payload) =>
        String(payload.text).includes("No customer or private content"),
      ),
    ).toBe(true);
    expect(deletedApiKeys).toEqual(["key_0123456789abcdef"]);
    const output = Buffer.concat(stdout)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(output.at(-1)).toMatchObject({
      object: "aws_ses_dogfood_delivery_proof",
      submitted: 4,
      delivered: 4,
      unique_email_ids: 4,
      send_attempts: 5,
      send_transient_failures: 1,
      scoped_api_key_revoked: true,
      terminal: true,
    });
  });
});
