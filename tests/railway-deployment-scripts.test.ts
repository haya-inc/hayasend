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

const deploymentDirectory = resolve("deploy/railway");
const image =
  "ghcr.io/haya-inc/hayasend@sha256:" +
  "0123456789abcdef".repeat(4);
const projectId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const apiUrl =
  "https://hayasend-api-production.up.railway.app";
const apiKey = "re_RAILWAY_DEPLOYMENT_TEST_KEY";
async function fakeCommands() {
  const directory = await mkdtemp(
    resolve(tmpdir(), "hayasend-railway-test-"),
  );
  const log = resolve(directory, "commands.log");
  const railway = resolve(directory, "railway");
  const curl = resolve(directory, "curl");
  await writeFile(log, "");
  await writeFile(
    railway,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RAILWAY_TEST_LOG"
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "railway 5.30.1"
elif [[ "\${1:-} \${2:-}" == "config plan" ]]; then
  if [[ "\${RAILWAY_FAKE_PLAN_DRIFT:-false}" == "true" ]]; then
    printf '%s\\n' '{"ok":true,"changeSet":{"changes":[{"severity":"safe"}]}}'
    exit 2
  fi
  printf '%s\\n' '{"ok":true,"changeSet":{"changes":[]}}'
elif [[ "\${1:-} \${2:-}" == "deployment list" ]]; then
  printf '[{"id":"deployment-id","status":"SUCCESS","meta":{"image":"%s"}}]\\n' \
    "\${RAILWAY_FAKE_IMAGE:-$HAYASEND_IMAGE}"
elif [[ "\${1:-}" == "status" ]]; then
  if [[ "\${RAILWAY_FAKE_EXTRA_SERVICE:-false}" == "true" ]]; then
    extra=',{"node":{"name":"unrelated"}}'
  else
    extra=''
  fi
  if [[ "\${RAILWAY_FAKE_PARTIAL:-false}" == "true" ]]; then
    services='[{"node":{"name":"hayasend-api"}}]'
    buckets='[]'
  else
    services='[{"node":{"name":"hayasend-api"}},{"node":{"name":"hayasend-postgres"}},{"node":{"name":"hayasend-worker"}}'"$extra"']'
    buckets='[{"node":{"name":"hayasend-attachments"}}]'
  fi
  printf '{"id":"%s","name":"hayasend-railway","services":{"edges":%s},"buckets":{"edges":%s}}\\n' \
    "$HAYASEND_RAILWAY_PROJECT_ID" "$services" "$buckets"
elif [[ "\${1:-} \${2:-}" == "environment list" ]]; then
  if [[ "\${RAILWAY_FAKE_EXTRA_ENVIRONMENT:-false}" == "true" ]]; then
    extra_environment=',{"id":"33333333-3333-4333-8333-333333333333","name":"staging","isEphemeral":false}'
  else
    extra_environment=''
  fi
  printf '{"environments":[{"id":"%s","name":"production","isEphemeral":false}%s]}\\n' \
    "$HAYASEND_RAILWAY_ENVIRONMENT_ID" "$extra_environment"
elif [[ "\${1:-} \${2:-}" == "bucket info" ]]; then
  printf '{"id":"bucket-id","name":"hayasend-attachments","region":"sin","objects":%s}\\n' \
    "\${RAILWAY_FAKE_BUCKET_OBJECTS:-0}"
elif [[ "\${1:-} \${2:-}" == "domain list" ]]; then
  printf '%s\\n' '{"domains":[{"domain":"hayasend-api-production.up.railway.app","type":"service"}]}'
elif [[ "\${1:-}" == "domain" ]]; then
  printf '%s\\n' '{"domain":"https://hayasend-api-production.up.railway.app"}'
elif [[ "\${1:-}" == "list" ]]; then
  if [[ "\${RAILWAY_FAKE_PROJECT_REMAINS:-false}" == "true" ]]; then
    printf '[{"id":"%s","name":"hayasend-railway"}]\\n' \
      "$HAYASEND_RAILWAY_PROJECT_ID"
  else
    printf '%s\\n' '[]'
  fi
else
  printf '%s\\n' '{}'
fi
`,
  );
  await writeFile(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >> "$RAILWAY_TEST_LOG"
`,
  );
  await chmod(railway, 0o755);
  await chmod(curl, 0o755);
  return { directory, log, railway };
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
      RAILWAY_CLI: fixture.railway,
      RAILWAY_TEST_LOG: fixture.log,
    },
  });
}

