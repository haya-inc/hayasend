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
assert_secret_names false

"$fly_cli" config validate \
  --strict \
  --app "$HAYASEND_FLY_APP" \
  --config "$pack_directory/fly.toml" >/dev/null

"$fly_cli" deploy \
  --app "$HAYASEND_FLY_APP" \
  --config "$pack_directory/fly.toml" \
  --image "$HAYASEND_IMAGE" \
  --strategy rolling \
  --release-command-timeout 10m \
  --ha=false \
  --yes

"$pack_directory/verify.sh"

echo "HayaSend Fly.io API: https://${HAYASEND_FLY_APP}.fly.dev"
