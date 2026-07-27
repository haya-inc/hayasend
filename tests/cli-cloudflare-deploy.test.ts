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

  it("creates, migrates, uploads, and deploys with secrets only in protected inputs", async () => {
    const logs: string[] = [];
    const calls: Array<{
      command: string;
      args: string[];
      options: CommandOptions;
    }> = [];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      const outputPath = options.env?.WRANGLER_OUTPUT_FILE_PATH;
      if (args.includes("upload") && outputPath) {
        await writeFile(
          outputPath,
          `${JSON.stringify({
            type: "version-upload",
            worker_name: "hayasend-proof",
            version_id: VERSION_ID,
            preview_url:
              "https://version-hayasend-proof.example.workers.dev",
          })}\n`,
        );
      }
      if (args.includes("deploy") && outputPath) {
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
    expect(commands.some((command) =>
      command.startsWith("versions upload "),
    )).toBe(true);
    expect(commands).toContain("versions deploy --name");
    expect(calls.every(({ options }) =>
      options.env?.CLOUDFLARE_ACCOUNT_ID === ACCOUNT
    )).toBe(true);
    expect(calls.every(({ options }) =>
      options.env?.HAYASEND_CLOUDFLARE_API_KEY === undefined
    )).toBe(true);
    const upload = calls.find(({ args }) => args.includes("upload"));
    const secretPath =
      upload?.args[upload.args.indexOf("--secrets-file") + 1];
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
      cloudflare_deployment_id: "cloudflare-deployment-id",
      production_ready: false,
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
      "delete",
      "hayasend-proof",
      "--force",
    ]);
    expect(operations[1]?.slice(0, 3)).toEqual([
      "d1",
      "execute",
      "hayasend-proof-d1",
    ]);
    expect(operations[2]).toEqual([
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