const baseEnvironment = {
  HAYASEND_API_KEY: apiKey,
  HAYASEND_IMAGE: image,
  HAYASEND_RAILWAY_API_URL: apiUrl,
  HAYASEND_RAILWAY_ENVIRONMENT_ID: environmentId,
  HAYASEND_RAILWAY_PROJECT_ID: projectId,
  HAYASEND_RAILWAY_WORKSPACE_ID: workspaceId,
};

describe.skipIf(process.platform === "win32")(
  "Railway deployment scripts",
  () => {
    it("applies only a non-destructive plan and verifies the deployed graph", async () => {
      const fixture = await fakeCommands();
      const result = run("deploy.sh", fixture, baseEnvironment);
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `HayaSend Railway API: ${apiUrl}`,
      );
      expect(commands).toContain(
        `config apply --file ${deploymentDirectory}/.railway/railway.ts --yes --json`,
      );
      expect(commands).toContain(
        `--workspace ${workspaceId}`,
      );
      expect(commands).not.toContain("--confirm-destructive");
      expect(commands).not.toContain(apiKey);
      expect(commands.indexOf("config apply")).toBeLessThan(
        commands.indexOf(
          "deployment list --project",
        ),
      );
      expect(commands).toContain(
        "domain --project " +
          `${projectId} --environment ${environmentId} ` +
          "--service hayasend-api --port 8787 --json",
      );
      expect(commands).toContain(`${apiUrl}/healthz`);
      expect(commands).toContain(`${apiUrl}/readyz`);
    });

    it("rejects a successful deployment whose metadata has another image", async () => {
      const fixture = await fakeCommands();
      const result = run("verify.sh", fixture, {
        ...baseEnvironment,
        RAILWAY_FAKE_IMAGE:
          "ghcr.io/haya-inc/hayasend@sha256:" +
          "fedcba9876543210".repeat(4),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "not successful on the expected image",
      );
    });

    it("requires SendGrid credentials only after explicit opt-in", async () => {
      const fixture = await fakeCommands();
      const result = run("deploy.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_TRANSPORT: "sendgrid",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Set SENDGRID_API_KEY");
      expect(await readFile(fixture.log, "utf8")).toBe("--version\n");
    });

    it("deletes only the exact empty dedicated project", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_ALLOW_DESTROY: "railway",
        HAYASEND_RAILWAY_DEDICATED_PROJECT: "true",
      });
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(commands).toContain("environment list --json");
      expect(commands).toContain(
        `delete --project ${projectId} --yes --json`,
      );
      expect(result.stdout).toContain(
        "absent from project inventory",
      );
    });

    it("refuses cleanup without both destructive guards", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, baseEnvironment);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Set HAYASEND_ALLOW_DESTROY=railway",
      );
      expect(await readFile(fixture.log, "utf8")).toBe("");
    });

    it("refuses cleanup when the dedicated project contains another service", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_ALLOW_DESTROY: "railway",
        HAYASEND_RAILWAY_DEDICATED_PROJECT: "true",
        RAILWAY_FAKE_EXTRA_SERVICE: "true",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "not an isolated HayaSend Railway project",
      );
      expect(await readFile(fixture.log, "utf8")).not.toContain(
        `delete --project ${projectId}`,
      );
    });

    it("deletes an allowed partial graph after a failed deployment", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_ALLOW_DESTROY: "railway",
        HAYASEND_RAILWAY_ALLOW_PARTIAL: "true",
        HAYASEND_RAILWAY_DEDICATED_PROJECT: "true",
        RAILWAY_FAKE_PARTIAL: "true",
      });
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(commands).not.toContain("bucket info");
      expect(commands).toContain(
        `delete --project ${projectId} --yes --json`,
      );
    });

    it("refuses cleanup when another environment exists", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, {
        ...baseEnvironment,
        HAYASEND_ALLOW_DESTROY: "railway",
        HAYASEND_RAILWAY_ALLOW_PARTIAL: "true",
        HAYASEND_RAILWAY_DEDICATED_PROJECT: "true",
        RAILWAY_FAKE_EXTRA_ENVIRONMENT: "true",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "only the exact non-ephemeral production environment",
      );
      expect(await readFile(fixture.log, "utf8")).not.toContain(
        `delete --project ${projectId}`,
      );
    });
  },
);
