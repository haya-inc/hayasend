#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=deploy/flyio/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_flyctl
require_resource_inputs
require_image
assert_app_inventory
assert_mpg_inventory
assert_bucket_inventory
assert_secret_names true
assert_machine_inventory

checks="$(
  "$fly_cli" checks list \
    --app "$HAYASEND_FLY_APP" \
    --json
)"
if ! jq --exit-status \
  '[.[][]] | length >= 1 and all(.[]; .status == "passing")' \
  <<<"$checks" >/dev/null; then
  echo "Fly.io API health checks are not all passing." >&2
  exit 1
fi

api_url="https://${HAYASEND_FLY_APP}.fly.dev"
curl --fail --silent --show-error "$api_url/healthz" >/dev/null
curl --fail --silent --show-error "$api_url/readyz" >/dev/null

echo "Fly.io API, worker, Managed Postgres, and private Tigris bucket match the reviewed definition."
