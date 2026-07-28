import {
  bucket,
  defineRailway,
  group,
  image,
  postgres,
  project,
  ref,
  service,
} from "railway/iac";

const railwayRegion = "asia-southeast1-eqsg3a";
const releasedImage =
  "ghcr.io/haya-inc/hayasend@sha256:8358bf6463372e95bf7e5fdbae493634d3a200621efddf2fb722c8b64514fc96";
const imageReference = process.env.HAYASEND_IMAGE ?? releasedImage;
const apiKey = process.env.HAYASEND_API_KEY;

if (
  !/^ghcr\.io\/haya-inc\/hayasend@sha256:[a-f0-9]{64}$/.test(
    imageReference,
  )
) {
  throw new Error(
    "HAYASEND_IMAGE must be an immutable official HayaSend GHCR digest.",
  );
}
if (
  !apiKey ||
  apiKey.length < 16 ||
  apiKey.length > 512 ||
  !apiKey.startsWith("re_")
) {
  throw new Error(
    "HAYASEND_API_KEY must be a 16 to 512 character re_ key.",
  );
}

export default defineRailway(() => {
  const database = postgres("hayasend-postgres", {
    region: railwayRegion,
  });
  const attachments = bucket("hayasend-attachments", {
    region: "sin",
  });
  const sharedEnvironment = {
    AWS_ACCESS_KEY_ID: ref(attachments, "ACCESS_KEY_ID"),
    AWS_REGION: ref(attachments, "REGION"),
    AWS_SECRET_ACCESS_KEY: ref(attachments, "SECRET_ACCESS_KEY"),
    HAYASEND_API_KEY: apiKey,
    HAYASEND_DATABASE_URL: database.env.DATABASE_URL,
    HAYASEND_MODE: "portable",
    HAYASEND_OBJECT_STORAGE: "s3",
    HAYASEND_OBJECT_STORAGE_BUCKET: ref(attachments, "BUCKET"),
    HAYASEND_POSTGRES_POOL_MAX: "8",
    HAYASEND_S3_ENDPOINT: ref(attachments, "ENDPOINT"),
    HAYASEND_S3_FORCE_PATH_STYLE: "false",
    HAYASEND_TRANSPORT: "console",
  } as const;

  const api = service("hayasend-api", {
    source: image(imageReference, {
      autoUpdates: {
        type: "disabled",
      },
    }),
    start: "node dist/server.js",
    preDeploy: "node dist/portable/migrate.js",
    healthcheck: "/readyz",
    healthcheckTimeout: 120,
    replicas: {
      [railwayRegion]: 1,
    },
    deploy: {
      drainingSeconds: 120,
      overlapSeconds: 30,
      restartPolicyMaxRetries: 10,
      restartPolicyType: "ALWAYS",
    },
    env: {
      ...sharedEnvironment,
      HAYASEND_HOST: "0.0.0.0",
      HAYASEND_PORT: "8787",
    },
  });

  const worker = service("hayasend-worker", {
    source: image(imageReference, {
      autoUpdates: {
        type: "disabled",
      },
    }),
    start: "node dist/portable/worker.js",
    preDeploy: "node dist/portable/migrate.js",
    replicas: {
      [railwayRegion]: 1,
    },
    deploy: {
      drainingSeconds: 120,
      restartPolicyMaxRetries: 10,
      restartPolicyType: "ALWAYS",
    },
    env: {
      ...sharedEnvironment,
      HAYASEND_WORKER_CONCURRENCY: "4",
    },
  });

  return project("hayasend-railway", {
    resources: [
      group("Application", [api, worker]),
      group("Data", [database, attachments]),
    ],
  });
});
