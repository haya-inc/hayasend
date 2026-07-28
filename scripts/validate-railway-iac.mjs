import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import {
  evaluateRailwayFile,
  validateGraph,
} from "railway/iac";

const railwayFile = fileURLToPath(
  new URL(
    "../deploy/railway/.railway/railway.ts",
    import.meta.url,
  ),
);
const expectedImage =
  "ghcr.io/haya-inc/hayasend@sha256:8358bf6463372e95bf7e5fdbae493634d3a200621efddf2fb722c8b64514fc96";
process.env.HAYASEND_API_KEY ??=
  "re_RAILWAY_STATIC_VALIDATION_DO_NOT_USE";
process.env.SENDGRID_API_KEY ??=
  "SG.RAILWAY_STATIC_VALIDATION_DO_NOT_USE_000000";
process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY ??=
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";

const result = await evaluateRailwayFile(railwayFile, {
  context: {
    command: "plan",
    environment: "production",
    environmentName: "production",
  },
});
assert.deepEqual(validateGraph(result.graph), []);
assert.equal(result.graph.project.name, "hayasend-railway");

const resources = new Map(
  result.graph.resources.map((resource) => [
    resource.name,
    resource,
  ]),
);
assert.deepEqual(
  [
    "Application",
    "Data",
    "hayasend-api",
    "hayasend-attachments",
    "hayasend-postgres",
    "hayasend-worker",
  ].filter((name) => !resources.has(name)),
  [],
);

for (const name of ["hayasend-api", "hayasend-worker"]) {
  const resource = resources.get(name);
  assert.equal(resource?.type, "service");
  assert.equal(resource?.kind, "docker-image");
  assert.equal(resource?.source?.image, expectedImage);
  assert.equal(resource?.source?.autoUpdates?.type, "disabled");
  assert.deepEqual(resource?.deploy?.preDeployCommand, [
    "node dist/portable/migrate.js",
  ]);
  assert.equal(
    resource?.deploy?.multiRegionConfig?.[
      "asia-southeast1-eqsg3a"
    ]?.numReplicas,
    1,
  );
  assert.equal(
    resource?.variables?.HAYASEND_DATABASE_URL?.type,
    "reference",
  );
  assert.equal(
    resource?.variables?.HAYASEND_OBJECT_STORAGE_BUCKET?.type,
    "reference",
  );
  assert.equal(
    resource?.variables?.AWS_SECRET_ACCESS_KEY?.type,
    "reference",
  );
  assert.equal(
    resource?.variables?.HAYASEND_TRANSPORT?.value,
    "sendgrid",
  );
  assert.equal(
    resource?.variables?.SENDGRID_API_KEY?.value,
    process.env.SENDGRID_API_KEY,
  );
}

const api = resources.get("hayasend-api");
assert.equal(api?.deploy?.startCommand, "node dist/server.js");
assert.equal(api?.deploy?.healthcheckPath, "/readyz");
assert.equal(api?.deploy?.healthcheckTimeout, 120);
assert.equal(
  api?.variables?.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY?.value,
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY,
);

const worker = resources.get("hayasend-worker");
assert.equal(
  worker?.deploy?.startCommand,
  "node dist/portable/worker.js",
);
assert.equal(
  worker?.variables?.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY,
  undefined,
);

const database = resources.get("hayasend-postgres");
assert.equal(database?.type, "database");
assert.equal(database?.engine, "postgres");
assert.equal(
  database?.image,
  "ghcr.io/railwayapp-templates/postgres-ssl:18",
);

const attachments = resources.get("hayasend-attachments");
assert.equal(attachments?.type, "bucket");
assert.equal(attachments?.config?.region, "sin");

console.log(
  "Railway IaC defines the expected immutable API, worker, PostgreSQL, and bucket topology.",
);
