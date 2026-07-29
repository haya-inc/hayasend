import { createHash } from "node:crypto";

const PRODUCTION_API_ORIGIN = "https://console.neon.tech";
const PRODUCTION_POLL_INTERVAL_MS = 2_000;
const PRODUCTION_MAX_WAIT_MS = 180_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const TERMINAL_OPERATION_FAILURES = new Set(["cancelled", "failed", "skipped"]);

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function assertMatch(name, value, pattern) {
  if (!pattern.test(value)) {
    throw new Error(`${name} has an invalid format.`);
  }
}

function inputs() {
  const result = {
    apiKey: required("NEON_API_KEY"),
    projectId: required("NEON_PROJECT_ID"),
    projectName: required("NEON_TEST_PROJECT_NAME"),
    organizationId: required("NEON_TEST_ORG_ID"),
    regionId: required("NEON_TEST_REGION_ID"),
    parentBranchId: required("NEON_PARENT_BRANCH_ID"),
    parentBranchName: required("NEON_PARENT_BRANCH_NAME"),
    branchName: required("NEON_BRANCH_NAME"),
    databaseName: required("NEON_DATABASE_NAME"),
    roleName: required("NEON_ROLE_NAME"),
  };

  assertMatch("NEON_PROJECT_ID", result.projectId, /^[a-z0-9][a-z0-9-]{0,59}$/);
  assertMatch(
    "NEON_TEST_ORG_ID",
    result.organizationId,
    /^org-[a-z0-9-]{1,56}$/,
  );
  assertMatch(
    "NEON_TEST_REGION_ID",
    result.regionId,
    /^(?:aws|azure|gcp)-[a-z0-9-]{2,48}$/,
  );
  assertMatch(
    "NEON_PARENT_BRANCH_ID",
    result.parentBranchId,
    /^br-[a-z0-9-]{1,56}$/,
  );
  assertMatch(
    "NEON_BRANCH_NAME",
    result.branchName,
    /^hayasend-vercel-[a-z0-9][a-z0-9-]{0,62}$/,
  );
  assertMatch(
    "NEON_DATABASE_NAME",
    result.databaseName,
    /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/,
  );
  assertMatch(
    "NEON_ROLE_NAME",
    result.roleName,
    /^[A-Za-z_][A-Za-z0-9_$.-]{0,62}$/,
  );
  if (result.projectName !== "hayasend-general-purpose-test") {
    throw new Error(
      "NEON_TEST_PROJECT_NAME must equal hayasend-general-purpose-test.",
    );
  }
  if (result.parentBranchName !== "main") {
    throw new Error("NEON_PARENT_BRANCH_NAME must equal main.");
  }
  if (
    result.apiKey.length < 32 ||
    result.apiKey.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(result.apiKey)
  ) {
    throw new Error("NEON_API_KEY must contain 32 to 4096 characters.");
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
    throw new Error("The Neon poll interval is invalid.");
  }
  if (
    !Number.isInteger(maxWaitMs) ||
    maxWaitMs < 100 ||
    maxWaitMs > PRODUCTION_MAX_WAIT_MS
  ) {
    throw new Error("The Neon maximum wait is invalid.");
  }
  if (typeof writeEvidence !== "function") {
    throw new Error("A Neon evidence writer is required.");
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

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function apiPath(pathname, query = {}) {
  const url = new URL(pathname, PRODUCTION_API_ORIGIN);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, String(value));
    }
  }
  return url;
}

