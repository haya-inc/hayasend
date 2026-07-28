#!/usr/bin/env bash
set -euo pipefail

render_cli="${RENDER_CLI:-render}"
required_version="$(<"$(dirname -- "${BASH_SOURCE[0]}")/.render-cli-version")"
installed_version="$("$render_cli" --version | sed -n '1s/^render v//p')"
if [[ "$installed_version" != "$required_version" ]]; then
  echo "Render CLI $required_version is required; found ${installed_version:-unknown}." >&2
  exit 1
fi

: "${RENDER_API_SERVICE_ID:?Set RENDER_API_SERVICE_ID to an exact srv-* ID.}"
: "${RENDER_WORKER_SERVICE_ID:?Set RENDER_WORKER_SERVICE_ID to an exact srv-* ID.}"
: "${HAYASEND_RENDER_API_URL:?Set HAYASEND_RENDER_API_URL to the API HTTPS origin.}"
: "${HAYASEND_IMAGE:?Set HAYASEND_IMAGE to the expected immutable image digest.}"

if [[ ! "$RENDER_API_SERVICE_ID" =~ ^srv-[a-z0-9]+$ ]] ||
  [[ ! "$RENDER_WORKER_SERVICE_ID" =~ ^srv-[a-z0-9]+$ ]]; then
  echo "Both service identifiers must be exact srv-* IDs." >&2
  exit 1
fi
if [[ ! "$HAYASEND_RENDER_API_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo "HAYASEND_RENDER_API_URL must be an HTTPS origin without a path." >&2
  exit 1
fi
if [[ ! "$HAYASEND_IMAGE" =~ ^ghcr\.io/haya-inc/hayasend@sha256:[a-f0-9]{64}$ ]]; then
  echo "HAYASEND_IMAGE must be an immutable official HayaSend GHCR digest." >&2
  exit 1
fi

api_deploys="$("$render_cli" deploys list "$RENDER_API_SERVICE_ID" --output json)"
worker_deploys="$("$render_cli" deploys list "$RENDER_WORKER_SERVICE_ID" --output json)"

if ! jq --exit-status --arg image "$HAYASEND_IMAGE" \
  '.. | strings | select(. == $image)' <<<"$api_deploys" >/dev/null; then
  echo "The API deploy history does not contain the expected image digest." >&2
  exit 1
fi
if ! jq --exit-status --arg image "$HAYASEND_IMAGE" \
  '.. | strings | select(. == $image)' <<<"$worker_deploys" >/dev/null; then
  echo "The worker deploy history does not contain the expected image digest." >&2
  exit 1
fi

curl --fail --silent --show-error \
  "$HAYASEND_RENDER_API_URL/healthz" >/dev/null
curl --fail --silent --show-error \
  "$HAYASEND_RENDER_API_URL/readyz" >/dev/null

echo "Render API and worker expose the expected image and readiness."
