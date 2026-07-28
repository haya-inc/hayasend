import {
  chmod,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const deploymentDirectory = resolve("deploy/flyio");
const image =
  "ghcr.io/haya-inc/hayasend@sha256:" +
  "0123456789abcdef".repeat(4);
const rollbackImage =
  "ghcr.io/haya-inc/hayasend@sha256:" +
  "fedcba9876543210".repeat(4);
const machineImageDigest =
  "sha256:" + "1234567890abcdef".repeat(4);
const rollbackMachineImageDigest =
  "sha256:" + "abcdef1234567890".repeat(4);
const app = "hayasend-flyio-ci";
const organization = "haya-inc";
const clusterId = "mpg_cluster_123";
const bucket = `${app}-attachments`;

async function fakeCommands() {
  const directory = await mkdtemp(
    resolve(tmpdir(), "hayasend-flyio-test-"),
  );
  const log = resolve(directory, "commands.log");
  const flyState = resolve(directory, "state");
  const flyctl = resolve(directory, "flyctl");
  const curl = resolve(directory, "curl");
  await writeFile(log, "");
  await writeFile(flyState, "");
  await writeFile(
    flyctl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FLY_TEST_LOG"
state="$FLY_TEST_STATE"
if [[ "\${1:-}" == "version" ]]; then
  printf '%s\\n' "flyctl v0.4.75 linux/amd64 Commit: test"
elif [[ "\${1:-} \${2:-}" == "apps list" ]]; then
  if [[ -f "\${state}.app-deleted" ]] ||
    [[ "\${FLY_FAKE_APP_EXISTS:-true}" == "false" ]]; then
    printf '%s\\n' '[]'
  else
    printf '[{"name":"%s","organization":{"slug":"%s"}}]\\n' \
      "$HAYASEND_FLY_APP" "$HAYASEND_FLY_ORG"
  fi
elif [[ "\${1:-} \${2:-}" == "mpg list" ]]; then
  if [[ -f "\${state}.mpg-deleted" ]]; then
    printf '%s\\n' '[]'
  else
    printf '[{"id":"%s","name":"%s-mpg","organization":{"slug":"%s"},"status":"ready","attached_apps":[{"name":"%s"}]}]\\n' \
      "$HAYASEND_FLY_MPG_CLUSTER_ID" "$HAYASEND_FLY_APP" \
      "$HAYASEND_FLY_ORG" "$HAYASEND_FLY_APP"
  fi
elif [[ "\${1:-} \${2:-}" == "storage list" ]]; then
  printf '%s\\n' "NAME ORG"
  if [[ ! -f "\${state}.bucket-deleted" ]]; then
    printf '%s %s\\n' "$HAYASEND_FLY_BUCKET" "$HAYASEND_FLY_ORG"
  fi
elif [[ "\${1:-} \${2:-}" == "storage status" ]]; then
  printf 'Name %s\\nStatus ready\\nPublic False\\nApp %s\\n' \
    "$HAYASEND_FLY_BUCKET" "$HAYASEND_FLY_APP"
elif [[ "\${1:-} \${2:-}" == "secrets list" ]]; then
  printf '%s\\n' '[
    {"name":"AWS_ACCESS_KEY_ID","digest":"a","status":"Deployed"},
    {"name":"AWS_ENDPOINT_URL_S3","digest":"b","status":"Deployed"},
    {"name":"AWS_REGION","digest":"c","status":"Deployed"},
    {"name":"AWS_SECRET_ACCESS_KEY","digest":"d","status":"Deployed"},
    {"name":"BUCKET_NAME","digest":"e","status":"Deployed"},
    {"name":"HAYASEND_API_KEY","digest":"f","status":"'\${FLY_FAKE_SECRET_STATUS:-Deployed}'"},
    {"name":"HAYASEND_DATABASE_URL","digest":"g","status":"Deployed"},
    {"name":"HAYASEND_OBJECT_STORAGE_BUCKET","digest":"h","status":"Deployed"},
    {"name":"SENDGRID_API_KEY","digest":"i","status":"Deployed"},
    {"name":"SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY","digest":"j","status":"Deployed"}
  ]'
elif [[ "\${1:-} \${2:-}" == "machine list" ]]; then
  machine_image="registry.fly.io/$HAYASEND_FLY_APP:deployment-test"
  machine_digest="\${FLY_FAKE_MACHINE_DIGEST:-$HAYASEND_FLY_MACHINE_IMAGE_DIGEST}"
  extra=''
  if [[ "\${FLY_FAKE_EXTRA_MACHINE:-false}" == "true" ]]; then
    extra=',{"id":"extra","state":"started","image_ref":{"digest":"'"$machine_digest"'","labels":{"org.opencontainers.image.source":"https://github.com/haya-inc/hayasend","org.opencontainers.image.title":"HayaSend"}},"config":{"image":"'"$machine_image"'","metadata":{"fly_process_group":"extra"},"mounts":[]}}'
  fi
  printf '[{"id":"api","state":"started","image_ref":{"digest":"%s","labels":{"org.opencontainers.image.source":"https://github.com/haya-inc/hayasend","org.opencontainers.image.title":"HayaSend"}},"config":{"image":"%s","metadata":{"fly_process_group":"api"},"mounts":[]}},{"id":"worker","state":"started","image_ref":{"digest":"%s","labels":{"org.opencontainers.image.source":"https://github.com/haya-inc/hayasend","org.opencontainers.image.title":"HayaSend"}},"config":{"image":"%s","metadata":{"fly_process_group":"worker"},"mounts":[]}}%s]\\n' \
    "$machine_digest" "$machine_image" "$machine_digest" "$machine_image" "$extra"
elif [[ "\${1:-} \${2:-}" == "checks list" ]]; then
  printf '%s\\n' '{"api":[{"name":"servicecheck-00-http-8080","status":"passing"}]}'
elif [[ "\${1:-} \${2:-}" == "storage destroy" ]]; then
  : > "\${state}.bucket-deleted"
elif [[ "\${1:-} \${2:-}" == "apps destroy" ]]; then
  : > "\${state}.app-deleted"
elif [[ "\${1:-} \${2:-}" == "mpg destroy" ]]; then
  : > "\${state}.mpg-deleted"
else
  printf '%s\\n' '{}'
fi
`,
  );
  await writeFile(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >> "$FLY_TEST_LOG"
`,
  );
  await chmod(flyctl, 0o755);
  await chmod(curl, 0o755);
  return { directory, flyState, flyctl, log };
}

