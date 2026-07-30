#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=deploy/flyio/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_flyctl
require_transport
require_resource_inputs
require_image
require_proof_machine_name
: "${HAYASEND_FLY_PROOF_FILE:?Set a private output path for the semantic proof.}"

if [[ "$HAYASEND_TRANSPORT" != "console" ]]; then
  echo "The hosted semantic proof requires the deployed console transport." >&2
  exit 1
fi

assert_app_inventory
assert_mpg_inventory
assert_bucket_inventory
assert_secret_names true
assert_machine_inventory

existing="$(
  "$fly_cli" machine list \
    --app "$HAYASEND_FLY_APP" \
    --json
)"
if jq --exit-status \
  --arg name "$HAYASEND_FLY_PROOF_MACHINE_NAME" \
  'any(.[]; .name == $name)' \
  <<<"$existing" >/dev/null; then
  echo "The exact disposable proof Machine name already exists." >&2
  exit 1
fi

private_directory="$(mktemp -d "${TMPDIR:-/tmp}/hayasend-flyio-proof.XXXXXX")"
chmod 700 "$private_directory"
machine_id=""
cleanup_proof() {
  local cleanup_status=0
  if [[ -n "$machine_id" ]]; then
    HAYASEND_ALLOW_DESTROY=flyio-proof-machine \
      HAYASEND_FLY_DEDICATED_APP=true \
      "$pack_directory/cleanup-proof-machine.sh" ||
      cleanup_status=$?
  fi
  find "$private_directory" -type f -exec sh -c ': > "$1"' _ {} \;
  find "$private_directory" -depth -delete
  return "$cleanup_status"
}
trap cleanup_proof EXIT

run_output="$(
  "$fly_cli" machine run "$HAYASEND_IMAGE" \
    node dist/portable/hosted-proof.js \
    --app "$HAYASEND_FLY_APP" \
    --name "$HAYASEND_FLY_PROOF_MACHINE_NAME" \
    --region nrt \
    --detach \
    --restart no \
    --autostart=false \
    --autostop off \
    --skip-dns-registration \
    --vm-size shared-cpu-1x \
    --vm-memory 512mb \
    --metadata hayasend_proof=portable-hosted-v1 \
    --env HAYASEND_MODE=portable \
    --env HAYASEND_RUNTIME_PROFILE=portable-postgres \
    --env HAYASEND_TRANSPORT=console \
    --env HAYASEND_CONSOLE_PROOF_CONFIRM=isolated-non-sending \
    --env HAYASEND_OBJECT_STORAGE=disabled \
    --env "HAYASEND_HOSTED_PROOF_API_URL=https://${HAYASEND_FLY_APP}.fly.dev" \
    --env HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS=30 \
    --env HAYASEND_HOSTED_PROOF_TIMEOUT_SECONDS=300
)"
printf '%s\n' "$run_output" >"$private_directory/machine-run.txt"
machine_id="$(
  sed -n 's/^ Machine ID: \([a-f0-9]\{14\}\)$/\1/p' \
    <<<"$run_output"
)"
if [[ ! "$machine_id" =~ ^[a-f0-9]{14}$ ]]; then
  echo "flyctl did not return one exact disposable proof Machine ID." >&2
  exit 1
fi
if [[ -n "${HAYASEND_FLY_PROOF_MACHINE_ID_FILE:-}" ]]; then
  (
    umask 077
    printf '%s\n' "$machine_id" \
      >"$HAYASEND_FLY_PROOF_MACHINE_ID_FILE"
  )
fi

reviewed="$(proof_machine_inventory)"
if ! jq --exit-status \
  --arg id "$machine_id" \
  'length == 1 and .[0].id == $id' \
  <<<"$reviewed" >/dev/null; then
  echo "The created Fly Machine does not match the reviewed proof definition." >&2
  exit 1
fi

"$fly_cli" machine wait "$machine_id" \
  --app "$HAYASEND_FLY_APP" \
  --state stopped \
  --wait-timeout 10m
"$fly_cli" machine status "$machine_id" \
  --app "$HAYASEND_FLY_APP" \
  >"$private_directory/machine-status.txt"
if ! grep --extended-regexp --quiet \
  'exit_code=0,oom_killed=false,requested_stop=false' \
  "$private_directory/machine-status.txt"; then
  echo "The disposable Fly Machine did not exit cleanly." >&2
  exit 1
fi

proof_ready=false
for _ in {1..60}; do
  "$fly_cli" logs \
    --app "$HAYASEND_FLY_APP" \
    --machine "$machine_id" \
    --no-tail \
    --json \
    >"$private_directory/logs.json"
  jq --slurp --raw-output \
    '[.[] | .message // empty] | join("\n")' \
    "$private_directory/logs.json" \
    >"$private_directory/logs.txt"
  if node "$pack_directory/../../scripts/extract-portable-hosted-proof.mjs" \
    <"$private_directory/logs.txt" \
    >"$HAYASEND_FLY_PROOF_FILE" 2>/dev/null; then
    proof_ready=true
    break
  fi
  sleep 2
done
if [[ "$proof_ready" != "true" ]]; then
  echo "Privacy-safe proof JSON did not become readable from the exact Fly Machine." >&2
  exit 1
fi

jq --exit-status \
  '.object == "portable_hosted_semantic_proof" and
    .hayasend_version == "0.3.4" and
    .database.major_version == 17 and
    .checks.scheduled_horizon_seconds == 2592000 and
    .checks.atomic_delivery_commit == true and
    .checks.idempotency_replay == true and
    .checks.periodic_sweeper_recovered == true and
    .checks.provider_acceptance_only == true and
    .checks.terminal_delivery_claimed == false and
    .checks.external_send_performed == false and
    .cleanup.complete == true and
    .cleanup.fixture_rows_remaining == 0' \
  "$HAYASEND_FLY_PROOF_FILE" >/dev/null

echo "Fly.io Machine $machine_id produced the reviewed privacy-safe PostgreSQL 17 semantic proof."
