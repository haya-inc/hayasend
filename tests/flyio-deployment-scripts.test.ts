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
const proofMachineName = "hayasend-proof-123456";

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
  sendgrid_secrets=''
  if [[ "\${FLY_FAKE_SENDGRID_SECRETS:-false}" == "true" ]]; then
    sendgrid_secrets=',{"name":"SENDGRID_API_KEY","digest":"i","status":"Deployed"},{"name":"SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY","digest":"j","status":"Deployed"}'
  fi
  printf '%s\\n' '[
    {"name":"AWS_ACCESS_KEY_ID","digest":"a","status":"Deployed"},
    {"name":"AWS_ENDPOINT_URL_S3","digest":"b","status":"Deployed"},
    {"name":"AWS_REGION","digest":"c","status":"Deployed"},
    {"name":"AWS_SECRET_ACCESS_KEY","digest":"d","status":"Deployed"},
    {"name":"BUCKET_NAME","digest":"e","status":"Deployed"},
    {"name":"HAYASEND_API_KEY","digest":"f","status":"'\${FLY_FAKE_SECRET_STATUS:-Deployed}'"},
    {"name":"HAYASEND_DATABASE_URL","digest":"g","status":"Deployed"},
    {"name":"HAYASEND_OBJECT_STORAGE_BUCKET","digest":"h","status":"Deployed"}
  '"$sendgrid_secrets"']'
elif [[ "\${1:-} \${2:-}" == "machine list" ]]; then
  machine_image="registry.fly.io/$HAYASEND_FLY_APP:deployment-test"
  machine_digest="\${FLY_FAKE_MACHINE_DIGEST:-$HAYASEND_FLY_MACHINE_IMAGE_DIGEST}"
  transport="\${HAYASEND_TRANSPORT:-console}"
  proof_guard=''
  deployment_guard=''
  if [[ "$transport" == "console" ]]; then
    proof_guard=',"HAYASEND_CONSOLE_PROOF_CONFIRM":"isolated-non-sending"'
  else
    deployment_guard=',"HAYASEND_DEPLOYMENT_PROFILE":"flyio-sendgrid"'
  fi
  extra=''
  if [[ "\${FLY_FAKE_EXTRA_MACHINE:-false}" == "true" ]]; then
    extra=',{"id":"extra","state":"started","image_ref":{"digest":"'"$machine_digest"'","labels":{"org.opencontainers.image.source":"https://github.com/haya-inc/hayasend","org.opencontainers.image.title":"HayaSend"}},"config":{"image":"'"$machine_image"'","metadata":{"fly_process_group":"extra"},"mounts":[]}}'
  fi
  proof=''
  if [[ -f "\${state}.proof-created" && ! -f "\${state}.proof-deleted" ]]; then
    proof=',{"id":"1234567890abcd","name":"'"$HAYASEND_FLY_PROOF_MACHINE_NAME"'","region":"nrt","state":"stopped","image_ref":{"digest":"'"$machine_digest"'","labels":{"org.opencontainers.image.source":"https://github.com/haya-inc/hayasend","org.opencontainers.image.title":"HayaSend"}},"config":{"image":"'"$machine_image"'","metadata":{"hayasend_proof":"portable-hosted-v1"},"env":{"HAYASEND_MODE":"portable","HAYASEND_RUNTIME_PROFILE":"portable-postgres","HAYASEND_TRANSPORT":"console","HAYASEND_CONSOLE_PROOF_CONFIRM":"isolated-non-sending","HAYASEND_OBJECT_STORAGE":"disabled","HAYASEND_HOSTED_PROOF_API_URL":"https://'"$HAYASEND_FLY_APP"'.fly.dev","HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS":"30","HAYASEND_HOSTED_PROOF_TIMEOUT_SECONDS":"300"},"mounts":[],"services":[]}}'
  fi
  printf '[{"id":"aaaaaaaaaaaaaa","state":"started","image_ref":{"digest":"%s","labels":{"org.opencontainers.image.source":"https://github.com/haya-inc/hayasend","org.opencontainers.image.title":"HayaSend"}},"config":{"image":"%s","env":{"HAYASEND_RUNTIME_PROFILE":"portable-postgres","HAYASEND_TRANSPORT":"%s"%s%s},"metadata":{"fly_process_group":"api"},"mounts":[]}},{"id":"bbbbbbbbbbbbbb","state":"started","image_ref":{"digest":"%s","labels":{"org.opencontainers.image.source":"https://github.com/haya-inc/hayasend","org.opencontainers.image.title":"HayaSend"}},"config":{"image":"%s","env":{"HAYASEND_RUNTIME_PROFILE":"portable-postgres","HAYASEND_TRANSPORT":"%s"%s%s},"metadata":{"fly_process_group":"worker"},"mounts":[]}}%s%s]\\n' \
    "$machine_digest" "$machine_image" "$transport" "$proof_guard" "$deployment_guard" \
    "$machine_digest" "$machine_image" "$transport" "$proof_guard" "$deployment_guard" \
    "$extra" "$proof"
