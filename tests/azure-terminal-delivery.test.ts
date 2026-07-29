import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

const EMAIL_ID = "email_0123456789abcdef0123456789abcdef";
const PROVIDER_MESSAGE_ID = "provider-message-0123456789";
const RECIPIENTS = [
  "controlled-one@example.net",
  "controlled-two@example.org",
];

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(request, "end");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

describe("Azure ACS terminal delivery proof", () => {
  it("proves two real deliveries, event convergence, and scoped-key revocation", async () => {
    const idempotencyKeys: string[] = [];
    const emailPayloads: unknown[] = [];
    const apiKeyPayloads: unknown[] = [];
    const deletedApiKeys: string[] = [];
    const eventBatches: unknown[][] = [];
    const uniqueEventIds = new Set<string>();
    let postAttempts = 0;
    let unattributedEventCount = 0;

    const server = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api-keys") {
        apiKeyPayloads.push(await readJson(request));
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
        emailPayloads.push(await readJson(request));
        if (postAttempts === 1) {
          setTimeout(() => {
            response.writeHead(200, {
              "content-type": "application/json",
            });
            response.end(JSON.stringify({ id: EMAIL_ID }));
          }, 100);
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: EMAIL_ID }));
        return;
      }
      if (
        request.method === "GET" &&
        request.url === `/emails/${EMAIL_ID}`
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: EMAIL_ID,
            message_id: PROVIDER_MESSAGE_ID,
            status: "delivered",
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url === `/emails/${EMAIL_ID}/recipients?limit=2`
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            aggregate_status: "delivered",
            data: [
              { status: "delivered" },
              { status: "delivered" },
            ],
            attempt_summary: { delivered: 2 },
            unattributed_event_count: unattributedEventCount,
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/events/azure-email"
      ) {
        if (
          request.headers["x-hayasend-event-grid-secret"] !==
          "event-grid-local-proof-secret-123456"
        ) {
          response.writeHead(401).end();
          return;
        }
        const batch = (await readJson(request)) as Array<{
          id: string;
          eventType: string;
        }>;
        eventBatches.push(batch);
        for (const event of batch) {
          if (
            !uniqueEventIds.has(event.id) &&
            event.eventType ===
              "Microsoft.Communication.EmailEngagementTrackingReportReceived"
          ) {
            unattributedEventCount += 1;
          }
          uniqueEventIds.add(event.id);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: true }));
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
        new URL(
          "../scripts/azure-terminal-delivery.mjs",
          import.meta.url,
        ).pathname,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          HAYASEND_BASE_URL: `http://127.0.0.1:${address.port}`,
          HAYASEND_BOOTSTRAP_KEY: "re_bootstrap_local",
          HAYASEND_AZURE_EVENT_GRID_SECRET:
            "event-grid-local-proof-secret-123456",
          HAYASEND_AZURE_EVENT_TOPIC:
            "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.Communication/communicationServices/hayasend",
          AZURE_TERMINAL_FROM: "sender@example.com",
          AZURE_TERMINAL_TO_JSON: JSON.stringify(RECIPIENTS),
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

    const output = Buffer.concat(stdout).toString("utf8");
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    expect(exitCode).toBe(0);
    expect(postAttempts).toBe(2);
    expect(new Set(idempotencyKeys)).toEqual(
      new Set(["hayasend-azure-terminal-1234-1"]),
    );
    expect(apiKeyPayloads).toEqual([
      {
        name: "azure-terminal-1234-1",
        scopes: ["emails:send", "emails:read"],
      },
    ]);
    expect(emailPayloads).toHaveLength(2);
    expect(emailPayloads[0]).toMatchObject({
      from: "sender@example.com",
      to: RECIPIENTS,
    });
    expect(emailPayloads[1]).toEqual(emailPayloads[0]);
    expect(deletedApiKeys).toEqual(["key_0123456789abcdef"]);
    expect(eventBatches.map((batch) => batch.length)).toEqual([
      2, 2, 2, 1, 1,
    ]);
    expect(uniqueEventIds.size).toBe(5);
    expect(unattributedEventCount).toBe(1);
    const subject = "HayaSend Azure ACS terminal delivery 1234-1";
    for (const sensitive of [
      ...RECIPIENTS,
      PROVIDER_MESSAGE_ID,
      EMAIL_ID,
      subject,
    ]) {
      expect(output).not.toContain(sensitive);
    }
    const observations = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations.at(-1)).toMatchObject({
      object: "azure_acs_terminal_delivery_proof",
      email_status: "delivered",
      aggregate_status: "delivered",
      recipient_statuses: ["delivered", "delivered"],
      recipient_count: 2,
      duplicate_delivery_replay_converged: true,
      older_expanded_event_did_not_regress: true,
      unattributed_engagement_deduplicated: true,
      real_terminal_delivery_observed: true,
      send_attempts: 2,
      send_transient_failures: 1,
      scoped_api_key_revoked: true,
      terminal: true,
    });
    expect(observations.at(-1).provider_message_id_sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(observations.at(-1).email_reference_sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});
