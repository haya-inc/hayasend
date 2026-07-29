import { createHash } from "node:crypto";
import {
  chmod,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PRODUCTION_API_ORIGIN = "https://api.vercel.com";
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function inputs() {
  const result = {
    token: required("VERCEL_TOKEN"),
    organizationId: required("HAYASEND_VERCEL_ORG_ID"),
    projectName: required("HAYASEND_VERCEL_PROJECT_NAME"),
    projectIdFile: required("HAYASEND_VERCEL_PROJECT_ID_FILE"),
    storeName: required("HAYASEND_VERCEL_BLOB_STORE_NAME"),
    storeIdFile: required("HAYASEND_VERCEL_BLOB_STORE_ID_FILE"),
    tokenFile: process.env.HAYASEND_VERCEL_BLOB_TOKEN_FILE,
    evidenceFile:
      process.env.HAYASEND_VERCEL_BLOB_EVIDENCE_FILE,
  };
  if (!/^team_[A-Za-z0-9]{8,64}$/.test(result.organizationId)) {
    throw new Error("HAYASEND_VERCEL_ORG_ID has an invalid format.");
  }
  if (
    !/^hayasend-vercel-[a-z0-9][a-z0-9-]{0,62}$/.test(
      result.projectName,
    )
  ) {
    throw new Error("HAYASEND_VERCEL_PROJECT_NAME is invalid.");
  }
  if (result.storeName !== `${result.projectName}-attachments`) {
    throw new Error(
      "HAYASEND_VERCEL_BLOB_STORE_NAME must be the exact project-scoped attachment store name.",
    );
  }
  if (result.token.length < 24 || result.token.length > 4_096) {
    throw new Error("VERCEL_TOKEN must contain 24 to 4096 characters.");
  }
  return result;
}

function apiOrigin() {
  const configured = process.env.VERCEL_API_ORIGIN;
  if (!configured) {
    return PRODUCTION_API_ORIGIN;
  }
  if (
    process.env.NODE_ENV !== "test" ||
    !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(configured)
  ) {
    throw new Error(
      "VERCEL_API_ORIGIN may only select loopback HTTP under NODE_ENV=test.",
    );
  }
  return configured;
}

function pollInterval() {
  if (process.env.NODE_ENV !== "test") {
    return 2_000;
  }
  const value = Number(process.env.VERCEL_POLL_INTERVAL_MS ?? 5);
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("VERCEL_POLL_INTERVAL_MS is invalid.");
  }
  return value;
}

function maxWait() {
  if (process.env.NODE_ENV !== "test") {
    return 120_000;
  }
  const value = Number(process.env.VERCEL_MAX_WAIT_MS ?? 5_000);
  if (!Number.isInteger(value) || value < 100 || value > 10_000) {
    throw new Error("VERCEL_MAX_WAIT_MS is invalid.");
  }
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function apiUrl(pathname, organizationId) {
  const url = new URL(pathname, apiOrigin());
  url.searchParams.set("teamId", organizationId);
  return url;
}

async function request(
  config,
  method,
  pathname,
  {
    body,
    allowNotFound = false,
    retrySafe = method === "GET" || method === "DELETE",
  } = {},
) {
  const attempts = retrySafe ? 4 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(
        apiUrl(pathname, config.organizationId),
        {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${config.token}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(
          `Vercel Blob ${method} request failed before receiving a response.`,
          { cause: error },
        );
      }
      await sleep(pollInterval() * attempt);
      continue;
    }
    if (allowNotFound && response.status === 404) {
      return undefined;
    }
    if (response.ok) {
      if (response.status === 204) {
        return undefined;
      }
      return response.json();
    }
    if (
      retrySafe &&
      RETRYABLE_STATUSES.has(response.status) &&
      attempt < attempts
    ) {
      await response.arrayBuffer();
      await sleep(pollInterval() * attempt);
      continue;
    }
    await response.arrayBuffer();
    const requestId =
      response.headers.get("x-vercel-id") ??
      response.headers.get("x-request-id") ??
      "unavailable";
    throw new Error(
      `Vercel Blob ${method} request returned HTTP ${response.status} (request ${requestId}).`,
    );
  }
  throw new Error("Vercel Blob request exhausted its retry policy.");
}

