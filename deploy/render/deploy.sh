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
: "${HAYASEND_IMAGE:?Set HAYASEND_IMAGE to an immutable HayaSend GHCR digest.}"

if [[ ! "$RENDER_API_SERVICE_ID" =~ ^srv-[a-z0-9]+$ ]]; then
  echo "RENDER_API_SERVICE_ID must be an exact srv-* ID." >&2
  exit 1
fi
if [[ ! "$RENDER_WORKER_SERVICE_ID" =~ ^srv-[a-z0-9]+$ ]]; then
  echo "RENDER_WORKER_SERVICE_ID must be an exact srv-* ID." >&2
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

"$render_cli" deploys create "$RENDER_API_SERVICE_ID" \
  --image "$HAYASEND_IMAGE" \
  --wait \
  --confirm \
  --output json

curl --fail --silent --show-error \
  "$HAYASEND_RENDER_API_URL/readyz" >/dev/null

"$render_cli" deploys create "$RENDER_WORKER_SERVICE_ID" \
  --image "$HAYASEND_IMAGE" \
  --wait \
  --confirm \
  --output json

curl --fail --silent --show-error \
  "$HAYASEND_RENDER_API_URL/readyz" >/dev/null

echo "HayaSend API and worker deployed from $HAYASEND_IMAGE"
