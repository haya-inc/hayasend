#!/usr/bin/env bash
set -euo pipefail

pack_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
repository_root="$(
  cd -- "$pack_directory/../.."
  pwd
)"
vercel_cli="${VERCEL_CLI:-vercel}"

require_vercel_cli() {
  local required_version installed_version
  required_version="$(<"$pack_directory/.vercel-cli-version")"
  installed_version="$(
    "$vercel_cli" --version 2>/dev/null |
      tail -n 1 |
      tr -d '\r'
  )"
  if [[ "$installed_version" != "$required_version" ]]; then
    echo "Vercel CLI $required_version is required; found ${installed_version:-unknown}." >&2
    exit 1
  fi
}

require_project_inputs() {
  : "${HAYASEND_VERCEL_PROJECT_ID:?Set HAYASEND_VERCEL_PROJECT_ID to the exact prj_* ID.}"
  : "${HAYASEND_VERCEL_ORG_ID:?Set HAYASEND_VERCEL_ORG_ID to the exact team_* or user_* ID.}"
  : "${HAYASEND_VERCEL_PROJECT_NAME:?Set HAYASEND_VERCEL_PROJECT_NAME to the exact dedicated project name.}"

  if [[ ! "$HAYASEND_VERCEL_PROJECT_ID" =~ ^prj_[A-Za-z0-9]+$ ]]; then
    echo "HAYASEND_VERCEL_PROJECT_ID must be an exact prj_* ID." >&2
    exit 1
  fi
  if [[ ! "$HAYASEND_VERCEL_ORG_ID" =~ ^(team|user)_[A-Za-z0-9]+$ ]]; then
    echo "HAYASEND_VERCEL_ORG_ID must be an exact team_* or user_* ID." >&2
    exit 1
  fi
  if [[ ! "$HAYASEND_VERCEL_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9-]{0,99}$ ]]; then
    echo "HAYASEND_VERCEL_PROJECT_NAME must be an exact lowercase Vercel project name." >&2
    exit 1
  fi
}

assert_linked_project() {
  local project_file="$repository_root/.vercel/project.json"
  if [[ ! -f "$project_file" ]]; then
    echo "Link the dedicated project with 'vercel link' before continuing." >&2
    exit 1
  fi
  if ! jq --exit-status \
    --arg project "$HAYASEND_VERCEL_PROJECT_ID" \
    --arg organization "$HAYASEND_VERCEL_ORG_ID" \
    --arg name "$HAYASEND_VERCEL_PROJECT_NAME" \
    '.projectId == $project and
      .orgId == $organization and
      .projectName == $name' \
    "$project_file" >/dev/null; then
    echo "The linked Vercel project does not match all explicit identifiers." >&2
    exit 1
  fi
  VERCEL_ORG_ID="$HAYASEND_VERCEL_ORG_ID" \
    VERCEL_PROJECT_ID="$HAYASEND_VERCEL_PROJECT_ID" \
    "$vercel_cli" project inspect "$HAYASEND_VERCEL_PROJECT_NAME" \
      --cwd "$repository_root" \
      --non-interactive \
      --no-color >/dev/null
}

require_https_origin() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
    echo "$name must be an HTTPS origin without a path." >&2
    exit 1
  fi
}

inspect_ready_deployment() {
  local deployment="$1"
  local inspection
  inspection="$(
    VERCEL_ORG_ID="$HAYASEND_VERCEL_ORG_ID" \
      VERCEL_PROJECT_ID="$HAYASEND_VERCEL_PROJECT_ID" \
      "$vercel_cli" inspect "$deployment" \
        --cwd "$repository_root" \
        --json \
        --wait \
        --timeout 5m
  )"
  if ! jq --exit-status \
    --arg project "$HAYASEND_VERCEL_PROJECT_ID" \
    '((.readyState // .state) == "READY") and
      ((.projectId // .project.id // $project) == $project)' \
    <<<"$inspection" >/dev/null; then
    echo "The Vercel deployment is not READY for the expected project." >&2
    exit 1
  fi
}

ready_deployment_id() {
  local deployment="$1"
  local inspection deployment_id
  inspection="$(
    VERCEL_ORG_ID="$HAYASEND_VERCEL_ORG_ID" \
      VERCEL_PROJECT_ID="$HAYASEND_VERCEL_PROJECT_ID" \
      "$vercel_cli" inspect "$deployment" \
        --cwd "$repository_root" \
        --json \
        --wait \
        --timeout 5m
  )"
  if ! jq --exit-status \
    --arg project "$HAYASEND_VERCEL_PROJECT_ID" \
    '((.readyState // .state) == "READY") and
      ((.projectId // .project.id // $project) == $project) and
      ((.id // .uid // "") | test("^dpl_[A-Za-z0-9]+$"))' \
    <<<"$inspection" >/dev/null; then
    echo "The Vercel deployment does not expose an exact READY deployment ID for the expected project." >&2
    exit 1
  fi
  deployment_id="$(jq --raw-output '.id // .uid' <<<"$inspection")"
  printf '%s\n' "$deployment_id"
}