async function readId(path, type) {
  try {
    const value = (await readFile(path, "utf8")).trim();
    const pattern =
      type === "project"
        ? /^prj_[A-Za-z0-9]{8,64}$/
        : /^store_[A-Za-z0-9]{16}$/;
    if (!pattern.test(value)) {
      throw new Error(`The recorded Vercel ${type} ID is invalid.`);
    }
    return value;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

async function writePrivate(path, value) {
  await writeFile(path, value, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function project(config) {
  const projectId = await readId(config.projectIdFile, "project");
  if (!projectId) {
    throw new Error("The recorded Vercel project ID is absent.");
  }
  const value = await request(
    config,
    "GET",
    `/v9/projects/${encodeURIComponent(projectId)}`,
  );
  if (
    value?.id !== projectId ||
    value?.name !== config.projectName ||
    value?.accountId !== config.organizationId
  ) {
    throw new Error("The exact Vercel proof project failed verification.");
  }
  return value;
}

async function stores(config) {
  const response = await request(
    config,
    "GET",
    "/v1/storage/stores",
  );
  if (!Array.isArray(response?.stores)) {
    throw new Error("Vercel returned an invalid Blob store inventory.");
  }
  return response.stores.filter(
    (store) =>
      (!store?.type || store.type === "blob") &&
      store?.name === config.storeName,
  );
}

function assertStore(config, store, expectedId) {
  if (
    !store ||
    (expectedId !== undefined && store.id !== expectedId) ||
    !/^store_[A-Za-z0-9]{16}$/.test(store.id ?? "") ||
    store.name !== config.storeName ||
    store.region !== "hnd1" ||
    store.access !== "private" ||
    (store.type !== undefined && store.type !== "blob") ||
    (store.billingState !== undefined &&
      store.billingState !== "active")
  ) {
    throw new Error(
      "The Vercel Blob store does not match the exact private hnd1 proof store.",
    );
  }
}

async function storeById(config, id, allowNotFound = false) {
  const response = await request(
    config,
    "GET",
    `/v1/storage/stores/${encodeURIComponent(id)}`,
    { allowNotFound },
  );
  return response?.store;
}

async function connections(config, id) {
  const response = await request(
    config,
    "GET",
    `/v1/storage/stores/${encodeURIComponent(id)}/connections`,
  );
  if (!Array.isArray(response?.connections)) {
    throw new Error("Vercel returned an invalid Blob connection inventory.");
  }
  return response.connections;
}

function assertConnection(connectionList, projectId) {
  if (
    connectionList.length !== 1 ||
    connectionList[0]?.projectId !== projectId ||
    (connectionList[0]?.type !== undefined &&
      connectionList[0]?.type !== "integration") ||
    !Array.isArray(connectionList[0]?.envVarEnvironments) ||
    connectionList[0].envVarEnvironments.length !== 1 ||
    connectionList[0].envVarEnvironments[0] !== "production"
  ) {
    throw new Error(
      "The Vercel Blob store is not connected only to production in the exact proof project.",
    );
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function evidence(config, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (config.evidenceFile) {
    await writeFile(config.evidenceFile, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(config.evidenceFile, 0o600);
  }
  process.stdout.write(serialized);
}

async function createStore(config) {
  const exactProject = await project(config);
  if ((await stores(config)).length !== 0) {
    throw new Error("The exact Vercel Blob proof store already exists.");
  }

  let created;
  try {
    created = await request(
      config,
      "POST",
      "/v1/storage/stores/blob",
      {
        retrySafe: false,
        body: {
          name: config.storeName,
          region: "hnd1",
          access: "private",
        },
      },
    );
  } catch (error) {
    const resolved = await stores(config);
    if (resolved.length === 1 && resolved[0]?.id) {
      await writePrivate(
        config.storeIdFile,
        `${resolved[0].id}\n`,
      );
    }
    throw error;
  }
  const store = created?.store;
  assertStore(config, store);
  await writePrivate(config.storeIdFile, `${store.id}\n`);

  await request(
    config,
    "POST",
    `/v1/storage/stores/${encodeURIComponent(store.id)}/connections`,
    {
      retrySafe: false,
      body: {
        envVarEnvironments: ["production"],
        projectId: exactProject.id,
        type: "integration",
      },
    },
  );
  const [inspected, connectionList] = await Promise.all([
    storeById(config, store.id),
    connections(config, store.id),
  ]);
  assertStore(config, inspected, store.id);
  assertConnection(connectionList, exactProject.id);
  await evidence(config, {
    object: "vercel_private_blob_store",
    action: "created",
    project_id_sha256: hash(exactProject.id),
    store_id_sha256: hash(store.id),
    store_name: config.storeName,
    access: "private",
    region: "hnd1",
    production_only_connection: true,
  });
}

async function verifyStore(config) {
  const exactProject = await project(config);
  const storeId = await readId(config.storeIdFile, "store");
  if (!storeId) {
    throw new Error("The recorded Vercel Blob store ID is absent.");
  }
  const [named, inspected, connectionList] = await Promise.all([
    stores(config),
    storeById(config, storeId),
    connections(config, storeId),
  ]);
  if (named.length !== 1 || named[0]?.id !== storeId) {
    throw new Error("The exact Vercel Blob store name is not unique.");
  }
  assertStore(config, inspected, storeId);
  assertConnection(connectionList, exactProject.id);
  await evidence(config, {
    object: "vercel_private_blob_store",
    action: "verified",
    project_id_sha256: hash(exactProject.id),
    store_id_sha256: hash(storeId),
    store_name: config.storeName,
    access: "private",
    region: "hnd1",
    production_only_connection: true,
  });
}

async function assertEmptyStore(config) {
  const exactProject = await project(config);
  const recordedId = await readId(config.storeIdFile, "store");
  const named = await stores(config);
  const inspected = recordedId
    ? await storeById(config, recordedId, true)
    : undefined;
  if (!inspected && named.length === 0) {
    await evidence(config, {
      object: "vercel_private_blob_store",
      action: "empty_absent",
      project_id_sha256: hash(exactProject.id),
      store_name: config.storeName,
      objects: 0,
      bytes: 0,
      empty: true,
    });
    return;
  }
  if (
    named.length !== 1 ||
    !recordedId ||
    named[0]?.id !== recordedId
  ) {
    throw new Error("The exact Vercel Blob store is not unique.");
  }
  assertStore(config, inspected, recordedId);
  if (inspected.count !== 0 || inspected.size !== 0) {
    throw new Error(
      "The exact Vercel Blob store API does not report zero objects and bytes.",
    );
  }
  await evidence(config, {
    object: "vercel_private_blob_store",
    action: "empty_verified",
    project_id_sha256: hash(exactProject.id),
    store_id_sha256: hash(recordedId),
    store_name: config.storeName,
    objects: 0,
    bytes: 0,
    empty: true,
  });
}

async function removeIfPresent(path) {
  if (!path) {
    return;
  }
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function deleteStore(config) {
  if (
    process.env.HAYASEND_VERCEL_BLOB_DELETE_CONFIRMATION !==
    config.storeName
  ) {
    throw new Error(
      "HAYASEND_VERCEL_BLOB_DELETE_CONFIRMATION must equal the exact store name.",
    );
  }
  if (process.env.HAYASEND_VERCEL_BLOB_EMPTY !== "true") {
    throw new Error(
      "HAYASEND_VERCEL_BLOB_EMPTY=true is required after an independent object inventory.",
    );
  }
  const exactProject = await project(config);
  const recordedId = await readId(config.storeIdFile, "store");
  const named = await stores(config);
  if (named.length > 1) {
    throw new Error("The exact Vercel Blob store name is ambiguous.");
  }
  if (
    recordedId &&
    named.length === 1 &&
    named[0]?.id !== recordedId
  ) {
    throw new Error(
      "The recorded Vercel Blob store ID does not match its exact name.",
    );
  }
  const storeId = recordedId ?? named[0]?.id;
  if (!storeId) {
    await removeIfPresent(config.storeIdFile);
    await removeIfPresent(config.tokenFile);
    await evidence(config, {
      object: "vercel_private_blob_store",
      action: "absent",
      project_id_sha256: hash(exactProject.id),
      store_name: config.storeName,
      deleted: true,
    });
    return;
  }
  const store = await storeById(config, storeId, true);
  if (!store && named.length === 0) {
    await removeIfPresent(config.storeIdFile);
    await removeIfPresent(config.tokenFile);
    await evidence(config, {
      object: "vercel_private_blob_store",
      action: "absent",
      project_id_sha256: hash(exactProject.id),
      store_id_sha256: hash(storeId),
      store_name: config.storeName,
      deleted: true,
      id_inventory_absent: true,
      name_inventory_absent: true,
    });
    return;
  }
  const connectionList = await connections(config, storeId);
  assertStore(config, store, storeId);
  if (store.count !== 0 || store.size !== 0) {
    throw new Error(
      "The exact Vercel Blob store API does not report zero objects and bytes.",
    );
  }
  if (connectionList.length > 0) {
    assertConnection(connectionList, exactProject.id);
    await request(
      config,
      "DELETE",
      `/v1/storage/stores/${encodeURIComponent(storeId)}/connections`,
    );
  }
  await request(
    config,
    "DELETE",
    `/v1/storage/stores/blob/${encodeURIComponent(storeId)}`,
  );

  const deadline = Date.now() + maxWait();
  while (Date.now() < deadline) {
    const [remainingId, remainingNames] = await Promise.all([
      storeById(config, storeId, true),
      stores(config),
    ]);
    if (!remainingId && remainingNames.length === 0) {
      await removeIfPresent(config.storeIdFile);
      await removeIfPresent(config.tokenFile);
      await evidence(config, {
        object: "vercel_private_blob_store",
        action: "deleted",
        project_id_sha256: hash(exactProject.id),
        store_id_sha256: hash(storeId),
        store_name: config.storeName,
        objects_before_delete: 0,
        bytes_before_delete: 0,
        deleted: true,
        id_inventory_absent: true,
        name_inventory_absent: true,
      });
      return;
    }
    await sleep(pollInterval());
  }
  throw new Error(
    "The exact Vercel Blob store remains visible after deletion.",
  );
}

export async function runBlobStoreLifecycle(action) {
  const config = inputs();
  if (action === "create") {
    await createStore(config);
  } else if (action === "verify") {
    await verifyStore(config);
  } else if (action === "assert-empty") {
    await assertEmptyStore(config);
  } else if (action === "delete") {
    await deleteStore(config);
  } else {
    throw new Error(
      "Expected Vercel Blob action: create, verify, assert-empty, or delete.",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runBlobStoreLifecycle(process.argv[2]);
}
