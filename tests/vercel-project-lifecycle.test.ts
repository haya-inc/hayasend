import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TEAM_ID = "team_1234567890abcdef";
const TEAM_SLUG = "haya-company";
const PROJECT_ID = "prj_1234567890abcdef";
const PROJECT_NAME = "hayasend-vercel-1234-1";
const TOKEN = "vercel_test_token_12345678901234567890";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        }),
    ),
  );
});

async function requestJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(request, "end");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function project() {
  return {
    id: PROJECT_ID,
    name: PROJECT_NAME,
    accountId: TEAM_ID,
    framework: "hono",
    previewDeploymentsDisabled: true,
    ssoProtection: null,
    gitRepository: null,
    resourceConfig: {
      fluid: true,
      functionDefaultRegions: ["hnd1"],
    },
  };
}

type State = {
  exists: boolean;
  createBodies: unknown[];
  deleteCount: number;
};

function createApi(state: State) {
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");

    if (
      request.method === "GET" &&
      url.pathname === `/v2/teams/${TEAM_ID}`
    ) {
      expect(url.searchParams.get("teamId")).toBeNull();
      response.end(
        JSON.stringify({
          id: TEAM_ID,
          slug: TEAM_SLUG,
          billing: { plan: "pro" },
          membership: {
            confirmed: true,
            role: "OWNER",
          },
        }),
      );
      return;
    }
    expect(url.searchParams.get("teamId")).toBe(TEAM_ID);
    if (
      request.method === "GET" &&
      (url.pathname === `/v9/projects/${PROJECT_ID}` ||
        url.pathname === `/v9/projects/${PROJECT_NAME}`)
    ) {
      if (!state.exists) {
        response.writeHead(404).end(
          JSON.stringify({ error: { code: "not_found" } }),
        );
      } else {
        response.end(JSON.stringify(project()));
      }
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v11/projects"
    ) {
      state.createBodies.push(await requestJson(request));
      state.exists = true;
      response.end(JSON.stringify(project()));
      return;
    }
    if (
      request.method === "DELETE" &&
      url.pathname === `/v9/projects/${PROJECT_ID}`
    ) {
      state.deleteCount += 1;
      state.exists = false;
      response.end(JSON.stringify({ id: PROJECT_ID }));
      return;
    }
    response.writeHead(404).end(
      JSON.stringify({ error: { code: "not_found" } }),
    );
  });
  servers.push(server);
  return server;
}

async function run(
  action: "create" | "verify" | "delete",
  origin: string,
  directory: string,
) {
  const child = spawn(
    process.execPath,
    [resolve(`deploy/vercel/project-${action}.mjs`)],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        VERCEL_API_ORIGIN: origin,
        VERCEL_TOKEN: TOKEN,
        HAYASEND_VERCEL_ORG_ID: TEAM_ID,
        HAYASEND_VERCEL_TEAM_SLUG: TEAM_SLUG,
        HAYASEND_VERCEL_TEAM_PLAN: "pro",
        HAYASEND_VERCEL_PROJECT_NAME: PROJECT_NAME,
        HAYASEND_VERCEL_PROJECT_ID_FILE: resolve(
          directory,
          "project-id",
        ),
        HAYASEND_VERCEL_PROJECT_EVIDENCE_FILE: resolve(
          directory,
          `${action}-evidence.json`,
        ),
        HAYASEND_VERCEL_DELETE_CONFIRMATION:
          action === "delete" ? PROJECT_NAME : undefined,
        VERCEL_POLL_INTERVAL_MS: "1",
        VERCEL_MAX_WAIT_MS: "500",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code] = (await once(child, "exit")) as [number];
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

describe("Vercel disposable project lifecycle", () => {
  it("creates, verifies, and removes one exact isolated Pro project", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-vercel-project-test-"),
    );
    const state: State = {
      exists: false,
      createBodies: [],
      deleteCount: 0,
    };
    const server = createApi(state);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local server address.");
    }
    const origin = `http://127.0.0.1:${address.port}`;

    const created = await run("create", origin, directory);
    expect(created).toMatchObject({ code: 0, stderr: "" });
    expect(state.createBodies).toEqual([
      {
        name: PROJECT_NAME,
        framework: "hono",
        previewDeploymentsDisabled: true,
        enablePreviewFeedback: false,
        enableProductionFeedback: false,
        ssoProtection: null,
        resourceConfig: {
          fluid: true,
          functionDefaultRegions: ["hnd1"],
        },
      },
    ]);
    expect(
      await readFile(resolve(directory, "project-id"), "utf8"),
    ).toBe(`${PROJECT_ID}\n`);
    expect((await stat(resolve(directory, "project-id"))).mode & 0o777).toBe(
      0o600,
    );
    expect(created.stdout).not.toContain(TEAM_ID);
    expect(created.stdout).not.toContain(PROJECT_ID);
    expect(JSON.parse(created.stdout)).toMatchObject({
      object: "vercel_disposable_project",
      action: "created",
      project_name: PROJECT_NAME,
      team_plan: "pro",
      region: "hnd1",
      fluid_compute: true,
      preview_deployments_disabled: true,
      production_api_public: true,
      git_repository_connected: false,
    });

    const verified = await run("verify", origin, directory);
    expect(verified).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(verified.stdout)).toMatchObject({
      object: "vercel_disposable_project",
      action: "verified",
      project_name: PROJECT_NAME,
    });

    const deleted = await run("delete", origin, directory);
    expect(deleted).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      object: "vercel_disposable_project",
      action: "deleted",
      project_name: PROJECT_NAME,
      deleted: true,
      id_inventory_absent: true,
      name_inventory_absent: true,
    });
    expect(state.deleteCount).toBe(1);
    await expect(
      readFile(resolve(directory, "project-id"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses creation outside an authenticated Pro team", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-vercel-project-test-"),
    );
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("content-type", "application/json");
      if (url.pathname === `/v2/teams/${TEAM_ID}`) {
        response.end(
          JSON.stringify({
            id: TEAM_ID,
            slug: TEAM_SLUG,
            billing: { plan: "hobby" },
            membership: { confirmed: true, role: "OWNER" },
          }),
        );
      } else {
        response.writeHead(500).end("{}");
      }
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local server address.");
    }

    const result = await run(
      "create",
      `http://127.0.0.1:${address.port}`,
      directory,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "not an authorized member of the exact Pro test team",
    );
  });

  it("converges when the remote project is already absent but its ID file remains", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-vercel-project-test-"),
    );
    await writeFile(
      resolve(directory, "project-id"),
      `${PROJECT_ID}\n`,
      { mode: 0o600 },
    );
    const state: State = {
      exists: false,
      createBodies: [],
      deleteCount: 0,
    };
    const server = createApi(state);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local server address.");
    }

    const result = await run(
      "delete",
      `http://127.0.0.1:${address.port}`,
      directory,
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      object: "vercel_disposable_project",
      action: "absent",
      project_name: PROJECT_NAME,
      deleted: true,
    });
    expect(state.deleteCount).toBe(0);
    await expect(
      readFile(resolve(directory, "project-id"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
