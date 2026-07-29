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
const PROJECT_ID = "prj_1234567890abcdef";
const PROJECT_NAME = "hayasend-vercel-1234-1";
const STORE_NAME = `${PROJECT_NAME}-attachments`;
const STORE_ID = "store_1234567890abcdef";
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

type State = {
  exists: boolean;
  connected: boolean;
  createBodies: unknown[];
  connectionBodies: unknown[];
  deletedConnections: number;
  deletedStores: number;
};

function store() {
  return {
    id: STORE_ID,
    name: STORE_NAME,
    region: "hnd1",
    access: "private",
    type: "blob",
    billingState: "active",
    count: 0,
    size: 0,
  };
}

function createApi(state: State) {
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const url = new URL(request.url ?? "/", "http://localhost");
    expect(url.searchParams.get("teamId")).toBe(TEAM_ID);
    response.setHeader("content-type", "application/json");

    if (
      request.method === "GET" &&
      url.pathname === `/v9/projects/${PROJECT_ID}`
    ) {
      response.end(
        JSON.stringify({
          id: PROJECT_ID,
          name: PROJECT_NAME,
          accountId: TEAM_ID,
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/v1/storage/stores"
    ) {
      response.end(
        JSON.stringify({
          stores: state.exists ? [store()] : [],
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/storage/stores/blob"
    ) {
      state.createBodies.push(await requestJson(request));
      state.exists = true;
      response.end(JSON.stringify({ store: store() }));
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/v1/storage/stores/${STORE_ID}`
    ) {
      if (!state.exists) {
        response.writeHead(404).end("{}");
      } else {
        response.end(JSON.stringify({ store: store() }));
      }
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname ===
        `/v1/storage/stores/${STORE_ID}/connections`
    ) {
      response.end(
        JSON.stringify({
          connections: state.connected
            ? [
                {
                  id: "spc_1234567890abcdef",
                  projectId: PROJECT_ID,
                  envVarEnvironments: ["production"],
                },
              ]
            : [],
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname ===
        `/v1/storage/stores/${STORE_ID}/connections`
    ) {
      state.connectionBodies.push(await requestJson(request));
      state.connected = true;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (
      request.method === "DELETE" &&
      url.pathname ===
        `/v1/storage/stores/${STORE_ID}/connections`
    ) {
      state.deletedConnections += 1;
      state.connected = false;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (
      request.method === "DELETE" &&
      url.pathname === `/v1/storage/stores/blob/${STORE_ID}`
    ) {
      state.deletedStores += 1;
      state.exists = false;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404).end("{}");
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
    [resolve(`deploy/vercel/blob-store-${action}.mjs`)],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        VERCEL_API_ORIGIN: origin,
        VERCEL_TOKEN: TOKEN,
        HAYASEND_VERCEL_ORG_ID: TEAM_ID,
        HAYASEND_VERCEL_PROJECT_NAME: PROJECT_NAME,
        HAYASEND_VERCEL_PROJECT_ID_FILE: resolve(
          directory,
          "project-id",
        ),
        HAYASEND_VERCEL_BLOB_STORE_NAME: STORE_NAME,
        HAYASEND_VERCEL_BLOB_STORE_ID_FILE: resolve(
          directory,
          "store-id",
        ),
        HAYASEND_VERCEL_BLOB_TOKEN_FILE: resolve(
          directory,
          "blob-token",
        ),
        HAYASEND_VERCEL_BLOB_EVIDENCE_FILE: resolve(
          directory,
          `${action}-blob-evidence.json`,
        ),
        HAYASEND_VERCEL_BLOB_DELETE_CONFIRMATION:
          action === "delete" ? STORE_NAME : undefined,
        HAYASEND_VERCEL_BLOB_EMPTY:
          action === "delete" ? "true" : undefined,
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

describe("Vercel private Blob store lifecycle", () => {
  it("creates, verifies, and removes one production-only private hnd1 store", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-vercel-blob-test-"),
    );
    await writeFile(
      resolve(directory, "project-id"),
      `${PROJECT_ID}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      resolve(directory, "blob-token"),
      "vercel_blob_rw_test-token\n",
      { mode: 0o600 },
    );
    const state: State = {
      exists: false,
      connected: false,
      createBodies: [],
      connectionBodies: [],
      deletedConnections: 0,
      deletedStores: 0,
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
        name: STORE_NAME,
        region: "hnd1",
        access: "private",
      },
    ]);
    expect(state.connectionBodies).toEqual([
      {
        envVarEnvironments: ["production"],
        projectId: PROJECT_ID,
        type: "integration",
      },
    ]);
    expect(
      await readFile(resolve(directory, "store-id"), "utf8"),
    ).toBe(`${STORE_ID}\n`);
    expect((await stat(resolve(directory, "store-id"))).mode & 0o777).toBe(
      0o600,
    );
    expect(created.stdout).not.toContain(PROJECT_ID);
    expect(created.stdout).not.toContain(STORE_ID);
    expect(JSON.parse(created.stdout)).toMatchObject({
      object: "vercel_private_blob_store",
      action: "created",
      store_name: STORE_NAME,
      access: "private",
      region: "hnd1",
      production_only_connection: true,
    });

    const verified = await run("verify", origin, directory);
    expect(verified).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(verified.stdout)).toMatchObject({
      object: "vercel_private_blob_store",
      action: "verified",
    });

    const deleted = await run("delete", origin, directory);
    expect(deleted).toMatchObject({ code: 0, stderr: "" });
    expect(state.deletedConnections).toBe(1);
    expect(state.deletedStores).toBe(1);
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      object: "vercel_private_blob_store",
      action: "deleted",
      objects_before_delete: 0,
      bytes_before_delete: 0,
      deleted: true,
    });
    for (const filename of ["store-id", "blob-token"]) {
      await expect(
        readFile(resolve(directory, filename), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("extracts one production token without printing it and deletes the source file", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-vercel-env-test-"),
    );
    const source = resolve(directory, "production.env");
    const tokenFile = resolve(directory, "blob-token");
    const blobToken =
      "vercel_blob_rw_123456789012345678901234567890";
    await writeFile(
      source,
      `# generated\nBLOB_READ_WRITE_TOKEN=${JSON.stringify(blobToken)}\n`,
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      [
        resolve(
          "deploy/vercel/extract-production-blob-token.mjs",
        ),
        source,
        tokenFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const [code] = (await once(child, "exit")) as [number];
    const output = Buffer.concat(stdout).toString("utf8");

    expect(code).toBe(0);
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    expect(output).not.toContain(blobToken);
    expect(JSON.parse(output)).toMatchObject({
      object: "vercel_blob_token_extraction",
      source_deleted: true,
      token_file_mode: "0600",
    });
    expect(await readFile(tokenFile, "utf8")).toBe(`${blobToken}\n`);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    await expect(readFile(source, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("converges when the remote Blob store is already absent but local records remain", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "hayasend-vercel-blob-test-"),
    );
    await writeFile(
      resolve(directory, "project-id"),
      `${PROJECT_ID}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      resolve(directory, "store-id"),
      `${STORE_ID}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      resolve(directory, "blob-token"),
      "vercel_blob_rw_test-token\n",
      { mode: 0o600 },
    );
    const state: State = {
      exists: false,
      connected: false,
      createBodies: [],
      connectionBodies: [],
      deletedConnections: 0,
      deletedStores: 0,
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
      object: "vercel_private_blob_store",
      action: "absent",
      store_name: STORE_NAME,
      deleted: true,
      id_inventory_absent: true,
      name_inventory_absent: true,
    });
    expect(state.deletedConnections).toBe(0);
    expect(state.deletedStores).toBe(0);
    for (const filename of ["store-id", "blob-token"]) {
      await expect(
        readFile(resolve(directory, filename), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
