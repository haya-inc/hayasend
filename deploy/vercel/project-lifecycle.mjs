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

function configuration() {
  const result = {
    token: required("VERCEL_TOKEN"),
    organizationId: required("HAYASEND_VERCEL_ORG_ID"),
    teamSlug: required("HAYASEND_VERCEL_TEAM_SLUG"),
    teamPlan: required("HAYASEND_VERCEL_TEAM_PLAN"),
    projectName: required("HAYASEND_VERCEL_PROJECT_NAME"),
  };
  if (!/^team_[A-Za-z0-9]{8,64}$/.test(result.organizationId)) {
    throw new Error(
      "HAYASEND_VERCEL_ORG_ID must be the exact dedicated team_* ID.",
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(result.teamSlug)) {
    throw new Error("HAYASEND_VERCEL_TEAM_SLUG has an invalid format.");
  }
  if (result.teamPlan !== "pro") {
    throw new Error("HAYASEND_VERCEL_TEAM_PLAN must equal pro.");
  }
  if (!/^hayasend-vercel-[a-z0-9][a-z0-9-]{0,62}$/.test(result.projectName)) {
    throw new Error(
      "HAYASEND_VERCEL_PROJECT_NAME must be an exact disposable proof name.",
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
    throw new Error("The Vercel poll interval is invalid.");
  }
  if (
    !Number.isInteger(maxWaitMs) ||
    maxWaitMs < 100 ||
    maxWaitMs > PRODUCTION_MAX_WAIT_MS
  ) {
    throw new Error("The Vercel maximum wait is invalid.");
  }
  if (typeof writeEvidence !== "function") {
    throw new Error("A Vercel evidence writer is required.");
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

function apiUrl(pathname, query = {}) {
  const url = new URL(pathname, PRODUCTION_API_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
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
    scoped = true,
  } = {},
) {
  const attempts = retrySafe ? 4 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await execution.fetch(
        apiUrl(pathname, {
          teamId: scoped ? config.organizationId : undefined,
        }),
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
          `Vercel ${method} request failed before receiving a response.`,
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
      `Vercel ${method} request returned HTTP ${response.status} (request ${requestId}).`,
    );
  }
  throw new Error("Vercel request exhausted its bounded retry policy.");
}

async function verifyTeam(config, execution) {
  const team = await request(
    config,
    execution,
    "GET",
    `/v2/teams/${encodeURIComponent(config.organizationId)}`,
    { scoped: false },
  );
  if (
    team?.id !== config.organizationId ||
    team?.slug !== config.teamSlug ||
    team?.billing?.plan !== config.teamPlan ||
    team?.membership?.confirmed !== true ||
    !["OWNER", "MEMBER"].includes(team?.membership?.role)
  ) {
    throw new Error(
      "The Vercel token is not an authorized member of the exact Pro test team.",
    );
  }
  return team;
}

function assertProject(config, project, expectedId) {
  if (
    !project ||
    (expectedId !== undefined && project.id !== expectedId) ||
    !/^prj_[A-Za-z0-9]{8,64}$/.test(project.id ?? "") ||
    project.name !== config.projectName ||
    project.accountId !== config.organizationId ||
    project.framework !== "hono" ||
    project.previewDeploymentsDisabled !== true ||
    project.resourceConfig?.fluid !== true ||
    !Array.isArray(project.resourceConfig?.functionDefaultRegions) ||
    project.resourceConfig.functionDefaultRegions.length !== 1 ||
    project.resourceConfig.functionDefaultRegions[0] !== "hnd1" ||
    project.ssoProtection !== null ||
    project.gitRepository != null
  ) {
    throw new Error(
      "The Vercel project does not match the exact isolated public-API proof topology.",
    );
  }
}

async function findProject(config, execution, idOrName) {
  return request(
    config,
    execution,
    "GET",
    `/v9/projects/${encodeURIComponent(idOrName)}`,
    { allowNotFound: true },
  );
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function evidence(execution, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  await execution.writeEvidence(serialized);
}

async function createProject(config, execution) {
  await verifyTeam(config, execution);
  if (
    (await findProject(config, execution, config.projectName)) !== undefined
  ) {
    throw new Error("The exact Vercel proof project already exists.");
  }

  let created;
  try {
    created = await request(config, execution, "POST", "/v11/projects", {
      retrySafe: false,
      body: {
        name: config.projectName,
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
    });
  } catch (error) {
    // A create timeout is ambiguous. Never send a second POST: resolve the
    // deterministic name and record its exact ID for finally cleanup.
    const resolved = await findProject(config, execution, config.projectName);
    if (resolved?.id) {
      assertProject(config, resolved);
    }
    throw error;
  }

  assertProject(config, created);
  const inspected = await findProject(config, execution, created.id);
  assertProject(config, inspected, created.id);
  await evidence(execution, {
    object: "vercel_disposable_project",
    action: "created",
    organization_id_sha256: hash(config.organizationId),
    project_id_sha256: hash(created.id),
    project_name: config.projectName,
    team_plan: config.teamPlan,
    framework: "hono",
    region: "hnd1",
    fluid_compute: true,
    preview_deployments_disabled: true,
    production_api_public: true,
    git_repository_connected: false,
  });
  return created.id;
}

async function verifyProject(config, execution) {
  await verifyTeam(config, execution);
  const byName = await findProject(config, execution, config.projectName);
  assertProject(config, byName);
  const byId = await findProject(config, execution, byName.id);
  assertProject(config, byId, byName.id);
  await evidence(execution, {
    object: "vercel_disposable_project",
    action: "verified",
    organization_id_sha256: hash(config.organizationId),
    project_id_sha256: hash(byName.id),
    project_name: config.projectName,
    team_plan: config.teamPlan,
    framework: "hono",
    region: "hnd1",
    production_api_public: true,
  });
}

async function deleteProject(config, execution) {
  if (process.env.HAYASEND_VERCEL_DELETE_CONFIRMATION !== config.projectName) {
    throw new Error(
      "HAYASEND_VERCEL_DELETE_CONFIRMATION must equal the exact disposable project name.",
    );
  }
  await verifyTeam(config, execution);
  const byName = await findProject(config, execution, config.projectName);
  if (!byName) {
    await evidence(execution, {
      object: "vercel_disposable_project",
      action: "absent",
      organization_id_sha256: hash(config.organizationId),
      project_name: config.projectName,
      deleted: true,
    });
    return;
  }
  const projectId = byName.id;
  const byId = await findProject(config, execution, projectId);
  assertProject(config, byId, projectId);
  assertProject(config, byName, projectId);

  await request(
    config,
    execution,
    "DELETE",
    `/v9/projects/${encodeURIComponent(projectId)}`,
  );

  const deadline = Date.now() + execution.maxWaitMs;
  while (Date.now() < deadline) {
    const [remainingId, remainingName] = await Promise.all([
      findProject(config, execution, projectId),
      findProject(config, execution, config.projectName),
    ]);
    if (!remainingId && !remainingName) {
      await evidence(execution, {
        object: "vercel_disposable_project",
        action: "deleted",
        organization_id_sha256: hash(config.organizationId),
        project_id_sha256: hash(projectId),
        project_name: config.projectName,
        deleted: true,
        id_inventory_absent: true,
        name_inventory_absent: true,
      });
      return;
    }
    await sleep(execution.pollIntervalMs);
  }
  throw new Error("The exact Vercel project remains visible after deletion.");
}

export async function runProjectLifecycle(action, options) {
  const config = configuration();
  const execution = runtime(options);
  if (action === "create") {
    return createProject(config, execution);
  } else if (action === "verify") {
    await verifyProject(config, execution);
  } else if (action === "delete") {
    await deleteProject(config, execution);
  } else {
    throw new Error(
      "Expected Vercel project action: create, verify, or delete.",
    );
  }
}