elif [[ "\${1:-} \${2:-}" == "checks list" ]]; then
  printf '%s\\n' '{"api":[{"name":"servicecheck-00-http-8080","status":"passing"}]}'
elif [[ "\${1:-} \${2:-}" == "machine run" ]]; then
  : > "\${state}.proof-created"
  printf '%s\\n' \
    "Success! A Machine has been successfully launched in app $HAYASEND_FLY_APP" \
    " Machine ID: 1234567890abcd" \
    " Instance ID: instance-proof" \
    " State: started"
elif [[ "\${1:-} \${2:-}" == "machine wait" ]]; then
  printf '%s\\n' 'Machine 1234567890abcd reached state "stopped"'
elif [[ "\${1:-} \${2:-}" == "machine status" ]]; then
  printf '%s\\n' \
    "Machine ID: 1234567890abcd" \
    "exit_code=0,oom_killed=false,requested_stop=false"
elif [[ "\${1:-}" == "logs" ]]; then
  printf '%s\\n' '{"level":"info","instance":"1234567890abcd","message":"{\\"object\\":\\"portable_hosted_semantic_proof\\",\\"hayasend_version\\":\\"0.3.9\\",\\"database\\":{\\"major_version\\":17},\\"checks\\":{\\"scheduled_horizon_seconds\\":2592000,\\"atomic_delivery_commit\\":true,\\"idempotency_replay\\":true,\\"periodic_sweeper_recovered\\":true,\\"provider_acceptance_only\\":true,\\"terminal_delivery_claimed\\":false,\\"external_send_performed\\":false},\\"cleanup\\":{\\"complete\\":true,\\"fixture_rows_remaining\\":0}}","region":"nrt","timestamp":"2026-07-29T00:00:00Z"}'
elif [[ "\${1:-} \${2:-}" == "machine exec" ]]; then
  printf '%s\\n' '{"exit_code":0,"stdout":"{\\"object\\":\\"hayasend_flyio_bucket_inventory\\",\\"bucket\\":\\"'"$HAYASEND_FLY_BUCKET"'\\",\\"object_count\\":0,\\"empty\\":true}\\n"}'
