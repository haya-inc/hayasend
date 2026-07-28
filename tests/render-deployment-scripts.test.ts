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
