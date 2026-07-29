import { createHash } from "node:crypto";
import {
  chmod,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PRODUCTION_API_ORIGIN = "https://console.neon.tech";
const PRODUCTION_POLL_INTERVAL_MS = 2_000;
const PRODUCTION_MAX_WAIT_MS = 180_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const TERMINAL_OPERATION_FAILURES = new Set([
  "cancelled",
  "failed",
  "skipped",
]);

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
    branchIdFile: required("NEON_BRANCH_ID_FILE"),
    databaseUrlFile: required("NEON_DATABASE_URL_FILE"),
    evidenceFile: process.env.NEON_EVIDENCE_FILE,
  };

  assertMatch(
    "NEON_PROJECT_ID",
    result.projectId,
    /^[a-z0-9][a-z0-9-]{0,59}$/,
  );
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
  if (result.apiKey.length < 32 || result.apiKey.length > 4_096) {
    throw new Error("NEON_API_KEY must contain 32 to 4096 characters.");
  }

  return result;
}

function apiOrigin() {
  const configured = process.env.NEON_API_ORIGIN;
  if (!configured) {
    return PRODUCTION_API_ORIGIN;
  }
  if (
    process.env.NODE_ENV !== "test" ||
    !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(configured)
  ) {
    throw new Error(
      "NEON_API_ORIGIN may only select a loopback HTTP origin under NODE_ENV=test.",
    );
  }
  return configured;
}

function pollInterval() {
  if (process.env.NODE_ENV !== "test") {
    return PRODUCTION_POLL_INTERVAL_MS;
  }
  const value = Number(process.env.NEON_POLL_INTERVAL_MS ?? 5);
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("NEON_POLL_INTERVAL_MS is invalid.");
  }
  return value;
}

function maxWait() {
  if (process.env.NODE_ENV !== "test") {
    return PRODUCTION_MAX_WAIT_MS;
  }
  const value = Number(process.env.NEON_MAX_WAIT_MS ?? 5_000);
  if (!Number.isInteger(value) || value < 100 || value > 10_000) {
    throw new Error("NEON_MAX_WAIT_MS is invalid.");
  }
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function apiPath(pathname, query = {}) {
  const url = new URL(pathname, apiOrigin());
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, String(value));
    }
  }
  return url;
}

