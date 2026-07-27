import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "../src/cli-aws-deploy.js";
import {
  buildCloudflareWranglerConfig,
  cleanupCloudflare,
  cloudflareResourceNames,
  deployCloudflare,
  doctorCloudflare,
  rollbackCloudflare,
} from "../src/cli-cloudflare-deploy.js";

const ACCOUNT = "a".repeat(32);
const DATABASE_ID = "11111111-2222-3333-4444-555555555555";
const VERSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function result(
  stdout = "",
  stderr = "",
  exitCode = 0,
): CommandResult {
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
    expect(() => cloudflareResourceNames("Production")).toThrow(
      "lowercase",
    );
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
            HAYASEND_CLOUDFLARE_API_KEY:
              "re_cloudflare_integration_secret",
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
          apply: true,
          confirmAccount: ACCOUNT,
        },
        {
          cwd: process.cwd(),
          env: {
            CLOUDFLARE_API_TOKEN: "private-token",
            HAYASEND_CLOUDFLARE_API_KEY:
              "re_cloudflare_integration_secret",
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
            targets: [
              "https://hayasend-proof.example.workers.dev",
            ],
          })}\n`,
        );
      }
      if (args.includes("list") && args.includes("--json")) {
        return result(
          JSON.stringify([
            { name: "hayasend-proof-d1", uuid: DATABASE_ID },
          ]),
        );
      }
      return result();
    };

    await deployCloudflare(
      {
        account: ACCOUNT,
        name: "proof",
        deploymentId: "integration-1234",
        allowedRecipients: ["recipient@example.net"],
        apply: true,
        confirmAccount: ACCOUNT,
      },
      {
        cwd: process.cwd(),
        env: {
          CLOUDFLARE_API_TOKEN: "private-token",
          HAYASEND_CLOUDFLARE_API_KEY:
            "re_cloudflare_integration_secret",
        },
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );

    const commands = calls.map(({ args }) => args.slice(2, 5).join(" "));
    expect(commands).toContain("d1 create hayasend-proof-d1");
    expect(commands).toContain("r2 bucket create");
    expect(calls.some(({ args }) => args[2] === "deploy")).toBe(true);
    expect(calls.some(({ args }) =>
      args.slice(2, 4).join(" ") === "versions upload"
    )).toBe(false);
    expect(calls.some(({ args }) =>
      args.slice(2, 4).join(" ") === "versions deploy"
    )).toBe(false);
    expect(calls.every(({ options }) =>
      options.env?.CLOUDFLARE_ACCOUNT_ID === ACCOUNT
    )).toBe(true);
    expect(calls.every(({ options }) =>
      options.env?.HAYASEND_CLOUDFLARE_API_KEY === undefined
    )).toBe(true);
    const deploy = calls.find(({ args }) => args[2] === "deploy");
    const secretPath =
      deploy?.args[deploy.args.indexOf("--secrets-file") + 1];
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
          HAYASEND_CLOUDFLARE_API_KEY:
            "re_cloudflare_integration_secret",
        },
        log: (message) => logs.push(message),
        runCommand: runner,
      },
    );

    expect(calls.some((args) =>
      args.slice(2, 4).join(" ") === "versions upload"
    )).toBe(true);
    expect(calls.some((args) =>
      args.slice(2, 4).join(" ") === "versions deploy"
    )).toBe(true);
    expect(calls.some((args) => args[2] === "d1" && args[3] === "create"))
      .toBe(false);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      object: "cloudflare_deployment_result",
      version_id: VERSION_ID,
      cloudflare_deployment_id: "cloudflare-deployment-id",
    });
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

  it("deletes the deterministic resource set and referenced payloads in order", async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const objectKey =
      `emails/email_${"a".repeat(32)}/11111111-2222-3333-4444-555555555555.json`;
    const runner: CommandRunner = async (_command, args) => {
      calls.push(args);
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
      "consumer",
      "remove",
      "hayasend-proof-email-events",
      "hayasend-proof",
    ]);
    expect(operations[1]).toEqual([
      "queues",
      "consumer",
      "remove",
      "hayasend-proof-jobs",
      "hayasend-proof",
    ]);
    expect(operations[2]).toEqual([
      "queues",
      "consumer",
      "remove",
      "hayasend-proof-jobs-dlq",
      "hayasend-proof",
    ]);
    expect(operations[3]).toEqual([
      "delete",
      "hayasend-proof",
    ]);
    expect(operations[4]?.slice(0, 3)).toEqual([
      "d1",
      "execute",
      "hayasend-proof-d1",
    ]);
    expect(operations[5]).toEqual([
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
      resource:
        "hayasend-proof-email-events consumer hayasend-proof",
      ok: true,
    });
    expect(cleanup.results[3]).toMatchObject({
      resource: "hayasend-proof",
      ok: true,
      diagnostic:
        "Resource was already absent (Cloudflare code 10090).",
    });
  });

  it("makes a partially completed cleanup fully idempotent", async () => {
    const logs: string[] = [];
    const runner: CommandRunner = async (_command, args) => {
      const operation = args.slice(2);
      if (
        operation[0] === "queues" &&
        operation[1] === "consumer"
      ) {
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
      if (
        operation[0] === "d1" &&
        operation[1] === "execute"
      ) {
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
      if (
        operation[0] === "queues" &&
        operation[1] === "delete"
      ) {
        return result(
          "",
          `Queue "${operation[2]}" does not exist. To create it, run: wrangler queues create ${operation[2]}`,
          1,
        );
      }
      if (
        operation[0] === "d1" &&
        operation[1] === "delete"
      ) {
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
          HAYASEND_CLOUDFLARE_API_KEY:
            "re_cloudflare_integration_secret",
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
});
