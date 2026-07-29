#!/usr/bin/env bash
set -euo pipefail

: "${RENDER_API_KEY:?Set RENDER_API_KEY through the secret environment.}"
: "${RENDER_OWNER_ID:?Set RENDER_OWNER_ID to the exact Render workspace ID.}"
: "${RENDER_PROJECT_ID:?Set RENDER_PROJECT_ID to the exact dedicated project ID.}"
: "${RENDER_ENVIRONMENT_ID:?Set RENDER_ENVIRONMENT_ID to the exact production environment ID.}"
: "${RENDER_BLUEPRINT_ID:?Set RENDER_BLUEPRINT_ID to the exact Blueprint ID.}"
: "${RENDER_API_SERVICE_ID:?Set RENDER_API_SERVICE_ID to the exact API service ID.}"
: "${RENDER_WORKER_SERVICE_ID:?Set RENDER_WORKER_SERVICE_ID to the exact worker service ID.}"
: "${RENDER_POSTGRES_ID:?Set RENDER_POSTGRES_ID to the exact PostgreSQL ID.}"

if [[ ! "$RENDER_OWNER_ID" =~ ^(tea|usr)-[a-z0-9]{20}$ ]] ||
  [[ ! "$RENDER_PROJECT_ID" =~ ^prj-[a-z0-9]{20}$ ]] ||
  [[ ! "$RENDER_ENVIRONMENT_ID" =~ ^evm-[a-z0-9]{20}$ ]] ||
  [[ ! "$RENDER_BLUEPRINT_ID" =~ ^exs-[a-z0-9]{20}$ ]] ||
  [[ ! "$RENDER_API_SERVICE_ID" =~ ^srv-[a-z0-9]{20}$ ]] ||
  [[ ! "$RENDER_WORKER_SERVICE_ID" =~ ^srv-[a-z0-9]{20}$ ]] ||
  [[ ! "$RENDER_POSTGRES_ID" =~ ^dpg-[a-z0-9]{20}$ ]]; then
  echo "Exact Render workspace, project, environment, Blueprint, service, and database IDs are required." >&2
  exit 1
fi

private_directory="$(mktemp -d "${TMPDIR:-/tmp}/hayasend-render-project.XXXXXX")"
chmod 700 "$private_directory"
cleanup_private_directory() {
  find "$private_directory" -type f -exec sh -c ': > "$1"' _ {} \;
  find "$private_directory" -depth -delete
}
trap cleanup_private_directory EXIT

curl_config="$private_directory/curl.conf"
{
  printf '%s\n' \
    'silent' \
    'show-error' \
    'fail' \
    'header = "Accept: application/json"' \
    "header = \"Authorization: Bearer $RENDER_API_KEY\""
} >"$curl_config"
chmod 600 "$curl_config"

render_get() {
  local path="$1"
  local output="$2"
  curl --config "$curl_config" \
    "https://api.render.com/v1$path" \
    --output "$output"
}

render_get "/projects/$RENDER_PROJECT_ID" "$private_directory/project.json"
render_get "/environments/$RENDER_ENVIRONMENT_ID" "$private_directory/environment.json"
render_get "/blueprints/$RENDER_BLUEPRINT_ID" "$private_directory/blueprint.json"
render_get "/services?limit=100" "$private_directory/services.json"
render_get "/postgres?limit=100" "$private_directory/postgres.json"
render_get \
  "/services/$RENDER_API_SERVICE_ID/custom-domains" \
  "$private_directory/domains.json"

jq --exit-status \
  --arg project "$RENDER_PROJECT_ID" \
  --arg environment "$RENDER_ENVIRONMENT_ID" \
  --arg owner "$RENDER_OWNER_ID" \
  '.id == $project and
    .name == "hayasend-render" and
    .owner.id == $owner and
    .environmentIds == [$environment]' \
  "$private_directory/project.json" >/dev/null

jq --exit-status \
  --arg project "$RENDER_PROJECT_ID" \
  --arg environment "$RENDER_ENVIRONMENT_ID" \
  --arg api "$RENDER_API_SERVICE_ID" \
  --arg worker "$RENDER_WORKER_SERVICE_ID" \
  --arg postgres "$RENDER_POSTGRES_ID" \
  '.id == $environment and
    .name == "production" and
    .projectId == $project and
    .protectedStatus == "unprotected" and
    .networkIsolationEnabled == true and
    (.serviceIds | sort) == ([$api, $worker] | sort) and
    .databasesIds == [$postgres] and
    .redisIds == [] and
    .envGroupIds == []' \
  "$private_directory/environment.json" >/dev/null

jq --exit-status \
  --arg blueprint "$RENDER_BLUEPRINT_ID" \
  --arg api "$RENDER_API_SERVICE_ID" \
  --arg worker "$RENDER_WORKER_SERVICE_ID" \
  --arg postgres "$RENDER_POSTGRES_ID" \
  '.id == $blueprint and
    .name == "hayasend-render" and
    .autoSync == false and
    .repo == "https://github.com/haya-inc/hayasend" and
    .branch == "main" and
    .path == "deploy/render/render.yaml" and
    (.resources | sort_by(.id)) ==
      ([
        {id: $api, name: "hayasend-api", type: "web_service"},
        {id: $worker, name: "hayasend-worker", type: "background_worker"},
        {id: $postgres, name: "hayasend-postgres", type: "postgres"}
      ] | sort_by(.id))' \
  "$private_directory/blueprint.json" >/dev/null

jq --exit-status \
  --arg environment "$RENDER_ENVIRONMENT_ID" \
  --arg owner "$RENDER_OWNER_ID" \
  --arg api "$RENDER_API_SERVICE_ID" \
  --arg worker "$RENDER_WORKER_SERVICE_ID" \
  '[
    .[].service |
    select(.id == $api or .id == $worker) |
    {
      id,
      name,
      ownerId,
      environmentId,
      type
    }
  ] | sort_by(.id) ==
    ([
      {
        id: $api,
        name: "hayasend-api",
        ownerId: $owner,
        environmentId: $environment,
        type: "web_service"
      },
      {
        id: $worker,
        name: "hayasend-worker",
        ownerId: $owner,
        environmentId: $environment,
        type: "background_worker"
      }
    ] | sort_by(.id))' \
  "$private_directory/services.json" >/dev/null

jq --exit-status \
  --arg environment "$RENDER_ENVIRONMENT_ID" \
  --arg owner "$RENDER_OWNER_ID" \
  --arg postgres "$RENDER_POSTGRES_ID" \
  '[
    .[].postgres |
    select(.id == $postgres) |
    {
      id,
      name,
      ownerId: .owner.id,
      environmentId,
      plan,
      region,
      diskSizeGB,
      diskAutoscalingEnabled,
      ipAllowList
    }
  ] == [
    {
      id: $postgres,
      name: "hayasend-postgres",
      ownerId: $owner,
      environmentId: $environment,
      plan: "basic-256mb",
      region: "singapore",
      diskSizeGB: 1,
      diskAutoscalingEnabled: false,
      ipAllowList: []
    }
  ]' \
  "$private_directory/postgres.json" >/dev/null

jq --exit-status 'length == 0' "$private_directory/domains.json" >/dev/null

echo "The exact isolated Render project, environment, Blueprint, and three-resource inventory are verified."
