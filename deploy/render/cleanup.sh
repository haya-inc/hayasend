#!/usr/bin/env bash
set -euo pipefail

if [[ "${HAYASEND_ALLOW_DESTROY:-}" != "render" ]]; then
  echo "Set HAYASEND_ALLOW_DESTROY=render to confirm this destructive cleanup." >&2
  exit 1
fi
if [[ "${HAYASEND_RENDER_BLUEPRINT_UNLINKED:-}" != "true" ]]; then
  echo "Unlink the Blueprint first, then set HAYASEND_RENDER_BLUEPRINT_UNLINKED=true." >&2
  exit 1
fi

render_cli="${RENDER_CLI:-render}"
required_version="$(<"$(dirname -- "${BASH_SOURCE[0]}")/.render-cli-version")"
installed_version="$("$render_cli" --version | sed -n '1s/^render v//p')"
if [[ "$installed_version" != "$required_version" ]]; then
  echo "Render CLI $required_version is required; found ${installed_version:-unknown}." >&2
  exit 1
fi

: "${RENDER_API_SERVICE_ID:?Set RENDER_API_SERVICE_ID to an exact srv-* ID.}"
: "${RENDER_WORKER_SERVICE_ID:?Set RENDER_WORKER_SERVICE_ID to an exact srv-* ID.}"
: "${RENDER_POSTGRES_ID:?Set RENDER_POSTGRES_ID to an exact dpg-* ID.}"

if [[ ! "$RENDER_API_SERVICE_ID" =~ ^srv-[a-z0-9]+$ ]] ||
  [[ ! "$RENDER_WORKER_SERVICE_ID" =~ ^srv-[a-z0-9]+$ ]]; then
  echo "Both service identifiers must be exact srv-* IDs." >&2
  exit 1
fi
if [[ ! "$RENDER_POSTGRES_ID" =~ ^dpg-[a-z0-9]+$ ]]; then
  echo "RENDER_POSTGRES_ID must be an exact dpg-* ID." >&2
  exit 1
fi

"$render_cli" services delete "$RENDER_WORKER_SERVICE_ID" \
  --confirm \
  --output json
"$render_cli" services delete "$RENDER_API_SERVICE_ID" \
  --confirm \
  --output json
"$render_cli" postgres delete "$RENDER_POSTGRES_ID" \
  --confirm \
  --output json

services="$("$render_cli" services --include-previews --output json)"
databases="$("$render_cli" postgres list --output json)"

for identifier in \
  "$RENDER_WORKER_SERVICE_ID" \
  "$RENDER_API_SERVICE_ID" \
  "$RENDER_POSTGRES_ID"; do
  if jq --exit-status --arg identifier "$identifier" \
    '.. | strings | select(. == $identifier)' \
    <<<"$services"$'\n'"$databases" >/dev/null; then
    echo "Render resource $identifier remains after cleanup." >&2
    exit 1
  fi
done

echo "Named HayaSend Render services and PostgreSQL resources are absent."
