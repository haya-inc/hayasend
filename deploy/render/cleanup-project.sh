#!/usr/bin/env bash
set -euo pipefail

if [[ "${HAYASEND_ALLOW_DESTROY:-}" != "render-project" ]]; then
  echo "Set HAYASEND_ALLOW_DESTROY=render-project to confirm project cleanup." >&2
  exit 1
fi
if [[ "${HAYASEND_RENDER_DEDICATED_PROJECT:-}" != "true" ]]; then
  echo "Set HAYASEND_RENDER_DEDICATED_PROJECT=true only for the isolated proof project." >&2
  exit 1
fi

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
"$deployment_directory/verify-project.sh"

private_directory="$(mktemp -d "${TMPDIR:-/tmp}/hayasend-render-cleanup.XXXXXX")"
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
    'header = "Accept: application/json"' \
    "header = \"Authorization: Bearer $RENDER_API_KEY\""
} >"$curl_config"
chmod 600 "$curl_config"

delete_status="$(
  curl --config "$curl_config" \
    --request DELETE \
    "https://api.render.com/v1/blueprints/$RENDER_BLUEPRINT_ID" \
    --output /dev/null \
    --write-out '%{http_code}'
)"
if [[ "$delete_status" != "204" ]]; then
  echo "Render did not disconnect the exact Blueprint." >&2
  exit 1
fi

delete_status="$(
  curl --config "$curl_config" \
    --request DELETE \
    "https://api.render.com/v1/projects/$RENDER_PROJECT_ID" \
    --output /dev/null \
    --write-out '%{http_code}'
)"
if [[ "$delete_status" != "204" ]]; then
  echo "Render did not accept deletion of the exact project." >&2
  exit 1
fi

absent=false
for _ in {1..120}; do
  project_status="$(
    curl --config "$curl_config" \
      "https://api.render.com/v1/projects/$RENDER_PROJECT_ID" \
      --output /dev/null \
      --write-out '%{http_code}'
  )"
  blueprint_status="$(
    curl --config "$curl_config" \
      "https://api.render.com/v1/blueprints/$RENDER_BLUEPRINT_ID" \
      --output /dev/null \
      --write-out '%{http_code}'
  )"
  api_status="$(
    curl --config "$curl_config" \
      "https://api.render.com/v1/services/$RENDER_API_SERVICE_ID" \
      --output /dev/null \
      --write-out '%{http_code}'
  )"
  worker_status="$(
    curl --config "$curl_config" \
      "https://api.render.com/v1/services/$RENDER_WORKER_SERVICE_ID" \
      --output /dev/null \
      --write-out '%{http_code}'
  )"
  postgres_status="$(
    curl --config "$curl_config" \
      "https://api.render.com/v1/postgres/$RENDER_POSTGRES_ID" \
      --output /dev/null \
      --write-out '%{http_code}'
  )"
  if [[ "$project_status" == "404" &&
    ( "$blueprint_status" == "404" || "$blueprint_status" == "410" ) &&
    "$api_status" == "404" &&
    "$worker_status" == "404" &&
    "$postgres_status" == "404" ]]; then
    absent=true
    break
  fi
  for status in \
    "$project_status" \
    "$blueprint_status" \
    "$api_status" \
    "$worker_status" \
    "$postgres_status"; do
    if [[ "$status" != "200" && "$status" != "404" && "$status" != "410" ]]; then
      echo "Render residue verification returned an unexpected HTTP status." >&2
      exit 1
    fi
  done
  sleep 5
done
if [[ "$absent" != "true" ]]; then
  echo "The exact Render project or one of its resources remains after ten minutes." >&2
  exit 1
fi

echo "The dedicated Render Blueprint, project, environment, services, and PostgreSQL database are absent."
