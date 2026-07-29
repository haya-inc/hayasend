import { createHash } from "node:crypto";
import {
  chmod,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";

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
    projectIdFile: required("HAYASEND_VERCEL_PROJECT_ID_FILE"),
    evidenceFile: process.env.HAYASEND_VERCEL_PROJECT_EVIDENCE_FILE,
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
  if (
    !/^hayasend-vercel-[a-z0-9][a-z0-9-]{0,62}$/.test(
      result.projectName,
    )
  ) {
    throw new Error(
      "HAYASEND_VERCEL_PROJECT_NAME must be an exact disposable proof name.",
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
    return PRODUCTION_POLL_INTERVAL_MS;
  }
  const value = Number(process.env.VERCEL_POLL_INTERVAL_MS ?? 5);
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("VERCEL_POLL_INTERVAL_MS is invalid.");
  }
  return value;
}

function maxWait() {
  if (process.env.NODE_ENV !== "test") {
    return PRODUCTION_MAX_WAIT_MS;
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

function apiUrl(pathname, query = {}) {
  const url = new URL(pathname, apiOrigin());
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
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
    scoped = true,
  } = {},
) {
  const attempts = retrySafe ? 4 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(
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
      `Vercel ${method} request returned HTTP ${response.status} (request ${requestId}).`,
    );
  }
  throw new Error("Vercel request exhausted its bounded retry policy.");
}

async function verifyTeam(config) {
  const team = await request(
    config,
    "GET",
    `/v2/teams/${config.organizationId}`,
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

async function findProject(config, idOrName) {
  return request(
    config,
    "GET",
    `/v9/projects/${encodeURIComponent(idOrName)}`,
    { allowNotFound: true },
  );
}

async function writePrivate(path, value) {
  await writeFile(path, value, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function readProjectId(config) {
  try {
    const id = (await readFile(config.projectIdFile, "utf8")).trim();
    if (!/^prj_[A-Za-z0-9]{8,64}$/.test(id)) {
      throw new Error("The recorded Vercel project ID is invalid.");
    }
    return id;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return undefined;
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

async function createProject(config) {
  await verifyTeam(config);
  if ((await findProject(config, config.projectName)) !== undefined) {
    throw new Error("The exact Vercel proof project already exists.");
  }

  let created;
  try {
    created = await request(config, "POST", "/v11/projects", {
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
    const resolved = await findProject(config, config.projectName);
    if (resolved?.id) {
      await writePrivate(config.projectIdFile, `${resolved.id}\n`);
    }
    throw error;
  }

  assertProject(config, created);
  await writePrivate(config.projectIdFile, `${created.id}\n`);
  const inspected = await findProject(config, created.id);
  assertProject(config, inspected, created.id);
  await evidence(config, {
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
}

async function verifyProject(config) {
  await verifyTeam(config);
  const projectId = await readProjectId(config);
  if (!projectId) {
    throw new Error("The recorded Vercel proof project ID is absent.");
  }
  const [byId, byName] = await Promise.all([
    findProject(config, projectId),
    findProject(config, config.projectName),
  ]);
  assertProject(config, byId, projectId);
  assertProject(config, byName, projectId);
  await evidence(config, {
    object: "vercel_disposable_project",
    action: "verified",
    organization_id_sha256: hash(config.organizationId),
    project_id_sha256: hash(projectId),
    project_name: config.projectName,
    team_plan: config.teamPlan,
    framework: "hono",
    region: "hnd1",
    production_api_public: true,
  });
}

async function removeProjectIdFile(config) {
  try {
    await unlink(config.projectIdFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function deleteProject(config) {
  if (
    process.env.HAYASEND_VERCEL_DELETE_CONFIRMATION !==
    config.projectName
  ) {
    throw new Error(
      "HAYASEND_VERCEL_DELETE_CONFIRMATION must equal the exact disposable project name.",
    );
  }
  await verifyTeam(config);
  const recordedId = await readProjectId(config);
  const [byName, recordedProject] = await Promise.all([
    findProject(config, config.projectName),
    recordedId ? findProject(config, recordedId) : undefined,
  ]);
  if (
    recordedId &&
    byName &&
    byName.id !== recordedId
  ) {
    throw new Error(
      "The recorded Vercel project ID does not match its exact name.",
    );
  }
  if (!recordedProject && !byName) {
    await removeProjectIdFile(config);
    await evidence(config, {
      object: "vercel_disposable_project",
      action: "absent",
      organization_id_sha256: hash(config.organizationId),
      project_name: config.projectName,
      deleted: true,
    });
    return;
  }
  const projectId = recordedId ?? byName?.id;
  if (!projectId) {
    throw new Error("Unable to resolve the exact Vercel project ID.");
  }
  const byId =
    recordedProject ?? (await findProject(config, projectId));
  assertProject(config, byId, projectId);
  assertProject(config, byName, projectId);

  await request(
    config,
    "DELETE",
    `/v9/projects/${encodeURIComponent(projectId)}`,
  );

  const deadline = Date.now() + maxWait();
  while (Date.now() < deadline) {
    const [remainingId, remainingName] = await Promise.all([
      findProject(config, projectId),
      findProject(config, config.projectName),
    ]);
    if (!remainingId && !remainingName) {
      await removeProjectIdFile(config);
      await evidence(config, {
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
    await sleep(pollInterval());
  }
  throw new Error("The exact Vercel project remains visible after deletion.");
}

export async function runProjectLifecycle(action) {
  const config = configuration();
  if (action === "create") {
    await createProject(config);
  } else if (action === "verify") {
    await verifyProject(config);
  } else if (action === "delete") {
    await deleteProject(config);
  } else {
    throw new Error(
      "Expected Vercel project action: create, verify, or delete.",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runProjectLifecycle(process.argv[2]);
}
