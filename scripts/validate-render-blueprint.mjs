import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseDocument } from "yaml";

const blueprintPath = "deploy/render/render.yaml";
const blueprintUrl = new URL(
  "../deploy/render/render.yaml",
  import.meta.url,
);
const schemaUrl = "https://render.com/schema/render.yaml.json";
const expectedSchemaHash = (
  await readFile(
    new URL(
      "../deploy/render/.render-schema-sha256",
      import.meta.url,
    ),
    "utf8",
  )
).trim();

const response = await fetch(schemaUrl, {
  headers: {
    accept: "application/schema+json, application/json",
    "user-agent": "HayaSend Render Blueprint validator",
  },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) {
  throw new Error(
    `Render Blueprint schema download failed with HTTP ${response.status}.`,
  );
}
const schemaText = await response.text();
const actualSchemaHash = createHash("sha256")
  .update(schemaText)
  .digest("hex");
if (actualSchemaHash !== expectedSchemaHash) {
  throw new Error(
    "The official Render Blueprint schema changed; review it and update the pinned SHA-256.",
  );
}

const source = await readFile(blueprintUrl, "utf8");
const document = parseDocument(source, {
  prettyErrors: false,
  strict: true,
  uniqueKeys: true,
});
if (document.errors.length > 0) {
  throw new Error(
    `Invalid Render Blueprint YAML: ${document.errors.map((error) => error.message).join("; ")}`,
  );
}
const blueprint = document.toJS({ maxAliasCount: 0 });
const schema = JSON.parse(schemaText);
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
});
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(blueprint)) {
  throw new Error(
    `Render Blueprint schema validation failed: ${ajv.errorsText(
      validate.errors,
      { separator: "; " },
    )}`,
  );
}

const services = new Map(
  (blueprint.services ?? []).map((service) => [
    service.name,
    service,
  ]),
);
const api = services.get("hayasend-api");
const worker = services.get("hayasend-worker");
const database = (blueprint.databases ?? []).find(
  (candidate) => candidate.name === "hayasend-postgres",
);
if (!api || api.type !== "web" || api.runtime !== "image") {
  throw new Error("The Blueprint must define the image-backed HayaSend API.");
}
if (!worker || worker.type !== "worker" || worker.runtime !== "image") {
  throw new Error(
    "The Blueprint must define the image-backed HayaSend worker.",
  );
}
if (!database) {
  throw new Error("The Blueprint must define HayaSend PostgreSQL.");
}

const imagePattern =
  /^ghcr\.io\/haya-inc\/hayasend@sha256:[a-f0-9]{64}$/;
if (
  !imagePattern.test(api.image?.url ?? "") ||
  worker.image?.url !== api.image.url
) {
  throw new Error(
    "The API and worker must use one immutable official GHCR digest.",
  );
}
if (
  blueprint.previews?.generation !== "off" ||
  api.autoDeployTrigger !== "off" ||
  worker.autoDeployTrigger !== "off"
) {
  throw new Error(
    "Preview environments and automatic deploy triggers must fail closed.",
  );
}
if (
  api.preDeployCommand !== "node dist/portable/migrate.js" ||
  worker.preDeployCommand !== "node dist/portable/migrate.js"
) {
  throw new Error(
    "Both services must gate new revisions on checksum-pinned migrations.",
  );
}
if (
  database.postgresMajorVersion !== "18" ||
  database.plan !== "basic-256mb" ||
  database.diskSizeGB !== 1 ||
  database.storageAutoscalingEnabled !== false ||
  !Array.isArray(database.ipAllowList) ||
  database.ipAllowList.length !== 0
) {
  throw new Error(
    "Render PostgreSQL must use the minimum explicit PostgreSQL 18 plan and one-GB non-autoscaling private storage.",
  );
}

function environmentValue(service, key) {
  return service.envVars?.find((entry) => entry.key === key);
}

if (
  environmentValue(api, "HAYASEND_TRANSPORT")?.value !==
    "console" ||
  environmentValue(worker, "HAYASEND_TRANSPORT")?.value !==
    "console" ||
  environmentValue(
    api,
    "HAYASEND_CONSOLE_PROOF_CONFIRM",
  )?.value !== "isolated-non-sending" ||
  environmentValue(
    worker,
    "HAYASEND_CONSOLE_PROOF_CONFIRM",
  )?.value !== "isolated-non-sending" ||
  environmentValue(api, "HAYASEND_OBJECT_STORAGE")?.value !==
    "disabled" ||
  environmentValue(worker, "HAYASEND_OBJECT_STORAGE")?.value !==
    "disabled"
) {
  throw new Error(
    "The Blueprint must start with the non-sending console transport and disabled direct-upload storage.",
  );
}
if (
  environmentValue(api, "HAYASEND_API_KEY")?.sync !== false ||
  environmentValue(worker, "HAYASEND_API_KEY")?.fromService
    ?.envVarKey !== "HAYASEND_API_KEY"
) {
  throw new Error(
    "The API key must be prompted once and shared with the worker by reference.",
  );
}
if (
  environmentValue(api, "SENDGRID_API_KEY") !== undefined ||
  environmentValue(worker, "SENDGRID_API_KEY") !== undefined ||
  environmentValue(api, "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY") !==
    undefined ||
  environmentValue(worker, "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY") !==
    undefined
) {
  throw new Error(
    "The lifecycle-only Blueprint must not request SendGrid credentials.",
  );
}

console.info(
  JSON.stringify({
    ok: true,
    blueprint: blueprintPath,
    schema_sha256: actualSchemaHash,
    image: api.image.url,
    services: [...services.keys()].sort(),
    database: database.name,
  }),
);
