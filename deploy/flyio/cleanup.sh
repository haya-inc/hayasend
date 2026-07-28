#!/usr/bin/env bash
set -euo pipefail

if [[ "${HAYASEND_ALLOW_DESTROY:-}" != "flyio" ]]; then
  echo "Set HAYASEND_ALLOW_DESTROY=flyio to confirm this destructive cleanup." >&2
  exit 1
fi
if [[ "${HAYASEND_FLY_DEDICATED_APP:-}" != "true" ]]; then
  echo "Set HAYASEND_FLY_DEDICATED_APP=true only for the isolated proof app." >&2
  exit 1
fi
if [[ "${HAYASEND_FLY_TIGRIS_EMPTY:-}" != "true" ]]; then
  echo "Set HAYASEND_FLY_TIGRIS_EMPTY=true only after an authenticated S3 ListObjectsV2 proves zero objects." >&2
  exit 1
fi

# shellcheck source=deploy/flyio/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_flyctl
require_resource_inputs
: "${HAYASEND_IMAGE:?Set HAYASEND_IMAGE to the expected deployed immutable digest.}"
require_image
assert_app_inventory
assert_mpg_inventory
assert_bucket_inventory
assert_secret_names true
assert_machine_inventory

"$fly_cli" storage destroy "$HAYASEND_FLY_BUCKET" \
  --app "$HAYASEND_FLY_APP" \
  --yes
"$fly_cli" apps destroy "$HAYASEND_FLY_APP" --yes
"$fly_cli" mpg destroy "$HAYASEND_FLY_MPG_CLUSTER_ID" --yes

buckets="$("$fly_cli" storage list --org "$HAYASEND_FLY_ORG")"
if awk -v bucket="$HAYASEND_FLY_BUCKET" \
  '$1 == bucket { found = 1 } END { exit(found ? 0 : 1) }' \
  <<<"$buckets"; then
  echo "The Tigris bucket remains visible after cleanup." >&2
  exit 1
fi

apps="$("$fly_cli" apps list --org "$HAYASEND_FLY_ORG" --json)"
if jq --exit-status --arg app "$HAYASEND_FLY_APP" \
  'any(.[]; (.name // .Name) == $app)' \
  <<<"$apps" >/dev/null; then
  echo "The Fly App remains visible after cleanup." >&2
  exit 1
fi

clusters="$("$fly_cli" mpg list --org "$HAYASEND_FLY_ORG" --json)"
if jq --exit-status --arg id "$HAYASEND_FLY_MPG_CLUSTER_ID" \
  'any(.[]; .id == $id)' \
  <<<"$clusters" >/dev/null; then
  echo "Managed Postgres remains visible after cleanup." >&2
  exit 1
fi

echo "The isolated Fly App, Tigris bucket, and Managed Postgres cluster are absent from active inventory."