async function apiRequest(
  configuration,
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
      response = await fetch(apiPath(pathname, query), {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${configuration.apiKey}`,
          ...(body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
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
      response.headers.get("neon-request-id") ??
      response.headers.get("x-request-id") ??
      "unavailable";
    throw new Error(
      `Neon ${method} request returned HTTP ${response.status} (request ${requestId}).`,
    );
  }
  throw new Error("Neon request exhausted its bounded retry policy.");
}

async function verifyProject(configuration) {
  const result = await apiRequest(
    configuration,
    "GET",
    `/api/v2/projects/${configuration.projectId}`,
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
    "GET",
    `/api/v2/projects/${configuration.projectId}/branches/${configuration.parentBranchId}`,
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

async function listAllBranches(configuration, includeDeleted) {
  const branches = [];
  let cursor;
  do {
    const page = await apiRequest(
      configuration,
      "GET",
      `/api/v2/projects/${configuration.projectId}/branches`,
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
  } while (cursor);
  return branches;
}

async function exactNamedBranches(configuration, includeDeleted = true) {
  return (await listAllBranches(configuration, includeDeleted)).filter(
    (branch) => branch?.name === configuration.branchName,
  );
}

async function waitForOperations(configuration, operationIds) {
  const deadline = Date.now() + maxWait();
  const pending = new Set(operationIds.filter(Boolean));
  while (pending.size > 0) {
    for (const operationId of pending) {
      const result = await apiRequest(
        configuration,
        "GET",
        `/api/v2/projects/${configuration.projectId}/operations/${operationId}`,
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
    await sleep(pollInterval());
  }
}

async function waitForBranchAndEndpoint(
  configuration,
  branchId,
  endpointId,
) {
  const deadline = Date.now() + maxWait();
  while (Date.now() < deadline) {
    const [branchResult, endpointResult] = await Promise.all([
      apiRequest(
        configuration,
        "GET",
        `/api/v2/projects/${configuration.projectId}/branches/${branchId}`,
      ),
      apiRequest(
        configuration,
        "GET",
        `/api/v2/projects/${configuration.projectId}/endpoints/${endpointId}`,
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
    await sleep(pollInterval());
  }
  throw new Error("Timed out waiting for the Neon proof branch.");
}

function validateConnectionUri(configuration, uri) {
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

async function writePrivate(path, value) {
  await writeFile(path, value, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function writeEvidence(configuration, evidence) {
  const serialized = `${JSON.stringify(evidence)}\n`;
  if (configuration.evidenceFile) {
    await writeFile(configuration.evidenceFile, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(configuration.evidenceFile, 0o600);
  }
  process.stdout.write(serialized);
}

async function readBranchId(configuration) {
  try {
    const value = (
      await readFile(configuration.branchIdFile, "utf8")
    ).trim();
    assertMatch("recorded Neon branch ID", value, /^br-[a-z0-9-]{1,56}$/);
    return value;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

async function createBranch(configuration) {
  await verifyProject(configuration);

  // include_deleted=true is intentionally required before mutation. Accounts
  // without hard-delete/branch-recovery support fail closed here.
  const before = await exactNamedBranches(configuration, true);
  if (before.length !== 0) {
    throw new Error(
      "The exact Neon proof branch name already exists or is recoverable.",
    );
  }

  let created;
  try {
    created = await apiRequest(
      configuration,
      "POST",
      `/api/v2/projects/${configuration.projectId}/branches`,
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
    const matches = await exactNamedBranches(configuration, true);
    if (matches.length === 1) {
      await writePrivate(
        configuration.branchIdFile,
        `${matches[0].id}\n`,
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
  await writePrivate(configuration.branchIdFile, `${branch.id}\n`);
  await waitForOperations(
    configuration,
    (created.operations ?? []).map((operation) => operation?.id),
  );
  const ready = await waitForBranchAndEndpoint(
    configuration,
    branch.id,
    endpoints[0].id,
  );

  const connection = await apiRequest(
    configuration,
    "GET",
    `/api/v2/projects/${configuration.projectId}/connection_uri`,
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
  await writePrivate(
    configuration.databaseUrlFile,
    `${connection.uri}\n`,
  );

  await writeEvidence(configuration, {
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
}

async function verifyBranch(configuration) {
  await verifyProject(configuration);
  const branchId = await readBranchId(configuration);
  if (!branchId) {
    throw new Error("The recorded Neon proof branch ID is absent.");
  }
  const matches = await exactNamedBranches(configuration, false);
  if (matches.length !== 1 || matches[0]?.id !== branchId) {
    throw new Error("The exact active Neon proof branch is not unique.");
  }
  const branch = matches[0];
  if (
    branch.project_id !== configuration.projectId ||
    branch.parent_id !== configuration.parentBranchId ||
    branch.default !== false ||
    branch.protected !== false ||
    branch.current_state !== "ready"
  ) {
    throw new Error("The Neon proof branch failed verification.");
  }
  const connectionUri = (
    await readFile(configuration.databaseUrlFile, "utf8")
  ).trim();
  validateConnectionUri(configuration, connectionUri);
  await writeEvidence(configuration, {
    object: "neon_ephemeral_branch",
    action: "verified",
    project_id_sha256: hash(configuration.projectId),
    branch_id_sha256: hash(branchId),
    branch_name: configuration.branchName,
    pg_version: 18,
    region_id: configuration.regionId,
    pooled_tls_uri_verified: true,
  });
}

async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function deleteBranch(configuration) {
  if (
    process.env.NEON_ALLOW_HARD_DELETE !== configuration.branchName
  ) {
    throw new Error(
      "NEON_ALLOW_HARD_DELETE must equal the exact disposable branch name.",
    );
  }
  await verifyProject(configuration);
  const recordedId = await readBranchId(configuration);
  const matches = await exactNamedBranches(configuration, true);
  if (matches.length > 1) {
    throw new Error("The exact Neon proof branch name is ambiguous.");
  }
  if (
    recordedId &&
    matches.length === 1 &&
    matches[0]?.id !== recordedId
  ) {
    throw new Error(
      "The recorded Neon branch ID does not match the exact branch name.",
    );
  }
  let branch = matches[0];
  if (!branch && recordedId) {
    const byId = await apiRequest(
      configuration,
      "GET",
      `/api/v2/projects/${configuration.projectId}/branches/${recordedId}`,
      { allowNotFound: true },
    );
    branch = byId?.branch;
  }
  const branchId = branch?.id ?? recordedId;
  if (!branch) {
    await removeIfPresent(configuration.databaseUrlFile);
    await removeIfPresent(configuration.branchIdFile);
    await writeEvidence(configuration, {
      object: "neon_ephemeral_branch",
      action: "absent",
      project_id_sha256: hash(configuration.projectId),
      ...(branchId
        ? { branch_id_sha256: hash(branchId) }
        : {}),
      branch_name: configuration.branchName,
      hard_deleted: true,
      include_deleted_inventory_absent: true,
    });
    return;
  }
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
    "DELETE",
    `/api/v2/projects/${configuration.projectId}/branches/${branchId}`,
    {
      query: { hard_delete: true },
    },
  );
  await waitForOperations(
    configuration,
    (result?.operations ?? []).map((operation) => operation?.id),
  );

  const deadline = Date.now() + maxWait();
  while (Date.now() < deadline) {
    const remaining = await exactNamedBranches(configuration, true);
    if (remaining.length === 0) {
      await removeIfPresent(configuration.databaseUrlFile);
      await removeIfPresent(configuration.branchIdFile);
      await writeEvidence(configuration, {
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
    await sleep(pollInterval());
  }
  throw new Error(
    "The Neon branch remains present or recoverable after hard delete.",
  );
}

export async function runNeonBranch(action) {
  const configuration = inputs();
  if (action === "create") {
    await createBranch(configuration);
  } else if (action === "verify") {
    await verifyBranch(configuration);
  } else if (action === "delete") {
    await deleteBranch(configuration);
  } else {
    throw new Error("Expected Neon branch action: create, verify, or delete.");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runNeonBranch(process.argv[2]);
}
