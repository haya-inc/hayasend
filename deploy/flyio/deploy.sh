#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=deploy/flyio/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_flyctl
require_transport
require_resource_inputs
require_image
assert_app_inventory
assert_mpg_inventory
assert_bucket_inventory
assert_secret_names false

capability_environment=()
if [[ "$HAYASEND_TRANSPORT" == "console" ]]; then
  capability_environment=(
    --env
    "HAYASEND_CONSOLE_PROOF_CONFIRM=$HAYASEND_CONSOLE_PROOF_CONFIRM"
  )
else
  capability_environment=(
    --env
    "HAYASEND_DEPLOYMENT_PROFILE=flyio-sendgrid"
  )
fi

"$fly_cli" config validate \
  --strict \
  --app "$HAYASEND_FLY_APP" \
  --config "$pack_directory/fly.toml" >/dev/null

"$fly_cli" deploy \
  --app "$HAYASEND_FLY_APP" \
  --config "$pack_directory/fly.toml" \
  --image "$HAYASEND_IMAGE" \
  --env "HAYASEND_RUNTIME_PROFILE=portable-postgres" \
  --env "HAYASEND_TRANSPORT=$HAYASEND_TRANSPORT" \
  "${capability_environment[@]}" \
  --strategy rolling \
  --release-command-timeout 10m \
  --ha=false \
  --yes

"$pack_directory/verify.sh"

echo "HayaSend Fly.io API: https://${HAYASEND_FLY_APP}.fly.dev"
