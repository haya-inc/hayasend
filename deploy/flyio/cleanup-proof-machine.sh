#!/usr/bin/env bash
set -euo pipefail

if [[ "${HAYASEND_ALLOW_DESTROY:-}" != "flyio-proof-machine" ]]; then
  echo "Set HAYASEND_ALLOW_DESTROY=flyio-proof-machine to confirm proof Machine cleanup." >&2
  exit 1
fi
if [[ "${HAYASEND_FLY_DEDICATED_APP:-}" != "true" ]]; then
  echo "Set HAYASEND_FLY_DEDICATED_APP=true only for the isolated proof app." >&2
  exit 1
fi

# shellcheck source=deploy/flyio/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_flyctl
require_resource_inputs
require_image
require_proof_machine_name
assert_app_inventory
assert_mpg_inventory
assert_bucket_inventory
assert_secret_names true

all_named="$(
  "$fly_cli" machine list \
    --app "$HAYASEND_FLY_APP" \
    --json |
    jq --compact-output \
      --arg name "$HAYASEND_FLY_PROOF_MACHINE_NAME" \
      '[.[] | select(.name == $name)]'
)"
reviewed="$(proof_machine_inventory)"
if [[ "$(jq 'length' <<<"$all_named")" -gt 1 ]] ||
  [[ "$(jq 'length' <<<"$all_named")" != "$(jq 'length' <<<"$reviewed")" ]]; then
  echo "The named proof Machine is duplicated or does not match the reviewed disposable definition." >&2
  exit 1
fi

machine_id="$(jq --raw-output 'if length == 1 then .[0].id else empty end' <<<"$reviewed")"
if [[ -n "$machine_id" ]]; then
  if [[ ! "$machine_id" =~ ^[a-f0-9]{14}$ ]]; then
    echo "The exact proof Machine ID is invalid." >&2
    exit 1
  fi
  "$fly_cli" machine destroy "$machine_id" \
    --app "$HAYASEND_FLY_APP" \
    --force
fi

remaining="$(
  "$fly_cli" machine list \
    --app "$HAYASEND_FLY_APP" \
    --json
)"
if jq --exit-status \
  --arg name "$HAYASEND_FLY_PROOF_MACHINE_NAME" \
  'any(.[]; .name == $name)' \
  <<<"$remaining" >/dev/null; then
  echo "The disposable proof Machine remains visible after cleanup." >&2
  exit 1
fi

assert_machine_inventory
echo "The disposable Fly.io proof Machine is absent and the API/worker pair remains exact."
