#!/usr/bin/env bash
set -euo pipefail

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
render_cli="${RENDER_CLI:-render}"
required_version="$(<"$deployment_directory/.render-cli-version")"
installed_version="$("$render_cli" --version | sed -n '1s/^render v//p')"
if [[ "$installed_version" != "$required_version" ]]; then
  echo "Render CLI $required_version is required; found ${installed_version:-unknown}." >&2
  exit 1
fi

: "${RENDER_API_KEY:?Set RENDER_API_KEY through the secret environment.}"
: "${RENDER_API_SERVICE_ID:?Set RENDER_API_SERVICE_ID to the exact srv-* ID.}"
: "${HAYASEND_RENDER_API_URL:?Set HAYASEND_RENDER_API_URL to the API HTTPS origin.}"
: "${HAYASEND_RENDER_PROOF_FILE:?Set HAYASEND_RENDER_PROOF_FILE to a private output path.}"

if [[ ! "$RENDER_API_SERVICE_ID" =~ ^srv-[a-z0-9]+$ ]]; then
  echo "RENDER_API_SERVICE_ID must be an exact srv-* ID." >&2
  exit 1
fi
if [[ ! "$HAYASEND_RENDER_API_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo "HAYASEND_RENDER_API_URL must be an HTTPS origin without a path." >&2
  exit 1
fi

start_command="$(
  printf '%s' \
    "env HAYASEND_HOSTED_PROOF_API_URL=$HAYASEND_RENDER_API_URL " \
    "HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS=30 " \
    "HAYASEND_HOSTED_PROOF_TIMEOUT_SECONDS=300 " \
    "node dist/portable/hosted-proof.js"
)"
job="$(
  "$render_cli" jobs create "$RENDER_API_SERVICE_ID" \
    --start-command "$start_command" \
    --confirm \
    --output json
)"
job_id="$(jq --raw-output '.id // empty' <<<"$job")"
created_at="$(jq --raw-output '.createdAt // empty' <<<"$job")"
if [[ ! "$job_id" =~ ^job-[a-z0-9]{20}$ ]] ||
  [[ ! "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]; then
  echo "Render did not return an exact one-off proof job identity." >&2
  exit 1
fi

status=""
for _ in {1..120}; do
  jobs="$(
    "$render_cli" jobs list "$RENDER_API_SERVICE_ID" \
      --output json
  )"
  status="$(
    jq --raw-output \
      --arg id "$job_id" \
      '[.[] | select(.id == $id) | .status] |
        if length == 1 then .[0] else empty end' \
      <<<"$jobs"
  )"
  case "$status" in
    succeeded)
      break
      ;;
    canceled | failed)
      echo "Render proof job ended with status $status." >&2
      exit 1
      ;;
    pending | running | "")
      sleep 5
      ;;
    *)
      echo "Render proof job returned an unknown status." >&2
      exit 1
      ;;
  esac
done
if [[ "$status" != "succeeded" ]]; then
  echo "Render proof job did not succeed within ten minutes." >&2
  exit 1
fi

raw_logs="$(mktemp "${TMPDIR:-/tmp}/hayasend-render-proof.XXXXXX")"
combined_logs="$(mktemp "${TMPDIR:-/tmp}/hayasend-render-proof-text.XXXXXX")"
cleanup_proof_logs() {
  : >"$raw_logs"
  : >"$combined_logs"
  rm -f -- "$raw_logs" "$combined_logs"
}
trap cleanup_proof_logs EXIT
proof_ready=false
for _ in {1..60}; do
  "$render_cli" logs \
    --resources "$job_id" \
    --start "$created_at" \
    --direction forward \
    --limit 500 \
    --output json \
    >"$raw_logs"
  jq --slurp --raw-output \
    '[.[] | .message // empty] | join("\n")' \
    "$raw_logs" >"$combined_logs"
  if node "$deployment_directory/../../scripts/extract-portable-hosted-proof.mjs" \
    <"$combined_logs" \
    >"$HAYASEND_RENDER_PROOF_FILE" 2>/dev/null; then
    proof_ready=true
    break
  fi
  sleep 2
done
if [[ "$proof_ready" != "true" ]]; then
  echo "Privacy-safe proof JSON did not become readable from the exact Render job." >&2
  exit 1
fi

jq --exit-status \
  '.object == "portable_hosted_semantic_proof" and
    .hayasend_version == "0.3.8" and
    .database.major_version == 18 and
    .checks.scheduled_horizon_seconds == 2592000 and
    .checks.atomic_delivery_commit == true and
    .checks.idempotency_replay == true and
    .checks.periodic_sweeper_recovered == true and
    .checks.provider_acceptance_only == true and
    .checks.terminal_delivery_claimed == false and
    .checks.external_send_performed == false and
    .cleanup.complete == true and
    .cleanup.fixture_rows_remaining == 0' \
  "$HAYASEND_RENDER_PROOF_FILE" >/dev/null

echo "Render one-off job $job_id produced the reviewed privacy-safe semantic proof."
