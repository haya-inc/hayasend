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

const PROJECT_ID = "test-project-123";
const PROJECT_NAME = "hayasend-general-purpose-test";
const ORGANIZATION_ID = "org-hayasend-test-123";
const REGION_ID = "aws-ap-southeast-1";
const PARENT_ID = "br-parent-test-123";
const BRANCH_ID = "br-proof-test-456";
const ENDPOINT_ID = "ep-proof-test-789";
const OPERATION_ID = "11111111-2222-4333-8444-555555555555";
const BRANCH_NAME = "hayasend-vercel-1234-1";
const DATABASE_URI =
  "postgresql://hayasend:secret-password@" +
  "ep-hayasend-pooler.ap-southeast-1.aws.neon.tech/" +
  "hayasend?sslmode=require&channel_binding=require";

const requestJson = async (
  request: IncomingMessage,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(request, "end");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

type ServerState = {
  branchExists: boolean;
  createBodies: unknown[];
  hardDeletes: number;
  includeDeletedReads: number;
};

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

function branch() {
  return {
    id: BRANCH_ID,
    project_id: PROJECT_ID,
    parent_id: PARENT_ID,
    name: BRANCH_NAME,
    current_state: "ready",
    default: false,
    protected: false,
  };
}

function createApi(state: ServerState) {
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe(
      "Bearer neon_test_api_key_12345678901234567890",
    );
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");

    if (
      request.method === "GET" &&
      url.pathname === `/api/v2/projects/${PROJECT_ID}`
    ) {
      response.end(
        JSON.stringify({
          project: {
            id: PROJECT_ID,
            name: PROJECT_NAME,
            org_id: ORGANIZATION_ID,
            region_id: REGION_ID,
            pg_version: 18,
            store_passwords: true,
          },
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname ===
        `/api/v2/projects/${PROJECT_ID}/branches/${PARENT_ID}`
    ) {
      response.end(
        JSON.stringify({
          branch: {
            id: PARENT_ID,
            project_id: PROJECT_ID,
            name: "main",
            current_state: "ready",
            default: true,
            protected: true,
          },
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/api/v2/projects/${PROJECT_ID}/branches`
    ) {
      expect(url.searchParams.get("search")).toBe(BRANCH_NAME);
      if (url.searchParams.get("include_deleted") === "true") {
        state.includeDeletedReads += 1;
      }
      response.end(
        JSON.stringify({
          branches: state.branchExists ? [branch()] : [],
          pagination: {},
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === `/api/v2/projects/${PROJECT_ID}/branches`
    ) {
      state.createBodies.push(await requestJson(request));
      state.branchExists = true;
      response.writeHead(201);
      response.end(
        JSON.stringify({
          branch: branch(),
          endpoints: [
            {
              id: ENDPOINT_ID,
              project_id: PROJECT_ID,
              branch_id: BRANCH_ID,
              type: "read_write",
            },
          ],
          operations: [{ id: OPERATION_ID }],
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname ===
        `/api/v2/projects/${PROJECT_ID}/operations/${OPERATION_ID}`
    ) {
      response.end(
        JSON.stringify({
          operation: {
            id: OPERATION_ID,
            project_id: PROJECT_ID,
            status: "finished",
          },
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname ===
        `/api/v2/projects/${PROJECT_ID}/branches/${BRANCH_ID}`
    ) {
      if (!state.branchExists) {
        response.writeHead(404).end(
          JSON.stringify({ error: "not found" }),
        );
      } else {
        response.end(JSON.stringify({ branch: branch() }));
      }
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname ===
        `/api/v2/projects/${PROJECT_ID}/endpoints/${ENDPOINT_ID}`
    ) {
      response.end(
        JSON.stringify({
          endpoint: {
            id: ENDPOINT_ID,
            project_id: PROJECT_ID,
            branch_id: BRANCH_ID,
            type: "read_write",
            region_id: REGION_ID,
            current_state: "active",
            disabled: false,
            passwordless_access: false,
          },
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname ===
        `/api/v2/projects/${PROJECT_ID}/connection_uri`
    ) {
      expect(url.searchParams.get("branch_id")).toBe(BRANCH_ID);
      expect(url.searchParams.get("endpoint_id")).toBe(ENDPOINT_ID);
      expect(url.searchParams.get("database_name")).toBe("hayasend");
      expect(url.searchParams.get("role_name")).toBe("hayasend");
      expect(url.searchParams.get("pooled")).toBe("true");
      response.end(JSON.stringify({ uri: DATABASE_URI }));
      return;
    }
    if (
      request.method === "DELETE" &&
      url.pathname ===
        `/api/v2/projects/${PROJECT_ID}/branches/${BRANCH_ID}`
    ) {
      expect(url.searchParams.get("hard_delete")).toBe("true");
      state.hardDeletes += 1;
      state.branchExists = false;
      response.end(
        JSON.stringify({
          branch: branch(),
          operations: [{ id: OPERATION_ID }],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not found" }));
  });
  servers.push(server);
  return server;
}

async function run(
  script: "create" | "verify" | "delete",
  origin: string,
  directory: string,
) {
  const child = spawn(
    process.execPath,
    [
      resolve(
        `deploy/vercel/neon-branch-${script}.mjs`,
      ),
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        NEON_API_ORIGIN: origin,
        NEON_API_KEY:
          "neon_test_api_key_12345678901234567890",
        NEON_PROJECT_ID: PROJECT_ID,
        NEON_TEST_PROJECT_NAME: PROJECT_NAME,
        NEON_TEST_ORG_ID: ORGANIZATION_ID,
        NEON_TEST_REGION_ID: REGION_ID,
        NEON_PARENT_BRANCH_ID: PARENT_ID,
        NEON_PARENT_BRANCH_NAME: "main",
        NEON_BRANCH_NAME: BRANCH_NAME,
        NEON_DATABASE_NAME: "hayasend",
        NEON_ROLE_NAME: "hayasend",
        NEON_BRANCH_ID_FILE: resolve(directory, "branch-id"),
        NEON_DATABASE_URL_FILE: resolve(
          directory,
          "database-url",
        ),
        NEON_EVIDENCE_FILE: resolve(
          directory,
          `${script}-evidence.json`,
        ),
        NEON_ALLOW_HARD_DELETE:
          script === "delete" ? BRANCH_NAME : undefined,
        NEON_POLL_INTERVAL_MS: "1",
        NEON_MAX_WAIT_MS: "500",
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

describe("Vercel Neon ephemeral branch lifecycle", () => {
  it("creates, verifies, and hard-deletes one exact PostgreSQL 18 branch", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-neon-test-"),
    );
    const state: ServerState = {
      branchExists: false,
      createBodies: [],
      hardDeletes: 0,
      includeDeletedReads: 0,
    };
    const server = createApi(state);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local test server address.");
    }
    const origin = `http://127.0.0.1:${address.port}`;

    const created = await run("create", origin, directory);
    expect(created).toMatchObject({ code: 0, stderr: "" });
    expect(state.createBodies).toEqual([
      {
        branch: {
          name: BRANCH_NAME,
          parent_id: PARENT_ID,
          protected: false,
        },
        endpoints: [
          {
            type: "read_write",
            autoscaling_limit_min_cu: 0.25,
            autoscaling_limit_max_cu: 1,
            suspend_timeout_seconds: 300,
          },
        ],
      },
    ]);
    expect(await readFile(resolve(directory, "branch-id"), "utf8")).toBe(
      `${BRANCH_ID}\n`,
    );
    expect(
      await readFile(resolve(directory, "database-url"), "utf8"),
    ).toBe(`${DATABASE_URI}\n`);
    expect((await stat(resolve(directory, "database-url"))).mode & 0o777).toBe(
      0o600,
    );
    expect(created.stdout).not.toContain(DATABASE_URI);
    expect(created.stdout).not.toContain(PROJECT_ID);
    expect(created.stdout).not.toContain(BRANCH_ID);
    expect(JSON.parse(created.stdout)).toMatchObject({
      object: "neon_ephemeral_branch",
      action: "created",
      branch_name: BRANCH_NAME,
      pg_version: 18,
      region_id: REGION_ID,
      pooled_tls_uri_verified: true,
      parent_protected: true,
    });

    const verified = await run("verify", origin, directory);
    expect(verified).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(verified.stdout)).toMatchObject({
      object: "neon_ephemeral_branch",
      action: "verified",
      branch_name: BRANCH_NAME,
    });

    const deleted = await run("delete", origin, directory);
    expect(deleted).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      object: "neon_ephemeral_branch",
      action: "deleted",
      branch_name: BRANCH_NAME,
      hard_deleted: true,
      include_deleted_inventory_absent: true,
    });
    expect(state.hardDeletes).toBe(1);
    expect(state.includeDeletedReads).toBeGreaterThanOrEqual(3);
    await expect(
      readFile(resolve(directory, "branch-id"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(resolve(directory, "database-url"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed before mutation when the parent branch is not protected", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-neon-test-"),
    );
    const state: ServerState = {
      branchExists: false,
      createBodies: [],
      hardDeletes: 0,
      includeDeletedReads: 0,
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("content-type", "application/json");
      if (url.pathname === `/api/v2/projects/${PROJECT_ID}`) {
        response.end(
          JSON.stringify({
            project: {
              id: PROJECT_ID,
              name: PROJECT_NAME,
              org_id: ORGANIZATION_ID,
              region_id: REGION_ID,
              pg_version: 18,
              store_passwords: true,
            },
          }),
        );
      } else if (
        url.pathname ===
        `/api/v2/projects/${PROJECT_ID}/branches/${PARENT_ID}`
      ) {
        response.end(
          JSON.stringify({
            branch: {
              id: PARENT_ID,
              project_id: PROJECT_ID,
              name: "main",
              current_state: "ready",
              default: true,
              protected: false,
            },
          }),
        );
      } else {
        state.createBodies.push("unexpected");
        response.writeHead(500).end("{}");
      }
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local test server address.");
    }

    const result = await run(
      "create",
      `http://127.0.0.1:${address.port}`,
      directory,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "not the exact protected, ready default branch",
    );
    expect(state.createBodies).toEqual([]);
  });

  it("converges when the remote branch is already absent but private files remain", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-neon-test-"),
    );
    await writeFile(
      resolve(directory, "branch-id"),
      `${BRANCH_ID}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      resolve(directory, "database-url"),
      `${DATABASE_URI}\n`,
      { mode: 0o600 },
    );
    const state: ServerState = {
      branchExists: false,
      createBodies: [],
      hardDeletes: 0,
      includeDeletedReads: 0,
    };
    const server = createApi(state);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local test server address.");
    }

    const result = await run(
      "delete",
      `http://127.0.0.1:${address.port}`,
      directory,
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      object: "neon_ephemeral_branch",
      action: "absent",
      branch_name: BRANCH_NAME,
      hard_deleted: true,
      include_deleted_inventory_absent: true,
    });
    expect(state.hardDeletes).toBe(0);
    for (const filename of ["branch-id", "database-url"]) {
      await expect(
        readFile(resolve(directory, filename), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
