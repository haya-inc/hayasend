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

const deploymentDirectory = resolve("deploy/cloud-run");

async function fakeGcloud() {
  const directory = await mkdtemp(
    resolve(tmpdir(), "hayasend-cloud-run-test-"),
  );
  const executable = resolve(directory, "gcloud");
  const log = resolve(directory, "commands.log");
  await writeFile(log, "");
  await writeFile(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GCLOUD_TEST_LOG"
if [[ "$*" == "projects get-iam-policy "* ]]; then
  if [[ -n "\${GCLOUD_TEST_IAM_RESIDUE:-}" ]]; then
    printf '%s\\n' \
      '{"bindings":[{"members":["deleted:serviceAccount:hayasend-api@hayasend-test-project.iam.gserviceaccount.com?uid=123"]}]}'
  else
    printf '%s\\n' '{"bindings":[]}'
  fi
elif [[ -n "\${GCLOUD_TEST_RESIDUE_MATCH:-}" ]] &&
  [[ "$*" == *"$GCLOUD_TEST_RESIDUE_MATCH"* ]]; then
  printf '%s\\n' 'projects/hayasend-test-project/topics/hayasend-wakeup'
fi
`,
  );
  await chmod(executable, 0o755);
  return { directory, log };
}

function verify(
  fixture: Awaited<ReturnType<typeof fakeGcloud>>,
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    resolve(deploymentDirectory, "verify-zero-residue.sh"),
    {
      cwd: deploymentDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        ...environment,
        PATH: `${fixture.directory}${delimiter}${process.env.PATH ?? ""}`,
        GCLOUD_TEST_LOG: fixture.log,
        TF_VAR_project_id: "hayasend-test-project",
      },
    },
  );
}

describe.skipIf(process.platform === "win32")(
  "Cloud Run zero-residue verification",
  () => {
    it("ships an opt-in console-only proof job with secret mounts", async () => {
      const main = await readFile(
        resolve(deploymentDirectory, "main.tf"),
        "utf8",
      );
      const locals = await readFile(
        resolve(deploymentDirectory, "locals.tf"),
        "utf8",
      );

      expect(main).toContain(
        'resource "google_cloud_run_v2_job" "hosted_proof"',
      );
      expect(main).toContain(
        "count = var.enable_hosted_proof_job ? 1 : 0",
      );
      expect(main).toContain(
        'args    = ["dist/portable/hosted-proof.js"]',
      );
      expect(main).toContain(
        'name       = "api-key"',
      );
      expect(main).toContain(
        'check "hosted_proof_job_safety"',
      );
      expect(locals).toContain(
        'HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS   = "30"',
      );
      expect(locals).toContain(
        'HAYASEND_TRANSPORT                    = "console"',
      );
    });

    it("can destroy partial disposable state without applying missing resources", async () => {
      const cleanup = await readFile(
        resolve(deploymentDirectory, "cleanup.sh"),
        "utf8",
      );

      expect(cleanup).toContain(
        'HAYASEND_CLOUD_RUN_ALLOW_PARTIAL:-false',
      );
      expect(cleanup).toContain(
        'if [[ -z "$(terraform state list)" ]]',
      );
      expect(cleanup).toContain(
        "terraform destroy -input=false",
      );
    });

    it("checks every managed resource family including Pub/Sub and IAM", async () => {
      const fixture = await fakeGcloud();
      const result = verify(fixture);
      const commands = await readFile(fixture.log, "utf8");

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Verified zero HayaSend residue",
      );
      expect(commands).toContain("run services list");
      expect(commands).toContain("run jobs list");
      expect(commands).toContain("run worker-pools list");
      expect(commands).toContain("sql instances list");
      expect(commands).toContain("storage buckets list");
      expect(commands).toContain("secrets list");
      expect(commands).toContain("iam service-accounts list");
      expect(commands).toContain("compute networks list");
      expect(commands).toContain("compute addresses list");
      expect(commands).toContain("pubsub topics list");
      expect(commands).toContain("pubsub subscriptions list");
      expect(commands).toContain("projects get-iam-policy");
    });

    it("fails closed when a Pub/Sub resource remains", async () => {
      const fixture = await fakeGcloud();
      const result = verify(fixture, {
        GCLOUD_TEST_RESIDUE_MATCH: "pubsub topics list",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Pub/Sub topic residue remains");
      expect(result.stdout).not.toContain(
        "projects/hayasend-test-project/topics",
      );
    });

    it("detects deleted workload identities that remain in project IAM", async () => {
      const fixture = await fakeGcloud();
      const result = verify(fixture, {
        GCLOUD_TEST_IAM_RESIDUE: "true",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "HayaSend workload IAM bindings remain",
      );
      expect(result.stdout).not.toContain(
        "hayasend-api@hayasend-test-project",
      );
    });

    it("rejects unsafe project and prefix values before calling gcloud", async () => {
      const fixture = await fakeGcloud();
      const result = verify(fixture, {
        TF_VAR_name_prefix: "../private",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a safe HayaSend prefix");
      expect(await readFile(fixture.log, "utf8")).toBe("");
    });
  },
);
