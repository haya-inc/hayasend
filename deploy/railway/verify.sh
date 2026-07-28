#!/usr/bin/env bash
set -euo pipefail

pack_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
railway_cli="${RAILWAY_CLI:-railway}"
required_version="$(<"$pack_directory/.railway-cli-version")"
installed_version="$("$railway_cli" --version | sed -n '1s/^railway //p')"
if [[ "$installed_version" != "$required_version" ]]; then
  echo "Railway CLI $required_version is required; found ${installed_version:-unknown}." >&2
  exit 1
fi

: "${HAYASEND_RAILWAY_PROJECT_ID:?Set HAYASEND_RAILWAY_PROJECT_ID to the dedicated project UUID.}"
: "${HAYASEND_RAILWAY_ENVIRONMENT_ID:?Set HAYASEND_RAILWAY_ENVIRONMENT_ID to the exact environment UUID.}"
: "${HAYASEND_RAILWAY_API_URL:?Set HAYASEND_RAILWAY_API_URL to the API HTTPS origin.}"
: "${HAYASEND_IMAGE:?Set HAYASEND_IMAGE to the expected immutable image digest.}"
: "${HAYASEND_API_KEY:?Set HAYASEND_API_KEY to the deployed re_ key so IaC drift can be checked.}"

uuid_pattern='^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
if [[ ! "$HAYASEND_RAILWAY_PROJECT_ID" =~ $uuid_pattern ]] ||
  [[ ! "$HAYASEND_RAILWAY_ENVIRONMENT_ID" =~ $uuid_pattern ]]; then
  echo "Railway project and environment identifiers must be exact lowercase UUIDs." >&2
  exit 1
fi
if [[ ! "$HAYASEND_RAILWAY_API_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo "HAYASEND_RAILWAY_API_URL must be an HTTPS origin without a path." >&2
  exit 1
fi
if [[ ! "$HAYASEND_IMAGE" =~ ^ghcr\.io/haya-inc/hayasend@sha256:[a-f0-9]{64}$ ]]; then
  echo "HAYASEND_IMAGE must be an immutable official HayaSend GHCR digest." >&2
  exit 1
fi
if [[ "$HAYASEND_API_KEY" != re_* ]] ||
  [[ "${#HAYASEND_API_KEY}" -lt 16 ]] ||
  [[ "${#HAYASEND_API_KEY}" -gt 512 ]]; then
  echo "HAYASEND_API_KEY must be a 16 to 512 character re_ key." >&2
  exit 1
fi

link_directory="$(mktemp -d "${TMPDIR:-/tmp}/hayasend-railway-verify.XXXXXX")"
trap 'rm -rf -- "$link_directory"' EXIT
cd -- "$link_directory"

"$railway_cli" link \
  --project "$HAYASEND_RAILWAY_PROJECT_ID" \
  --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
  --json >/dev/null

set +e
plan="$(
  "$railway_cli" config plan \
    --file "$pack_directory/.railway/railway.ts" \
    --detailed-exit-code \
    --json
)"
plan_status=$?
set -e
if [[ "$plan_status" -eq 2 ]]; then
  echo "Railway infrastructure differs from the reviewed HayaSend definition." >&2
  exit 1
fi
if [[ "$plan_status" -ne 0 ]] ||
  ! jq --exit-status '.ok == true' <<<"$plan" >/dev/null; then
  echo "Railway infrastructure drift check failed." >&2
  exit 1
fi

status="$(
  "$railway_cli" status \
    --project "$HAYASEND_RAILWAY_PROJECT_ID" \
    --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
    --json
)"
if ! jq --exit-status \
  --arg project "$HAYASEND_RAILWAY_PROJECT_ID" \
  '.id == $project and .name == "hayasend-railway"' \
  <<<"$status" >/dev/null; then
  echo "Railway status does not match the dedicated HayaSend project." >&2
  exit 1
fi
for resource in \
  "hayasend-api" \
  "hayasend-worker" \
  "hayasend-postgres" \
  "hayasend-attachments"; do
  if ! jq --exit-status --arg resource "$resource" \
    '.. | strings | select(. == $resource)' \
    <<<"$status" >/dev/null; then
    echo "Railway resource $resource is missing." >&2
    exit 1
  fi
done

for service in "hayasend-api" "hayasend-worker"; do
  deployments="$(
    "$railway_cli" deployment list \
      --project "$HAYASEND_RAILWAY_PROJECT_ID" \
      --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
      --service "$service" \
      --limit 1 \
      --json
  )"
  if ! jq --exit-status \
    --arg image "$HAYASEND_IMAGE" \
    '.[0].status == "SUCCESS" and
      ([.[0].meta | .. | strings | select(. == $image)] | length >= 1)' \
    <<<"$deployments" >/dev/null; then
    echo "Railway service $service is not successful on the expected image." >&2
    exit 1
  fi
done

bucket="$(
  "$railway_cli" bucket info \
    --bucket "hayasend-attachments" \
    --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
    --json
)"
if ! jq --exit-status \
  '.name == "hayasend-attachments" and .region == "sin"' \
  <<<"$bucket" >/dev/null; then
  echo "Railway attachment bucket is missing or in the wrong region." >&2
  exit 1
fi

domains="$(
  "$railway_cli" domain list \
    --project "$HAYASEND_RAILWAY_PROJECT_ID" \
    --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
    --service "hayasend-api" \
    --json
)"
api_hostname="${HAYASEND_RAILWAY_API_URL#https://}"
if ! jq --exit-status --arg hostname "$api_hostname" \
  '.domains | any(.domain == $hostname)' \
  <<<"$domains" >/dev/null; then
  echo "The supplied Railway API origin is not attached to hayasend-api." >&2
  exit 1
fi

curl --fail --silent --show-error \
  "$HAYASEND_RAILWAY_API_URL/healthz" >/dev/null
curl --fail --silent --show-error \
  "$HAYASEND_RAILWAY_API_URL/readyz" >/dev/null

echo "Railway API, worker, PostgreSQL, and bucket match the reviewed definition."
