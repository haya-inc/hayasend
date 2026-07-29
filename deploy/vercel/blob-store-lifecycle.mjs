import { createHash } from "node:crypto";

const PRODUCTION_API_ORIGIN = "https://api.vercel.com";
const PRODUCTION_POLL_INTERVAL_MS = 2_000;
const PRODUCTION_MAX_WAIT_MS = 120_000;
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
    storeName: required("HAYASEND_VERCEL_BLOB_STORE_NAME"),
  };
  if (!/^team_[A-Za-z0-9]{8,64}$/.test(result.organizationId)) {
    throw new Error("HAYASEND_VERCEL_ORG_ID has an invalid format.");
  }
  if (!/^hayasend-vercel-[a-z0-9][a-z0-9-]{0,62}$/.test(result.projectName)) {
    throw new Error("HAYASEND_VERCEL_PROJECT_NAME is invalid.");
  }
  if (result.storeName !== `${result.projectName}-attachments`) {
    throw new Error(
      "HAYASEND_VERCEL_BLOB_STORE_NAME must be the exact project-scoped attachment store name.",
    );
  }
  if (
    result.token.length < 24 ||
    result.token.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(result.token)
  ) {
    throw new Error("VERCEL_TOKEN must contain 24 to 4096 characters.");
  }
  return result;
}