elif [[ "\${1:-} \${2:-}" == "machine destroy" ]]; then
  : > "\${state}.proof-deleted"
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
          `--image ${image} --env HAYASEND_RUNTIME_PROFILE=portable-postgres ` +
          "--env HAYASEND_TRANSPORT=console " +
          "--env HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending " +
          "--strategy rolling " +
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

    it("requires SendGrid secrets only after explicit opt-in", async () => {
      const fixture = await fakeCommands();
      const result = run("verify.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_TRANSPORT: "sendgrid",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Required app secrets are missing or not fully deployed",
      );
    });

    it("accepts the explicit SendGrid transport when both secrets are deployed", async () => {
      const fixture = await fakeCommands();
      const result = run("verify.sh", fixture, {
        ...baseEnvironment,
        FLY_FAKE_SENDGRID_SECRETS: "true",
        HAYASEND_TRANSPORT: "sendgrid",
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("runs the shared semantic proof in one disposable exact Machine", async () => {
      const fixture = await fakeCommands();
      const proofFile = resolve(fixture.directory, "proof.json");
      const machineIdFile = resolve(
        fixture.directory,
        "proof-machine-id.txt",
      );
      const result = run("proof.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_FLY_PROOF_FILE: proofFile,
        HAYASEND_FLY_PROOF_MACHINE_ID_FILE: machineIdFile,
        HAYASEND_FLY_PROOF_MACHINE_NAME: proofMachineName,
      });
      const commands = await readFile(fixture.log, "utf8");
      const proof = JSON.parse(
        await readFile(proofFile, "utf8"),
      ) as {
        object: string;
        database: { major_version: number };
      };

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(commands).toContain(
        `machine run ${image} node dist/portable/hosted-proof.js`,
      );
      expect(commands).toContain(
        `--name ${proofMachineName} --region nrt --detach`,
      );
      expect(commands).toContain(
        "--env HAYASEND_RUNTIME_PROFILE=portable-postgres",
      );
      expect(commands).toContain(
        "--env HAYASEND_TRANSPORT=console",
      );
      expect(commands).toContain(
        "--env HAYASEND_OBJECT_STORAGE=disabled",
      );
      expect(commands).toContain(
        "machine wait 1234567890abcd " +
          `--app ${app} --state stopped --wait-timeout 10m`,
      );
      expect(commands).toContain(
        `logs --app ${app} --machine 1234567890abcd --no-tail --json`,
      );
      expect(commands).toContain(
        `machine destroy 1234567890abcd --app ${app} --force`,
      );
      expect(await readFile(machineIdFile, "utf8")).toBe(
        "1234567890abcd\n",
      );
      expect(proof).toMatchObject({
        object: "portable_hosted_semantic_proof",
        database: { major_version: 17 },
      });
    });

    it("authenticates inside the exact API Machine to prove Tigris is empty", async () => {
      const fixture = await fakeCommands();
      const evidenceFile = resolve(
        fixture.directory,
        "bucket-evidence.json",
      );
      const result = run("verify-bucket-empty.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_FLY_BUCKET_EVIDENCE_FILE: evidenceFile,
      });
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(commands).toContain(
        `machine exec aaaaaaaaaaaaaa node --input-type=module`,
      );
      expect(commands).toContain(
        `--app ${app} --timeout 120 --json`,
      );
      expect(
        JSON.parse(await readFile(evidenceFile, "utf8")),
      ).toEqual({
        object: "hayasend_flyio_bucket_inventory",
        bucket,
        object_count: 0,
        empty: true,
      });
    });

    it("rolls back by redeploying an older immutable image without rerunning migrations", async () => {
      const fixture = await fakeCommands();
      const result = run("rollback.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_ALLOW_ROLLBACK: "flyio",
        HAYASEND_ROLLBACK_IMAGE: rollbackImage,
        HAYASEND_ROLLBACK_MACHINE_IMAGE_DIGEST:
          rollbackMachineImageDigest,
      });
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(commands).toContain(
        `--image ${rollbackImage} ` +
          "--env HAYASEND_RUNTIME_PROFILE=portable-postgres " +
          "--env HAYASEND_TRANSPORT=console " +
          "--env HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending " +
          "--strategy rolling " +
          "--skip-release-command --ha=false --yes",
      );
      expect(result.stdout).toContain(
        "rolled back to the reviewed immutable image",
      );
    });

    it("refuses rollback without the exact operator guard", async () => {
      const fixture = await fakeCommands();
      const result = run("rollback.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_ROLLBACK_IMAGE: rollbackImage,
        HAYASEND_ROLLBACK_MACHINE_IMAGE_DIGEST:
          rollbackMachineImageDigest,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Set HAYASEND_ALLOW_ROLLBACK=flyio",
      );
      expect(await readFile(fixture.log, "utf8")).toBe("");
    });

    it("rejects an invented console proof confirmation", async () => {
      const fixture = await fakeCommands();
      const result = run("deploy.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_CONSOLE_PROOF_CONFIRM: "sending-disabled",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "must equal isolated-non-sending",
      );
      expect(await readFile(fixture.log, "utf8")).toBe("version\n");
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
