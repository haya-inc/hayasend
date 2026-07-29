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

const deploymentDirectory = resolve("deploy/render");
const image =
  "ghcr.io/haya-inc/hayasend@sha256:" +
  "0123456789abcdef".repeat(4);
const rollbackImage =
  "ghcr.io/haya-inc/hayasend@sha256:" +
  "fedcba9876543210".repeat(4);

async function fakeCommands() {
  const directory = await mkdtemp(
    resolve(tmpdir(), "hayasend-render-test-"),
  );
  const log = resolve(directory, "commands.log");
  const render = resolve(directory, "render");
  const curl = resolve(directory, "curl");
  await writeFile(log, "");
  await writeFile(
    render,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RENDER_TEST_LOG"
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "render v2.22.0"
elif [[ "\${1:-} \${2:-}" == "deploys list" ]]; then
  printf '[{"image":{"ref":"%s"}}]\\n' "$HAYASEND_IMAGE"
elif [[ "\${1:-} \${2:-}" == "jobs create" ]]; then
  printf '%s\\n' '{"id":"job-1234567890abcdefghij","createdAt":"2026-07-29T00:00:00Z","status":"pending"}'
elif [[ "\${1:-} \${2:-}" == "jobs list" ]]; then
  printf '%s\\n' '[{"id":"job-1234567890abcdefghij","createdAt":"2026-07-29T00:00:00Z","status":"succeeded"}]'
elif [[ "\${1:-}" == "logs" ]]; then
  printf '%s' '{"id":"log-proof","labels":[],"message":"{\\"object\\":\\"portable_hosted_semantic_proof\\",\\"hayasend_version\\":\\"0.3.1\\",\\"database\\":{\\"major_version\\":18},\\"checks\\":{\\"scheduled_horizon_seconds\\":2592000,\\"atomic_delivery_commit\\":true,\\"idempotency_replay\\":true,\\"periodic_sweeper_recovered\\":true,\\"provider_acceptance_only\\":true,\\"terminal_delivery_claimed\\":false,\\"external_send_performed\\":false},\\"cleanup\\":{\\"complete\\":true,\\"fixture_rows_remaining\\":0}}","timestamp":"2026-07-29T00:00:01Z"}'
elif [[ "\${1:-}" == "services" && "\${2:-}" == "--include-previews" ]]; then
  printf '%s\\n' '[]'
elif [[ "\${1:-} \${2:-}" == "postgres list" ]]; then
  printf '%s\\n' '[]'
else
  printf '%s\\n' '{}'
fi
`,
  );
  await writeFile(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >> "$RENDER_TEST_LOG"
`,
  );
  await chmod(render, 0o755);
  await chmod(curl, 0o755);
  return { directory, log, render };
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
      RENDER_CLI: fixture.render,
      RENDER_TEST_LOG: fixture.log,
    },
  });
}

