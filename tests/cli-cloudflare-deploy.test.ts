import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "../src/cli-aws-deploy.js";
import {
  buildCloudflareWranglerConfig,
  CLOUDFLARE_EMAIL_SENDING_EVENTS,
  cleanupCloudflare,
  cloudflareResourceNames,
  deployCloudflare,
  doctorCloudflare,
  doctorCloudflareEmailEvents,
  rollbackCloudflare,
} from "../src/cli-cloudflare-deploy.js";

const ACCOUNT = "a".repeat(32);
const DATABASE_ID = "11111111-2222-3333-4444-555555555555";
const VERSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const EMAIL_DOMAIN = "example.com";

function result(stdout = "", stderr = "", exitCode = 0): CommandResult {
  return { stdout, stderr, exitCode };
}

describe("plan-first Cloudflare lifecycle", () => {
  it("derives narrowly scoped deterministic names", () => {
    expect(cloudflareResourceNames("proof")).toEqual({
      worker: "hayasend-proof",
      database: "hayasend-proof-d1",
      bucket: "hayasend-proof-payloads",
      primary_queue: "hayasend-proof-jobs",
      dead_letter_queue: "hayasend-proof-jobs-dlq",
      email_events_queue: "hayasend-proof-email-events",
    });
    expect(() => cloudflareResourceNames("Production")).toThrow("lowercase");
  });

  it("keeps deploy plan-only by default and records pinned truth", async () => {
    const logs: string[] = [];
    const runner = vi.fn<CommandRunner>();
    await deployCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        apply: false,
      },
      {
        cwd: process.cwd(),
        env: {},
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({
      object: "cloudflare_deployment_plan",
      mode: "deploy",
      account: ACCOUNT,
      toolchain: {
        wrangler: "4.114.0",
        compatibility_date: "2026-07-27",
      },
      production_ready: false,
      provider_maturity: "beta",
    });
  });

  it("requires an exact account confirmation before mutation", async () => {
    await expect(
      deployCloudflare(
        {
          account: ACCOUNT,
          name: "proof",
          apply: true,
          confirmAccount: "b".repeat(32),
        },
        {
          cwd: process.cwd(),
          env: {
            CLOUDFLARE_API_TOKEN: "private-token",
            HAYASEND_CLOUDFLARE_API_KEY: "re_cloudflare_integration_secret",
          },
          log: () => undefined,
          runCommand: vi.fn<CommandRunner>(),
        },
      ),
    ).rejects.toThrow(`--confirm-account ${ACCOUNT}`);
  });

  it("requires a controlled recipient allowlist before mutation", async () => {
    const runner = vi.fn<CommandRunner>();
    await expect(
      deployCloudflare(
        {
          account: ACCOUNT,
          name: "proof",
          emailDomain: EMAIL_DOMAIN,
          apply: true,
          confirmAccount: ACCOUNT,
        },
        {
          cwd: process.cwd(),
          env: {
            CLOUDFLARE_API_TOKEN: "private-token",
            HAYASEND_CLOUDFLARE_API_KEY: "re_cloudflare_integration_secret",
          },
          log: () => undefined,
          runCommand: runner,
        },
      ),
    ).rejects.toThrow("at least one --allowed-recipient");
    expect(runner).not.toHaveBeenCalled();
  });

  it("creates and initially deploys with secrets only in protected inputs", async () => {
    const logs: string[] = [];
    const calls: Array<{
      command: string;
      args: string[];
      options: CommandOptions;
    }> = [];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      const outputPath = options.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (args[2] === "deploy" && outputPath) {
        await writeFile(
          outputPath,
          `${JSON.stringify({
            type: "deploy",
            worker_name: "hayasend-proof",
            version_id: VERSION_ID,
            targets: ["https://hayasend-proof.example.workers.dev"],
          })}\n`,
        );
      }
      if (args[2] === "d1" && args.includes("list")) {
        return result(
          JSON.stringify([{ name: "hayasend-proof-d1", uuid: DATABASE_ID }]),
        );
      }
      if (
        args[2] === "queues" &&
        args[3] === "subscription" &&
        args[4] === "list"
      ) {
        return result("[]");
      }
      return result();
    };

    await deployCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        emailDomain: EMAIL_DOMAIN,
        deploymentId: "integration-1234",
        allowedRecipients: ["recipient@example.net"],
        apply: true,
        confirmAccount: ACCOUNT,
      },
      {
        cwd: process.cwd(),
        env: {
          CLOUDFLARE_API_TOKEN: "private-token",
          HAYASEND_CLOUDFLARE_API_KEY: "re_cloudflare_integration_secret",
        },
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );

    const commands = calls.map(({ args }) => args.slice(2, 5).join(" "));
    expect(commands).toContain("d1 create hayasend-proof-d1");
    expect(commands).toContain("r2 bucket create");
    expect(calls.some(({ args }) => args[2] === "deploy")).toBe(true);
    expect(
      calls.some(
        ({ args }) => args.slice(2, 4).join(" ") === "versions upload",
      ),
    ).toBe(false);
    expect(
      calls.some(
        ({ args }) => args.slice(2, 4).join(" ") === "versions deploy",
      ),
    ).toBe(false);
    expect(
      calls.every(
        ({ options }) => options.env?.CLOUDFLARE_ACCOUNT_ID === ACCOUNT,
      ),
    ).toBe(true);
    expect(
      calls.every(
        ({ options }) => options.env?.HAYASEND_CLOUDFLARE_API_KEY === undefined,
      ),
    ).toBe(true);
    const deploy = calls.find(({ args }) => args[2] === "deploy");
    const secretPath = deploy?.args[deploy.args.indexOf("--secrets-file") + 1];
    expect(secretPath).toBeDefined();
    await expect(readFile(secretPath!, "utf8")).rejects.toThrow();
    expect(JSON.stringify(logs)).not.toContain("private-token");
    expect(JSON.stringify(logs)).not.toContain(
      "re_cloudflare_integration_secret",
    );
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      object: "cloudflare_deployment_result",
      deployment_id: "integration-1234",
      version_id: VERSION_ID,
      database_id: DATABASE_ID,
      event_subscription: {
        source: "email.sending",
        domain: EMAIL_DOMAIN,
        events: CLOUDFLARE_EMAIL_SENDING_EVENTS,
        status: "manual_configuration_required",
      },
      production_ready: false,
    });
  });

  it("uploads and deploys an immutable version for upgrades", async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const runner: CommandRunner = async (_command, args, options) => {
      calls.push(args);
      const outputPath = options.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (args.slice(2, 4).join(" ") === "versions upload" && outputPath) {
        await writeFile(
          outputPath,
          `${JSON.stringify({
            type: "version-upload",
            worker_name: "hayasend-proof",
            version_id: VERSION_ID,
          })}\n`,
        );
      }
      if (args.slice(2, 4).join(" ") === "versions deploy" && outputPath) {
        await writeFile(
          outputPath,
          `${JSON.stringify({
            type: "version-deploy",
            worker_name: "hayasend-proof",
            deployment_id: "cloudflare-deployment-id",
            version_traffic: { [VERSION_ID]: 100 },
          })}\n`,
        );
      }
      return result();
    };

    await deployCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        emailDomain: EMAIL_DOMAIN,
        deploymentId: "integration-upgrade",
        databaseId: DATABASE_ID,
        allowedRecipients: ["recipient@example.net"],
        apply: true,
        confirmAccount: ACCOUNT,
      },
      {
        cwd: process.cwd(),
        env: {
          CLOUDFLARE_API_TOKEN: "private-token",
          HAYASEND_CLOUDFLARE_API_KEY: "re_cloudflare_integration_secret",
        },
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );

    expect(
      calls.some((args) => args.slice(2, 4).join(" ") === "versions upload"),
    ).toBe(true);
    expect(
      calls.some((args) => args.slice(2, 4).join(" ") === "versions deploy"),
    ).toBe(true);
    expect(calls.some((args) => args[2] === "d1" && args[3] === "create")).toBe(
      false,
    );
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      object: "cloudflare_deployment_result",
      version_id: VERSION_ID,
      cloudflare_deployment_id: "cloudflare-deployment-id",
    });
  });

  it("retries an uploaded version while Cloudflare propagates it", async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const sleep = vi.fn(async () => undefined);
    let deployAttempts = 0;
    const runner: CommandRunner = async (_command, args, options) => {
      calls.push(args);
      const outputPath = options.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (args.slice(2, 4).join(" ") === "versions upload" && outputPath) {
        await writeFile(
          outputPath,
          `${JSON.stringify({
            type: "version-upload",
            worker_name: "hayasend-proof",
            version_id: VERSION_ID,
          })}\n`,
        );
      }
      if (args.slice(2, 4).join(" ") === "versions deploy") {
        deployAttempts += 1;
        if (deployAttempts === 1) {
          return result("", "Version not found [code: 10013]", 1);
        }
        if (outputPath) {
          await writeFile(
            outputPath,
            `${JSON.stringify({
              type: "version-deploy",
              worker_name: "hayasend-proof",
              deployment_id: "cloudflare-deployment-id",
              version_traffic: { [VERSION_ID]: 100 },
            })}\n`,
          );
        }
      }
      return result();
    };

    await deployCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        emailDomain: EMAIL_DOMAIN,
        deploymentId: "integration-upgrade",
        databaseId: DATABASE_ID,
        allowedRecipients: ["recipient@example.net"],
        apply: true,
        confirmAccount: ACCOUNT,
      },
      {
        cwd: process.cwd(),
        env: {
          CLOUDFLARE_API_TOKEN: "private-token",
          HAYASEND_CLOUDFLARE_API_KEY: "re_cloudflare_integration_secret",
        },
        log: (message) => logs.push(message),
        runCommand: runner,
        sleep,
      },
    );

    expect(
      calls.filter((args) => args.slice(2, 4).join(" ") === "versions upload"),
    ).toHaveLength(1);
    expect(
      calls.filter((args) => args.slice(2, 4).join(" ") === "versions deploy"),
    ).toHaveLength(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(logs).toContain(
      `Cloudflare version ${VERSION_ID} is still propagating; retrying deployment.`,
    );
  });

  it("builds the provider switch and all runtime bindings from configuration", () => {
    const config = buildCloudflareWranglerConfig({
      names: cloudflareResourceNames("proof"),
      databaseId: DATABASE_ID,
      deploymentId: "integration-1234",
      healthMode: "ready",
      allowedRecipients: ["recipient@example.net"],
    });
    expect(config).toMatchObject({
      vars: {
        HAYASEND_PROVIDER: "cloudflare-email",
      },
      d1_databases: [{ binding: "DB", database_id: DATABASE_ID }],
      r2_buckets: [{ binding: "PAYLOADS" }],
      send_email: [
        {
          name: "EMAIL",
          allowed_destination_addresses: ["recipient@example.net"],
        },
      ],
      queues: {
        producers: [{ binding: "PRIMARY_QUEUE" }],
      },
    });
  });

  it("keeps rollback and cleanup plan-only without explicit apply", async () => {
    const runner = vi.fn<CommandRunner>();
    const logs: string[] = [];
    const dependencies = {
      cwd: process.cwd(),
      env: {},
      log: (message: string) => logs.push(message),
      runCommand: runner,
    };
    await rollbackCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        versionId: VERSION_ID,
        apply: false,
      },
      dependencies,
    );
    await cleanupCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        apply: false,
      },
      dependencies,
    );
    expect(runner).not.toHaveBeenCalled();
    expect(logs.map((line) => JSON.parse(line).object)).toEqual([
      "cloudflare_rollback_plan",
      "cloudflare_cleanup_plan",
    ]);
  });

  it("fails closed unless one exact Email Sending subscription is enabled", async () => {
    const logs: string[] = [];
    const subscription = {
      id: "subscription-1234",
      name: "HayaSend terminal delivery",
      enabled: true,
      source: {
        type: "email.sending",
        domain: EMAIL_DOMAIN,
      },
      destination: {
        type: "queues.queue",
        queue_id: "queue-1234",
      },
      events: [...CLOUDFLARE_EMAIL_SENDING_EVENTS],
    };
    const runner: CommandRunner = async () =>
      result(JSON.stringify([subscription]));
    await doctorCloudflareEmailEvents(
      {
        account: ACCOUNT,
        name: "proof",
        emailDomain: EMAIL_DOMAIN,
      },
      {
        cwd: process.cwd(),
        env: { CLOUDFLARE_API_TOKEN: "private-token" },
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      object: "cloudflare_email_event_subscription_doctor",
      subscriptions_found: 1,
      healthy: true,
      matching_subscriptions: [
        {
          id: subscription.id,
          domain: EMAIL_DOMAIN,
          enabled: true,
        },
      ],
    });

    await expect(
      doctorCloudflareEmailEvents(
        {
          account: ACCOUNT,
          name: "proof",
          emailDomain: "other.example",
        },
        {
          cwd: process.cwd(),
          env: { CLOUDFLARE_API_TOKEN: "private-token" },
          log: () => undefined,
          runCommand: runner,
        },
      ),
    ).rejects.toThrow("exactly one subscription");

    await expect(
      doctorCloudflareEmailEvents(
        {
          account: ACCOUNT,
          name: "proof",
          emailDomain: EMAIL_DOMAIN,
        },
        {
          cwd: process.cwd(),
          env: { CLOUDFLARE_API_TOKEN: "private-token" },
          log: () => undefined,
          runCommand: async () =>
            result(
              JSON.stringify([
                subscription,
                {
                  ...subscription,
                  id: "subscription-unexpected",
                  enabled: false,
                },
              ]),
            ),
        },
      ),
    ).rejects.toThrow("exactly one subscription");
  });

  it("deletes Queue event subscriptions before consumers and resources", async () => {
    const calls: string[][] = [];
    const subscription = {
      id: "subscription-1234",
      name: "HayaSend terminal delivery",
      enabled: true,
      source: {
        type: "email.sending",
        domain: EMAIL_DOMAIN,
      },
      destination: {
        type: "queues.queue",
        queue_id: "queue-1234",
      },
      events: [...CLOUDFLARE_EMAIL_SENDING_EVENTS],
    };
    const runner: CommandRunner = async (_command, args) => {
      calls.push(args.slice(2));
      if (
        args[2] === "queues" &&
        args[3] === "subscription" &&
        args[4] === "list"
      ) {
        return result(JSON.stringify([subscription]));
      }
      return result();
    };
    await cleanupCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        apply: true,
        confirmAccount: ACCOUNT,
      },
      {
        cwd: process.cwd(),
        env: { CLOUDFLARE_API_TOKEN: "private-token" },
        log: () => undefined,
        runCommand: runner,
      },
    );
    expect(calls.slice(0, 3)).toEqual([
      [
        "queues",
        "subscription",
        "list",
        "hayasend-proof-email-events",
        "--per-page",
        "100",
        "--json",
      ],
      [
        "queues",
        "subscription",
        "delete",
        "hayasend-proof-email-events",
        "--id",
        subscription.id,
        "--force",
      ],
      [
        "queues",
        "consumer",
        "remove",
        "hayasend-proof-email-events",
        "hayasend-proof",
      ],
    ]);
  });

  it("deletes the deterministic resource set and referenced payloads in order", async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const objectKey = `emails/email_${"a".repeat(32)}/11111111-2222-3333-4444-555555555555.json`;
    const runner: CommandRunner = async (_command, args) => {
      calls.push(args);
      if (
        args[2] === "queues" &&
        args[3] === "subscription" &&
        args[4] === "list"
      ) {
        return result("[]");
      }
      if (args.includes("execute")) {
        return result(
          JSON.stringify([{ results: [{ object_key: objectKey }] }]),
        );
      }
      return result();
    };

    await cleanupCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        apply: true,
        confirmAccount: ACCOUNT,
      },
      {
        cwd: process.cwd(),
        env: { CLOUDFLARE_API_TOKEN: "private-token" },
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );

    const operations = calls.map((args) => args.slice(2));
    expect(operations[0]).toEqual([
      "queues",
      "subscription",
      "list",
      "hayasend-proof-email-events",
      "--per-page",
      "100",
      "--json",
    ]);
    expect(operations[1]).toEqual([
      "queues",
      "consumer",
      "remove",
      "hayasend-proof-email-events",
      "hayasend-proof",
    ]);
    expect(operations[2]).toEqual([
      "queues",
      "consumer",
      "remove",
      "hayasend-proof-jobs",
      "hayasend-proof",
    ]);
    expect(operations[3]).toEqual([
      "queues",
      "consumer",
      "remove",
      "hayasend-proof-jobs-dlq",
      "hayasend-proof",
    ]);
    expect(operations[4]).toEqual(["delete", "hayasend-proof"]);
    expect(operations[5]?.slice(0, 3)).toEqual([
      "d1",
      "execute",
      "hayasend-proof-d1",
    ]);
    expect(operations[6]).toEqual([
      "r2",
      "object",
      "delete",
      `hayasend-proof-payloads/${objectKey}`,
      "--remote",
      "--force",
    ]);
    expect(operations.at(-1)).toEqual([
      "d1",
      "delete",
      "hayasend-proof-d1",
      "--skip-confirmation",
    ]);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      object: "cloudflare_cleanup_result",
      complete: true,
      deleted_payload_objects: 1,
    });
  });

  it("treats an already absent Worker as an idempotent cleanup success", async () => {
    const logs: string[] = [];
    const runner: CommandRunner = async (_command, args) => {
      if (
        args[2] === "queues" &&
        args[3] === "subscription" &&
        args[4] === "list"
      ) {
        return result("[]");
      }
      if (args[2] === "delete") {
        return result(
          "",
          "This Worker does not exist on this account. [code: 10090]",
          1,
        );
      }
      return result();
    };

    await cleanupCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        apply: true,
        confirmAccount: ACCOUNT,
      },
      {
        cwd: process.cwd(),
        env: { CLOUDFLARE_API_TOKEN: "private-token" },
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );

    const cleanup = JSON.parse(logs.at(-1)!) as {
      object: string;
      complete: boolean;
      results: Array<Record<string, unknown>>;
    };
    expect(cleanup).toMatchObject({
      object: "cloudflare_cleanup_result",
      complete: true,
    });
    expect(cleanup.results[0]).toMatchObject({
      resource: "hayasend-proof-email-events consumer hayasend-proof",
      ok: true,
    });
    expect(cleanup.results[3]).toMatchObject({
      resource: "hayasend-proof",
      ok: true,
      diagnostic: "Resource was already absent (Cloudflare code 10090).",
    });
  });

  it("verifies Worker absence when Wrangler fails after deleting it", async () => {
    const logs: string[] = [];
    const runner: CommandRunner = async (_command, args) => {
      const operation = args.slice(2);
      if (
        operation[0] === "queues" &&
        operation[1] === "subscription" &&
        operation[2] === "list"
      ) {
        return result("[]");
      }
      if (operation[0] === "delete") {
        return result(
          "",
          "KV namespace cleanup failed. Authentication error [code: 10000]",
          1,
        );
      }
      if (operation[0] === "versions" && operation[1] === "list") {
        return result(
          "",
          "This Worker does not exist on your account. [code: 10007]",
          1,
        );
      }
      return result();
    };

    await cleanupCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        apply: true,
        confirmAccount: ACCOUNT,
      },
      {
        cwd: process.cwd(),
        env: { CLOUDFLARE_API_TOKEN: "private-token" },
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );

    const cleanup = JSON.parse(logs.at(-1)!) as {
      complete: boolean;
      results: Array<Record<string, unknown>>;
    };
    expect(cleanup.complete).toBe(true);
    expect(cleanup.results[3]).toMatchObject({
      resource: "hayasend-proof",
      ok: true,
      diagnostic:
        "Worker deletion postcondition verified after Wrangler cleanup failed.",
    });
  });

  it("makes a partially completed cleanup fully idempotent", async () => {
    const logs: string[] = [];
    const runner: CommandRunner = async (_command, args) => {
      const operation = args.slice(2);
      if (
        operation[0] === "queues" &&
        operation[1] === "subscription" &&
        operation[2] === "list"
      ) {
        return result("", `Queue "${operation[3]}" does not exist.`, 1);
      }
      if (operation[0] === "queues" && operation[1] === "consumer") {
        return result(
          "",
          `Queue "${operation[3]}" does not exist. To create it, run: wrangler queues create ${operation[3]}`,
          1,
        );
      }
      if (operation[0] === "delete") {
        return result(
          "",
          "This Worker does not exist on your account. [code: 10007]",
          1,
        );
      }
      if (operation[0] === "d1" && operation[1] === "execute") {
        return result(
          "",
          "Couldn't find a D1 DB with name or binding 'hayasend-proof-d1'",
          1,
        );
      }
      if (operation[0] === "r2") {
        return result(
          "",
          "The specified bucket does not exist. [code: 10006]",
          1,
        );
      }
      if (operation[0] === "queues" && operation[1] === "delete") {
        return result(
          "",
          `Queue "${operation[2]}" does not exist. To create it, run: wrangler queues create ${operation[2]}`,
          1,
        );
      }
      if (operation[0] === "d1" && operation[1] === "delete") {
        return result(
          "",
          "Couldn't find a D1 DB with name or binding 'hayasend-proof-d1'",
          1,
        );
      }
      return result();
    };

    await cleanupCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        apply: true,
        confirmAccount: ACCOUNT,
      },
      {
        cwd: process.cwd(),
        env: { CLOUDFLARE_API_TOKEN: "private-token" },
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );

    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      object: "cloudflare_cleanup_result",
      complete: true,
      deleted_payload_objects: 0,
    });
  });

  it("doctors health, digest, Beta truth, and authenticated API", async () => {
    const logs: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/healthz") {
        return Response.json({
          runtime: "cloudflare-workers",
          production_ready: false,
          deployment_id: "integration-1234",
        });
      }
      if (path === "/capabilities") {
        const { CLOUDFLARE_WORKER_CAPABILITY } =
          await import("../src/cloudflare-worker-capability.js");
        return Response.json(CLOUDFLARE_WORKER_CAPABILITY);
      }
      return Response.json({ object: "list", data: [] });
    });
    await doctorCloudflare(
      {
        endpoint: "https://hayasend-proof.example.workers.dev",
        deploymentId: "integration-1234",
      },
      {
        env: {
          HAYASEND_CLOUDFLARE_API_KEY: "re_cloudflare_integration_secret",
        },
        fetch: fetchMock,
        log: (message) => logs.push(message),
      },
    );
    expect(JSON.parse(logs[0]!)).toMatchObject({
      object: "cloudflare_doctor",
      healthy: true,
      authenticated_api: true,
      production_ready: false,
      provider_maturity: "beta",
    });
  });

  it("waits through transient Workers propagation responses", async () => {
    const logs: string[] = [];
    const attempts = new Map<string, number>();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      const propagationResponses = path === "/healthz" ? 31 : 1;
      if (attempt <= propagationResponses) {
        return new Response("error code: 1042", { status: 404 });
      }
      if (path === "/healthz") {
        return Response.json({
          runtime: "cloudflare-workers",
          production_ready: false,
          deployment_id: "integration-propagation",
        });
      }
      if (path === "/capabilities") {
        const { CLOUDFLARE_WORKER_CAPABILITY } =
          await import("../src/cloudflare-worker-capability.js");
        return Response.json(CLOUDFLARE_WORKER_CAPABILITY);
      }
      return Response.json({ object: "list", data: [] });
    });
    const sleep = vi.fn(async () => undefined);

    await doctorCloudflare(
      {
        endpoint: "https://hayasend-proof.example.workers.dev",
        deploymentId: "integration-propagation",
      },
      {
        env: {
          HAYASEND_CLOUDFLARE_API_KEY: "re_cloudflare_integration_secret",
        },
        fetch: fetchMock,
        sleep,
        log: (message) => logs.push(message),
      },
    );

    expect(sleep).toHaveBeenCalledTimes(33);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      object: "cloudflare_doctor",
      healthy: true,
      authenticated_api: true,
    });
  });
});
