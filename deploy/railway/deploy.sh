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
: "${HAYASEND_IMAGE:?Set HAYASEND_IMAGE to an immutable HayaSend GHCR digest.}"
: "${HAYASEND_API_KEY:?Set HAYASEND_API_KEY to an independently generated re_ key.}"
export HAYASEND_TRANSPORT="${HAYASEND_TRANSPORT:-console}"

uuid_pattern='^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
if [[ ! "$HAYASEND_RAILWAY_PROJECT_ID" =~ $uuid_pattern ]] ||
  [[ ! "$HAYASEND_RAILWAY_ENVIRONMENT_ID" =~ $uuid_pattern ]]; then
  echo "Railway project and environment identifiers must be exact lowercase UUIDs." >&2
  exit 1
fi
if [[ -n "${HAYASEND_RAILWAY_WORKSPACE_ID:-}" ]] &&
  [[ ! "$HAYASEND_RAILWAY_WORKSPACE_ID" =~ $uuid_pattern ]]; then
  echo "HAYASEND_RAILWAY_WORKSPACE_ID must be an exact lowercase UUID when set." >&2
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
case "$HAYASEND_TRANSPORT" in
  console) ;;
  sendgrid)
    : "${SENDGRID_API_KEY:?Set SENDGRID_API_KEY only for an explicitly approved SendGrid proof.}"
    : "${SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY:?Set SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY only for an explicitly approved SendGrid proof.}"
    ;;
  *)
    echo "HAYASEND_TRANSPORT must be console or sendgrid for the Railway pack." >&2
    exit 1
    ;;
esac

link_directory="$(mktemp -d "${TMPDIR:-/tmp}/hayasend-railway-link.XXXXXX")"
trap 'rm -rf -- "$link_directory"' EXIT
cd -- "$link_directory"

link_arguments=(
  link
  --project "$HAYASEND_RAILWAY_PROJECT_ID"
  --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID"
  --json
)
if [[ -n "${HAYASEND_RAILWAY_WORKSPACE_ID:-}" ]]; then
  link_arguments+=(--workspace "$HAYASEND_RAILWAY_WORKSPACE_ID")
fi
"$railway_cli" "${link_arguments[@]}" >/dev/null

plan="$(
  "$railway_cli" config plan \
    --file "$pack_directory/.railway/railway.ts" \
    --json
)"
if ! jq --exit-status '.ok == true' <<<"$plan" >/dev/null; then
  echo "Railway rejected the HayaSend infrastructure plan." >&2
  exit 1
fi
if jq --exit-status \
  '.. | objects | select(.severity? == "destructive")' \
  <<<"$plan" >/dev/null; then
  echo "Railway plan contains destructive changes; deploy refused." >&2
  exit 1
fi

"$railway_cli" config apply \
  --file "$pack_directory/.railway/railway.ts" \
  --yes \
  --json >/dev/null

wait_for_deployment() {
  local service="$1"
  local status
  for _attempt in $(seq 1 120); do
    status="$(
      "$railway_cli" deployment list \
        --project "$HAYASEND_RAILWAY_PROJECT_ID" \
        --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
        --service "$service" \
        --limit 1 \
        --json |
        jq --raw-output '.[0].status // "MISSING"'
    )"
    case "$status" in
      SUCCESS)
        return
        ;;
      FAILED | CRASHED | REMOVED)
        echo "Railway deployment for $service reached terminal state $status." >&2
        exit 1
        ;;
    esac
    sleep 5
  done
  echo "Railway deployment for $service did not become successful in time." >&2
  exit 1
}

wait_for_deployment "hayasend-api"
wait_for_deployment "hayasend-worker"

"$railway_cli" domain \
  --project "$HAYASEND_RAILWAY_PROJECT_ID" \
  --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
  --service "hayasend-api" \
  --port 8787 \
  --json >/dev/null

domains="$(
  "$railway_cli" domain list \
    --project "$HAYASEND_RAILWAY_PROJECT_ID" \
    --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
    --service "hayasend-api" \
    --json
)"
api_domain="$(
  jq --raw-output \
    '.domains | map(select(.type == "service"))[0].domain // .domains[0].domain // empty' \
    <<<"$domains"
)"
if [[ -z "$api_domain" ]]; then
  echo "Railway did not expose an API domain." >&2
  exit 1
fi
api_url="https://$api_domain"

HAYASEND_RAILWAY_API_URL="$api_url" \
  "$pack_directory/verify.sh"

echo "HayaSend Railway API: $api_url"