describe.skipIf(process.platform === "win32")(
  "Render deployment scripts",
  () => {
    it("declares the portable runtime on both long-running services", async () => {
      const blueprint = await readFile(
        resolve(deploymentDirectory, "render.yaml"),
        "utf8",
      );

      expect(
        blueprint.match(/key: HAYASEND_RUNTIME_PROFILE/g),
      ).toHaveLength(2);
      expect(
        blueprint.match(/value: portable-postgres/g),
      ).toHaveLength(2);
    });

    it("deploys the API before the worker and verifies readiness", async () => {
      const fixture = await fakeCommands();
      const result = run("deploy.sh", fixture, {
        HAYASEND_IMAGE: image,
        HAYASEND_RENDER_API_URL:
          "https://hayasend-api.onrender.com",
        RENDER_API_SERVICE_ID: "srv-api123",
        RENDER_WORKER_SERVICE_ID: "srv-worker123",
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(await readFile(fixture.log, "utf8")).toBe(
        [
          "--version",
          `deploys create srv-api123 --image ${image} --wait --confirm --output json`,
          "curl --fail --silent --show-error https://hayasend-api.onrender.com/readyz",
          `deploys create srv-worker123 --image ${image} --wait --confirm --output json`,
          "curl --fail --silent --show-error https://hayasend-api.onrender.com/readyz",
          "",
        ].join("\n"),
      );
    });

    it("verifies both deploy histories and health surfaces", async () => {
      const fixture = await fakeCommands();
      const result = run("verify.sh", fixture, {
        HAYASEND_IMAGE: image,
        HAYASEND_RENDER_API_URL:
          "https://hayasend-api.onrender.com",
        RENDER_API_SERVICE_ID: "srv-api123",
        RENDER_WORKER_SERVICE_ID: "srv-worker123",
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(await readFile(fixture.log, "utf8")).toContain(
        "deploys list srv-api123 --output json",
      );
      expect(await readFile(fixture.log, "utf8")).toContain(
        "deploys list srv-worker123 --output json",
      );
      expect(await readFile(fixture.log, "utf8")).toContain(
        "https://hayasend-api.onrender.com/healthz",
      );
      expect(await readFile(fixture.log, "utf8")).toContain(
        "https://hayasend-api.onrender.com/readyz",
      );
    });

    it("rolls back both services to one reviewed immutable image", async () => {
      const fixture = await fakeCommands();
      const result = run("rollback.sh", fixture, {
        HAYASEND_ALLOW_ROLLBACK: "render",
        HAYASEND_IMAGE: image,
        HAYASEND_RENDER_API_URL:
          "https://hayasend-api.onrender.com",
        HAYASEND_ROLLBACK_IMAGE: rollbackImage,
        RENDER_API_SERVICE_ID: "srv-api123",
        RENDER_WORKER_SERVICE_ID: "srv-worker123",
      });
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(commands).toContain(
        `deploys create srv-api123 --image ${rollbackImage}`,
      );
      expect(commands).toContain(
        `deploys create srv-worker123 --image ${rollbackImage}`,
      );
      expect(commands).toContain(
        "deploys list srv-api123 --output json",
      );
      expect(result.stdout).toContain(
        "preserves forward migrations",
      );
    });

    it("refuses rollback without the exact operator guard", async () => {
      const fixture = await fakeCommands();
      const result = run("rollback.sh", fixture, {
        HAYASEND_ROLLBACK_IMAGE: rollbackImage,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Set HAYASEND_ALLOW_ROLLBACK=render",
      );
      expect(await readFile(fixture.log, "utf8")).toBe("");
    });

    it("runs the shared semantic proof as an exact one-off API job", async () => {
      const fixture = await fakeCommands();
      const proofFile = resolve(fixture.directory, "proof.json");
      const result = run("proof.sh", fixture, {
        HAYASEND_RENDER_API_URL:
          "https://hayasend-api.onrender.com",
        HAYASEND_RENDER_PROOF_FILE: proofFile,
        RENDER_API_KEY: "rnd_render_test_key",
        RENDER_API_SERVICE_ID: "srv-api123",
      });
      const commands = await readFile(fixture.log, "utf8");
      const proof = JSON.parse(await readFile(proofFile, "utf8")) as {
        object: string;
      };

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(commands).toContain(
        "jobs create srv-api123 --start-command " +
          "env HAYASEND_HOSTED_PROOF_API_URL=https://hayasend-api.onrender.com " +
          "HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS=30 " +
          "HAYASEND_HOSTED_PROOF_TIMEOUT_SECONDS=300 " +
          "node dist/portable/hosted-proof.js",
      );
      expect(commands).toContain("jobs list srv-api123 --output json");
      expect(commands).toContain(
        "logs --resources job-1234567890abcdefghij " +
          "--start 2026-07-29T00:00:00Z",
      );
      expect(proof.object).toBe("portable_hosted_semantic_proof");
    });

    it("deletes only exact guarded resource identifiers", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, {
        HAYASEND_ALLOW_DESTROY: "render",
        HAYASEND_RENDER_BLUEPRINT_UNLINKED: "true",
        RENDER_API_SERVICE_ID: "srv-api123",
        RENDER_POSTGRES_ID: "dpg-postgres123",
        RENDER_WORKER_SERVICE_ID: "srv-worker123",
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(await readFile(fixture.log, "utf8")).toBe(
        [
          "--version",
          "services delete srv-worker123 --confirm --output json",
          "services delete srv-api123 --confirm --output json",
          "postgres delete dpg-postgres123 --confirm --output json",
          "services --include-previews --output json",
          "postgres list --output json",
          "",
        ].join("\n"),
      );
    });

    it("refuses cleanup without explicit destructive guards", async () => {
      const fixture = await fakeCommands();
      const result = run("cleanup.sh", fixture, {});

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Set HAYASEND_ALLOW_DESTROY=render",
      );
      expect(await readFile(fixture.log, "utf8")).toBe("");
    });
  },
);
