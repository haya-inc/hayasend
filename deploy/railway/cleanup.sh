#!/usr/bin/env bash
set -euo pipefail

if [[ "${HAYASEND_ALLOW_DESTROY:-}" != "railway" ]]; then
  echo "Set HAYASEND_ALLOW_DESTROY=railway to confirm this destructive cleanup." >&2
  exit 1
fi
if [[ "${HAYASEND_RAILWAY_DEDICATED_PROJECT:-}" != "true" ]]; then
  echo "Set HAYASEND_RAILWAY_DEDICATED_PROJECT=true only for an isolated proof project." >&2
  exit 1
fi
if [[ "${HAYASEND_RAILWAY_ALLOW_PARTIAL:-false}" != "false" ]] &&
  [[ "${HAYASEND_RAILWAY_ALLOW_PARTIAL:-}" != "true" ]]; then
  echo "HAYASEND_RAILWAY_ALLOW_PARTIAL must be true or false." >&2
  exit 1
fi

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

link_directory="$(mktemp -d "${TMPDIR:-/tmp}/hayasend-railway-cleanup.XXXXXX")"
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

environments="$("$railway_cli" environment list --json)"
if ! jq --exit-status \
  --arg environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
  '.environments | length == 1 and
    .[0].id == $environment and
    .[0].name == "production" and
    .[0].isEphemeral == false' \
  <<<"$environments" >/dev/null; then
  echo "The project must contain only the exact non-ephemeral production environment." >&2
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
  --arg allow_partial "${HAYASEND_RAILWAY_ALLOW_PARTIAL:-false}" \
  '.id == $project and
    .name == "hayasend-railway" and
    (if $allow_partial == "true" then
      ([.services.edges[].node.name] |
        all(. == "hayasend-api" or
          . == "hayasend-postgres" or
          . == "hayasend-worker")) and
      ([.buckets.edges[].node.name] |
        all(. == "hayasend-attachments"))
    else
      ([.services.edges[].node.name] | sort ==
        ["hayasend-api", "hayasend-postgres", "hayasend-worker"]) and
      ([.buckets.edges[].node.name] | sort ==
        ["hayasend-attachments"])
    end)' \
  <<<"$status" >/dev/null; then
  echo "The project is not an isolated HayaSend Railway project with only allowed resources; cleanup refused." >&2
  exit 1
fi

if jq --exit-status \
  '[.buckets.edges[].node.name] | any(. == "hayasend-attachments")' \
  <<<"$status" >/dev/null; then
  bucket="$(
    "$railway_cli" bucket info \
      --bucket "hayasend-attachments" \
      --environment "$HAYASEND_RAILWAY_ENVIRONMENT_ID" \
      --json
  )"
  if ! jq --exit-status \
    '.name == "hayasend-attachments" and (.objects // 0) == 0' \
    <<<"$bucket" >/dev/null; then
    echo "Empty the Railway attachment bucket and verify object count zero before cleanup." >&2
    exit 1
  fi
fi

delete_arguments=(
  delete
  --project "$HAYASEND_RAILWAY_PROJECT_ID"
  --yes
  --json
)
if [[ -n "${RAILWAY_2FA_CODE:-}" ]]; then
  if [[ ! "$RAILWAY_2FA_CODE" =~ ^[0-9]{6}$ ]]; then
    echo "RAILWAY_2FA_CODE must be the current six-digit code." >&2
    exit 1
  fi
  delete_arguments+=(--2fa-code "$RAILWAY_2FA_CODE")
fi
"$railway_cli" "${delete_arguments[@]}" >/dev/null

projects="$("$railway_cli" list --json)"
if jq --exit-status --arg project "$HAYASEND_RAILWAY_PROJECT_ID" \
  '.. | objects | select(.id? == $project)' \
  <<<"$projects" >/dev/null; then
  echo "Railway accepted deletion, but the project is still scheduled or visible; verify final removal and billing separately."
else
  echo "The isolated HayaSend Railway project is absent from project inventory."
fi