function runtime(options = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? PRODUCTION_POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? PRODUCTION_MAX_WAIT_MS;
  const writeEvidence =
    options.writeEvidence ?? ((serialized) => process.stdout.write(serialized));
  if (typeof fetchImplementation !== "function") {
    throw new Error("A Fetch-compatible implementation is required.");
  }
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > PRODUCTION_POLL_INTERVAL_MS
  ) {
    throw new Error("The Vercel Blob poll interval is invalid.");
  }
  if (
    !Number.isInteger(maxWaitMs) ||
    maxWaitMs < 100 ||
    maxWaitMs > PRODUCTION_MAX_WAIT_MS
  ) {
    throw new Error("The Vercel Blob maximum wait is invalid.");
  }
  if (typeof writeEvidence !== "function") {
    throw new Error("A Vercel Blob evidence writer is required.");
  }
  return {
    fetch: fetchImplementation,
    maxWaitMs,
    pollIntervalMs,
    writeEvidence,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function apiUrl(pathname, organizationId) {
  const url = new URL(pathname, PRODUCTION_API_ORIGIN);
  url.searchParams.set("teamId", organizationId);
  return url;
}

async function request(
  config,
  execution,
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
      response = await execution.fetch(
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
      await sleep(execution.pollIntervalMs * attempt);
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
      await sleep(execution.pollIntervalMs * attempt);
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

async function project(config, execution) {
  const value = await request(
    config,
    execution,
    "GET",
    `/v9/projects/${encodeURIComponent(config.projectName)}`,
  );
  if (
    !/^prj_[A-Za-z0-9]{8,64}$/.test(value?.id ?? "") ||
    value?.name !== config.projectName ||
    value?.accountId !== config.organizationId
  ) {
    throw new Error("The exact Vercel proof project failed verification.");
  }
  return value;
}

async function stores(config, execution) {
  const response = await request(
    config,
    execution,
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
    (store.billingState !== undefined && store.billingState !== "active")
  ) {
    throw new Error(
      "The Vercel Blob store does not match the exact private hnd1 proof store.",
    );
  }
}

async function storeById(config, execution, id, allowNotFound = false) {
  const response = await request(
    config,
    execution,
    "GET",
    `/v1/storage/stores/${encodeURIComponent(id)}`,
    { allowNotFound },
  );
  return response?.store;
}

async function connections(config, execution, id) {
  const response = await request(
    config,
    execution,
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

async function evidence(execution, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  await execution.writeEvidence(serialized);
}

async function createStore(config, execution) {
  const exactProject = await project(config, execution);
  if ((await stores(config, execution)).length !== 0) {
    throw new Error("The exact Vercel Blob proof store already exists.");
  }

  let created;
  try {
    created = await request(
      config,
      execution,
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
    const resolved = await stores(config, execution);
    if (resolved.length === 1 && resolved[0]?.id) {
      assertStore(config, resolved[0]);
    }
    throw error;
  }
  const store = created?.store;
  assertStore(config, store);

  await request(
    config,
    execution,
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
    storeById(config, execution, store.id),
    connections(config, execution, store.id),
  ]);
  assertStore(config, inspected, store.id);
  assertConnection(connectionList, exactProject.id);
  await evidence(execution, {
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

async function verifyStore(config, execution) {
  const exactProject = await project(config, execution);
  const named = await stores(config, execution);
  if (named.length !== 1) {
    throw new Error("The exact Vercel Blob store name is not unique.");
  }
  const storeId = named[0].id;
  const [inspected, connectionList] = await Promise.all([
    storeById(config, execution, storeId),
    connections(config, execution, storeId),
  ]);
  assertStore(config, inspected, storeId);
  assertConnection(connectionList, exactProject.id);
  await evidence(execution, {
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

async function assertEmptyStore(config, execution) {
  const exactProject = await project(config, execution);
  const named = await stores(config, execution);
  if (named.length === 0) {
    await evidence(execution, {
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
    !/^store_[A-Za-z0-9]{16}$/.test(named[0]?.id ?? "")
  ) {
    throw new Error("The exact Vercel Blob store is not unique.");
  }
  const storeId = named[0].id;
  const inspected = await storeById(config, execution, storeId, true);
  assertStore(config, inspected, storeId);
  if (inspected.count !== 0 || inspected.size !== 0) {
    throw new Error(
      "The exact Vercel Blob store API does not report zero objects and bytes.",
    );
  }
  await evidence(execution, {
    object: "vercel_private_blob_store",
    action: "empty_verified",
    project_id_sha256: hash(exactProject.id),
    store_id_sha256: hash(storeId),
    store_name: config.storeName,
    objects: 0,
    bytes: 0,
    empty: true,
  });
}

async function deleteStore(config, execution) {
  if (
    process.env.HAYASEND_VERCEL_BLOB_DELETE_CONFIRMATION !== config.storeName
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
  const exactProject = await project(config, execution);
  const named = await stores(config, execution);
  if (named.length > 1) {
    throw new Error("The exact Vercel Blob store name is ambiguous.");
  }
  const storeId = named[0]?.id;
  if (!storeId) {
    await evidence(execution, {
      object: "vercel_private_blob_store",
      action: "absent",
      project_id_sha256: hash(exactProject.id),
      store_name: config.storeName,
      deleted: true,
    });
    return;
  }
  const store = await storeById(config, execution, storeId, true);
  const connectionList = await connections(config, execution, storeId);
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
      execution,
      "DELETE",
      `/v1/storage/stores/${encodeURIComponent(storeId)}/connections`,
    );
  }
  await request(
    config,
    execution,
    "DELETE",
    `/v1/storage/stores/blob/${encodeURIComponent(storeId)}`,
  );

  const deadline = Date.now() + execution.maxWaitMs;
  while (Date.now() < deadline) {
    const [remainingId, remainingNames] = await Promise.all([
      storeById(config, execution, storeId, true),
      stores(config, execution),
    ]);
    if (!remainingId && remainingNames.length === 0) {
      await evidence(execution, {
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
    await sleep(execution.pollIntervalMs);
  }
  throw new Error(
    "The exact Vercel Blob store remains visible after deletion.",
  );
}

export async function runBlobStoreLifecycle(action, options) {
  const config = inputs();
  const execution = runtime(options);
  if (action === "create") {
    await createStore(config, execution);
  } else if (action === "verify") {
    await verifyStore(config, execution);
  } else if (action === "assert-empty") {
    await assertEmptyStore(config, execution);
  } else if (action === "delete") {
    await deleteStore(config, execution);
  } else {
    throw new Error(
      "Expected Vercel Blob action: create, verify, assert-empty, or delete.",
    );
  }
}