async function apiRequest(
  configuration,
  execution,
  method,
  pathname,
  {
    body,
    query,
    retrySafe = method === "GET" || method === "DELETE",
    allowNotFound = false,
  } = {},
) {
  const attempts = retrySafe ? 4 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await execution.fetch(apiPath(pathname, query), {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${configuration.apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(
          `Neon ${method} request failed before a response was received.`,
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
      response.headers.get("neon-request-id") ??
      response.headers.get("x-request-id") ??
      "unavailable";
    throw new Error(
      `Neon ${method} request returned HTTP ${response.status} (request ${requestId}).`,
    );
  }
  throw new Error("Neon request exhausted its bounded retry policy.");
}

async function verifyProject(configuration, execution) {
  const result = await apiRequest(
    configuration,
    execution,
    "GET",
    `/api/v2/projects/${encodeURIComponent(configuration.projectId)}`,
  );
  const project = result?.project;
  if (
    project?.id !== configuration.projectId ||
    project?.name !== configuration.projectName ||
    project?.org_id !== configuration.organizationId ||
    project?.region_id !== configuration.regionId ||
    project?.pg_version !== 18 ||
    project?.store_passwords !== true
  ) {
    throw new Error(
      "The Neon project does not match the exact reusable PostgreSQL 18 test project.",
    );
  }

  const parentResult = await apiRequest(
    configuration,
    execution,
    "GET",
    `/api/v2/projects/${encodeURIComponent(configuration.projectId)}/branches/${encodeURIComponent(configuration.parentBranchId)}`,
  );
  const parent = parentResult?.branch;
  if (
    parent?.id !== configuration.parentBranchId ||
    parent?.project_id !== configuration.projectId ||
    parent?.name !== configuration.parentBranchName ||
    parent?.default !== true ||
    parent?.protected !== true ||
    parent?.current_state !== "ready"
  ) {
    throw new Error(
      "The Neon parent branch is not the exact protected, ready default branch.",
    );
  }

  return { parent, project };
}

async function listAllBranches(configuration, execution, includeDeleted) {
  const branches = [];
  const seenCursors = new Set();
  let cursor;
  let pages = 0;
  do {
    pages += 1;
    if (pages > 100) {
      throw new Error("Neon branch inventory exceeded 100 pages.");
    }
    const page = await apiRequest(
      configuration,
      execution,
      "GET",
      `/api/v2/projects/${encodeURIComponent(configuration.projectId)}/branches`,
      {
        query: {
          cursor,
          include_deleted: includeDeleted,
          limit: 100,
          search: configuration.branchName,
          sort_by: "name",
          sort_order: "asc",
        },
      },
    );
    if (!Array.isArray(page?.branches)) {
      throw new Error("Neon returned an invalid branch inventory.");
    }
    branches.push(...page.branches);
    cursor = page?.pagination?.next;
    if (cursor == null) {
      cursor = undefined;
    } else {
      if (
        typeof cursor !== "string" ||
        cursor.length < 1 ||
        cursor.length > 1_024 ||
        /[\u0000-\u001f\u007f]/.test(cursor) ||
        seenCursors.has(cursor)
      ) {
        throw new Error("Neon returned an invalid pagination cursor.");
      }
      seenCursors.add(cursor);
    }
  } while (cursor);
  return branches;
}

async function exactNamedBranches(
  configuration,
  execution,
  includeDeleted = true,
) {
  return (
    await listAllBranches(configuration, execution, includeDeleted)
  ).filter((branch) => branch?.name === configuration.branchName);
}

async function waitForOperations(configuration, execution, operationIds) {
  const deadline = Date.now() + execution.maxWaitMs;
  const pending = new Set(operationIds.filter(Boolean));
  for (const operationId of pending) {
    assertMatch(
      "Neon operation ID",
      operationId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  }
  while (pending.size > 0) {
    for (const operationId of pending) {
      const result = await apiRequest(
        configuration,
        execution,
        "GET",
        `/api/v2/projects/${encodeURIComponent(configuration.projectId)}/operations/${encodeURIComponent(operationId)}`,
      );
      const operation = result?.operation;
      if (
        operation?.id !== operationId ||
        operation?.project_id !== configuration.projectId
      ) {
        throw new Error("Neon returned an invalid operation.");
      }
      if (operation.status === "finished") {
        pending.delete(operationId);
      } else if (TERMINAL_OPERATION_FAILURES.has(operation.status)) {
        throw new Error("A Neon branch operation did not finish successfully.");
      }
    }
    if (pending.size === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Neon branch operations.");
    }
    await sleep(execution.pollIntervalMs);
  }
}

async function waitForBranchAndEndpoint(
  configuration,
  execution,
  branchId,
  endpointId,
) {
  const deadline = Date.now() + execution.maxWaitMs;
  while (Date.now() < deadline) {
    const [branchResult, endpointResult] = await Promise.all([
      apiRequest(
        configuration,
        execution,
        "GET",
        `/api/v2/projects/${encodeURIComponent(configuration.projectId)}/branches/${encodeURIComponent(branchId)}`,
      ),
      apiRequest(
        configuration,
        execution,
        "GET",
        `/api/v2/projects/${encodeURIComponent(configuration.projectId)}/endpoints/${encodeURIComponent(endpointId)}`,
      ),
    ]);
    const branch = branchResult?.branch;
    const endpoint = endpointResult?.endpoint;
    if (
      branch?.id !== branchId ||
      branch?.project_id !== configuration.projectId ||
      branch?.name !== configuration.branchName ||
      branch?.parent_id !== configuration.parentBranchId ||
      branch?.default !== false ||
      branch?.protected !== false ||
      endpoint?.id !== endpointId ||
      endpoint?.project_id !== configuration.projectId ||
      endpoint?.branch_id !== branchId ||
      endpoint?.type !== "read_write" ||
      endpoint?.region_id !== configuration.regionId ||
      endpoint?.passwordless_access !== false
    ) {
      throw new Error(
        "The Neon proof branch or endpoint does not match the requested isolated topology.",
      );
    }
    if (
      branch.current_state === "ready" &&
      ["active", "idle"].includes(endpoint.current_state) &&
      endpoint.disabled === false
    ) {
      return { branch, endpoint };
    }
    await sleep(execution.pollIntervalMs);
  }
  throw new Error("Timed out waiting for the Neon proof branch.");
}

function validateConnectionUri(configuration, uri) {
  if (
    typeof uri !== "string" ||
    uri.length < 32 ||
    uri.length > 8_192 ||
    uri !== uri.trim() ||
    /[\u0000-\u001f\u007f]/.test(uri)
  ) {
    throw new Error("Neon returned an invalid PostgreSQL connection URI.");
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("Neon returned an invalid PostgreSQL connection URI.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname.endsWith(".neon.tech") ||
    !parsed.hostname.includes("-pooler.") ||
    parsed.username !== configuration.roleName ||
    parsed.pathname !== `/${configuration.databaseName}` ||
    parsed.searchParams.get("sslmode") !== "require" ||
    !parsed.password
  ) {
    throw new Error(
      "The Neon connection URI is not the expected pooled TLS PostgreSQL credential.",
    );
  }
}

async function writeEvidence(execution, evidence) {
  const serialized = `${JSON.stringify(evidence)}\n`;
  await execution.writeEvidence(serialized);
}

async function createBranch(configuration, execution) {
  await verifyProject(configuration, execution);

  // include_deleted=true is intentionally required before mutation. Accounts
  // without hard-delete/branch-recovery support fail closed here.
  const before = await exactNamedBranches(configuration, execution, true);
  if (before.length !== 0) {
    throw new Error(
      "The exact Neon proof branch name already exists or is recoverable.",
    );
  }

  let created;
  try {
    created = await apiRequest(
      configuration,
      execution,
      "POST",
      `/api/v2/projects/${encodeURIComponent(configuration.projectId)}/branches`,
      {
        retrySafe: false,
        body: {
          branch: {
            name: configuration.branchName,
            parent_id: configuration.parentBranchId,
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
      },
    );
  } catch (error) {
    // Never retry an ambiguous create. Resolve the exact deterministic name so
    // the finally cleanup can still hard-delete a branch created server-side.
    const matches = await exactNamedBranches(configuration, execution, true);
    if (matches.length === 1) {
      assertMatch(
        "resolved Neon branch ID",
        matches[0].id,
        /^br-[a-z0-9-]{1,56}$/,
      );
    }
    throw error;
  }

  const branch = created?.branch;
  const endpoints = created?.endpoints;
  if (
    branch?.id === undefined ||
    branch?.project_id !== configuration.projectId ||
    branch?.name !== configuration.branchName ||
    branch?.parent_id !== configuration.parentBranchId ||
    branch?.default !== false ||
    branch?.protected !== false ||
    !Array.isArray(endpoints) ||
    endpoints.length !== 1 ||
    endpoints[0]?.type !== "read_write" ||
    endpoints[0]?.branch_id !== branch.id
  ) {
    throw new Error("Neon created an unexpected branch topology.");
  }
  assertMatch("created Neon branch ID", branch.id, /^br-[a-z0-9-]{1,56}$/);
  assertMatch(
    "created Neon endpoint ID",
    endpoints[0].id,
    /^ep-[a-z0-9-]{1,56}$/,
  );
  await waitForOperations(
    configuration,
    execution,
    (created.operations ?? []).map((operation) => operation?.id),
  );
  const ready = await waitForBranchAndEndpoint(
    configuration,
    execution,
    branch.id,
    endpoints[0].id,
  );

  const connection = await apiRequest(
    configuration,
    execution,
    "GET",
    `/api/v2/projects/${encodeURIComponent(configuration.projectId)}/connection_uri`,
    {
      query: {
        branch_id: branch.id,
        endpoint_id: endpoints[0].id,
        database_name: configuration.databaseName,
        role_name: configuration.roleName,
        pooled: true,
      },
    },
  );
  validateConnectionUri(configuration, connection?.uri);

  await writeEvidence(execution, {
    object: "neon_ephemeral_branch",
    action: "created",
    project_id_sha256: hash(configuration.projectId),
    branch_id_sha256: hash(branch.id),
    endpoint_id_sha256: hash(endpoints[0].id),
    project_name: configuration.projectName,
    branch_name: configuration.branchName,
    pg_version: 18,
    region_id: configuration.regionId,
    endpoint_type: ready.endpoint.type,
    pooled_tls_uri_verified: true,
    parent_protected: true,
  });
  return connection.uri;
}

async function verifyBranch(configuration, execution) {
  await verifyProject(configuration, execution);
  const matches = await exactNamedBranches(configuration, execution, false);
  if (matches.length !== 1) {
    throw new Error("The exact active Neon proof branch is not unique.");
  }
  const branch = matches[0];
  assertMatch("verified Neon branch ID", branch.id, /^br-[a-z0-9-]{1,56}$/);
  if (
    branch.project_id !== configuration.projectId ||
    branch.parent_id !== configuration.parentBranchId ||
    branch.default !== false ||
    branch.protected !== false ||
    branch.current_state !== "ready"
  ) {
    throw new Error("The Neon proof branch failed verification.");
  }
  await writeEvidence(execution, {
    object: "neon_ephemeral_branch",
    action: "verified",
    project_id_sha256: hash(configuration.projectId),
    branch_id_sha256: hash(branch.id),
    branch_name: configuration.branchName,
    pg_version: 18,
    region_id: configuration.regionId,
    pooled_tls_uri_verified: true,
  });
}

async function deleteBranch(configuration, execution) {
  if (process.env.NEON_ALLOW_HARD_DELETE !== configuration.branchName) {
    throw new Error(
      "NEON_ALLOW_HARD_DELETE must equal the exact disposable branch name.",
    );
  }
  await verifyProject(configuration, execution);
  const matches = await exactNamedBranches(configuration, execution, true);
  if (matches.length > 1) {
    throw new Error("The exact Neon proof branch name is ambiguous.");
  }
  const branch = matches[0];
  if (!branch) {
    await writeEvidence(execution, {
      object: "neon_ephemeral_branch",
      action: "absent",
      project_id_sha256: hash(configuration.projectId),
      branch_name: configuration.branchName,
      hard_deleted: true,
      include_deleted_inventory_absent: true,
    });
    return;
  }
  const branchId = branch.id;
  assertMatch("deletable Neon branch ID", branchId, /^br-[a-z0-9-]{1,56}$/);
  if (
    branch.project_id !== configuration.projectId ||
    branch.name !== configuration.branchName ||
    branch.parent_id !== configuration.parentBranchId ||
    branch.default !== false ||
    branch.protected !== false
  ) {
    throw new Error(
      "Refusing to delete a Neon branch outside the exact disposable topology.",
    );
  }

  const result = await apiRequest(
    configuration,
    execution,
    "DELETE",
    `/api/v2/projects/${encodeURIComponent(configuration.projectId)}/branches/${encodeURIComponent(branchId)}`,
    {
      query: { hard_delete: true },
    },
  );
  await waitForOperations(
    configuration,
    execution,
    (result?.operations ?? []).map((operation) => operation?.id),
  );

  const deadline = Date.now() + execution.maxWaitMs;
  while (Date.now() < deadline) {
    const remaining = await exactNamedBranches(configuration, execution, true);
    if (remaining.length === 0) {
      await writeEvidence(execution, {
        object: "neon_ephemeral_branch",
        action: "deleted",
        project_id_sha256: hash(configuration.projectId),
        branch_id_sha256: hash(branchId),
        branch_name: configuration.branchName,
        hard_deleted: true,
        include_deleted_inventory_absent: true,
      });
      return;
    }
    await sleep(execution.pollIntervalMs);
  }
  throw new Error(
    "The Neon branch remains present or recoverable after hard delete.",
  );
}

export async function runNeonBranch(action, options) {
  const configuration = inputs();
  const execution = runtime(options);
  if (action === "create") {
    return createBranch(configuration, execution);
  } else if (action === "verify") {
    await verifyBranch(configuration, execution);
  } else if (action === "delete") {
    await deleteBranch(configuration, execution);
  } else {
    throw new Error("Expected Neon branch action: create, verify, or delete.");
  }
}