function run(
  script: string,
  fixture: Awaited<ReturnType<typeof fakeCommands>>,
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync(resolve(deploymentDirectory, script), {
    cwd: deploymentDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      PATH: `${fixture.directory}${delimiter}${process.env.PATH ?? ""}`,
      FLY_CLI: fixture.flyctl,
      FLY_TEST_LOG: fixture.log,
      FLY_TEST_STATE: fixture.flyState,
    },
  });
}

const baseEnvironment = {
  HAYASEND_FLY_APP: app,
  HAYASEND_FLY_BUCKET: bucket,
  HAYASEND_FLY_MPG_CLUSTER_ID: clusterId,
  HAYASEND_FLY_ORG: organization,
  HAYASEND_FLY_MACHINE_IMAGE_DIGEST: machineImageDigest,
  HAYASEND_IMAGE: image,
  SENDGRID_API_KEY: "SG.FLYIO_TEST_KEY_000000000000000000",
  SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==",
};

describe.skipIf(process.platform === "win32")(
  "Fly.io deployment scripts",
  () => {
    it("deploys the exact immutable image with migrations and verifies the topology", async () => {
      const fixture = await fakeCommands();
      const result = run("deploy.sh", fixture, baseEnvironment);
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `HayaSend Fly.io API: https://${app}.fly.dev`,
      );
      expect(commands).toContain(
        `config validate --strict --app ${app} --config ${deploymentDirectory}/fly.toml`,
      );
      expect(commands).toContain(
        `deploy --app ${app} --config ${deploymentDirectory}/fly.toml ` +
          `--image ${image} --strategy rolling ` +
          "--release-command-timeout 10m --ha=false --yes",
      );
      expect(commands).not.toContain("--skip-release-command");
      expect(commands).toContain(`https://${app}.fly.dev/healthz`);
      expect(commands).toContain(`https://${app}.fly.dev/readyz`);
    });

    it("rejects machines running a different image", async () => {
      const fixture = await fakeCommands();
      const result = run("verify.sh", fixture, {
        ...baseEnvironment,
        FLY_FAKE_MACHINE_DIGEST: rollbackMachineImageDigest,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "not the exact started API/worker pair",
      );
    });

    it("rejects required secrets without exact deployed status", async () => {
      const fixture = await fakeCommands();
      const result = run("verify.sh", fixture, {
        ...baseEnvironment,
        FLY_FAKE_SECRET_STATUS: "Unknown",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Required app secrets are missing or not fully deployed",
      );
    });

    it("rolls back by redeploying an older immutable image without rerunning migrations", async () => {
      const fixture = await fakeCommands();
      const result = run("rollback.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_ROLLBACK_IMAGE: rollbackImage,
        HAYASEND_ROLLBACK_MACHINE_IMAGE_DIGEST:
          rollbackMachineImageDigest,
      });
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(commands).toContain(
        `--image ${rollbackImage} --strategy rolling ` +
          "--skip-release-command --ha=false --yes",
      );
      expect(result.stdout).toContain(
        "rolled back to the reviewed immutable image",
      );
    });

    it("deletes only the exact guarded app, empty bucket, and attached database", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_ALLOW_DESTROY: "flyio",
        HAYASEND_FLY_DEDICATED_APP: "true",
        HAYASEND_FLY_TIGRIS_EMPTY: "true",
      });
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(commands.indexOf(`storage destroy ${bucket}`)).toBeLessThan(
        commands.indexOf(`apps destroy ${app}`),
      );
      expect(commands.indexOf(`apps destroy ${app}`)).toBeLessThan(
        commands.indexOf(`mpg destroy ${clusterId}`),
      );
      expect(result.stdout).toContain(
        "absent from active inventory",
      );
    });

    it("refuses cleanup without all destructive guards", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, baseEnvironment);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Set HAYASEND_ALLOW_DESTROY=flyio",
      );
      expect(await readFile(fixture.log, "utf8")).toBe("");
    });

    it("refuses cleanup when another Machine exists", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, {
        ...baseEnvironment,
        FLY_FAKE_EXTRA_MACHINE: "true",
        HAYASEND_ALLOW_DESTROY: "flyio",
        HAYASEND_FLY_DEDICATED_APP: "true",
        HAYASEND_FLY_TIGRIS_EMPTY: "true",
      });
      const commands = await readFile(fixture.log, "utf8");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "not the exact started API/worker pair",
      );
      expect(commands).not.toContain(`storage destroy ${bucket}`);
    });

    it("refuses provisioning when the requested app name already exists", async () => {
      const fixture = await fakeCommands();
      const result = run("provision.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_API_KEY: "re_FLYIO_PROVISION_TEST_KEY",
        HAYASEND_FLY_CREATE: "confirmed",
        HAYASEND_FLY_MPG_PLAN: "basic",
      });
      const commands = await readFile(fixture.log, "utf8");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "requested Fly App already exists",
      );
      expect(commands).not.toContain(`apps create ${app}`);
    });

    it("refuses a Fly App name with a trailing hyphen", async () => {
      const fixture = await fakeCommands();
      const result = run("provision.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_API_KEY: "re_FLYIO_PROVISION_TEST_KEY",
        HAYASEND_FLY_APP: "hayasend-flyio-invalid-",
        HAYASEND_FLY_CREATE: "confirmed",
        HAYASEND_FLY_MPG_PLAN: "basic",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "must be a lowercase hayasend-flyio-* name",
      );
      expect(await readFile(fixture.log, "utf8")).toContain("version");
      expect(await readFile(fixture.log, "utf8")).not.toContain(
        "apps list",
      );
    });
  },
);
