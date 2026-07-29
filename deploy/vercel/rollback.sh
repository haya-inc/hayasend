#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=deploy/vercel/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_vercel_cli
require_project_inputs
assert_linked_project

: "${HAYASEND_VERCEL_ROLLBACK_DEPLOYMENT:?Set the exact reviewed previous deployment URL.}"
: "${HAYASEND_VERCEL_ROLLBACK_VERSION:?Set the exact reviewed previous HayaSend version.}"
: "${HAYASEND_VERCEL_API_URL:?Set the production HTTPS origin to verify after rollback.}"
require_https_origin \
  "HAYASEND_VERCEL_ROLLBACK_DEPLOYMENT" \
  "$HAYASEND_VERCEL_ROLLBACK_DEPLOYMENT"
require_https_origin "HAYASEND_VERCEL_API_URL" "$HAYASEND_VERCEL_API_URL"
if [[ ! "$HAYASEND_VERCEL_ROLLBACK_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "HAYASEND_VERCEL_ROLLBACK_VERSION must be an exact stable semantic version." >&2
  exit 1
fi

rollback_deployment_id="$(
  ready_deployment_id "$HAYASEND_VERCEL_ROLLBACK_DEPLOYMENT"
)"
VERCEL_ORG_ID="$HAYASEND_VERCEL_ORG_ID" \
  VERCEL_PROJECT_ID="$HAYASEND_VERCEL_PROJECT_ID" \
  "$vercel_cli" rollback "$HAYASEND_VERCEL_ROLLBACK_DEPLOYMENT" \
    --cwd "$repository_root" \
    --yes \
    --timeout 5m

"$pack_directory/verify.sh"
active_deployment_id="$(
  ready_deployment_id "$HAYASEND_VERCEL_API_URL"
)"
if [[ "$active_deployment_id" != "$rollback_deployment_id" ]]; then
  echo "The production alias does not resolve to the exact rollback deployment." >&2
  exit 1
fi
health="$(
  curl --fail --silent --show-error \
    "$HAYASEND_VERCEL_API_URL/healthz"
)"
if ! jq --exit-status \
  --arg version "$HAYASEND_VERCEL_ROLLBACK_VERSION" \
  '.ok == true and
    .service == "hayasend" and
    .version == $version' \
  <<<"$health" >/dev/null; then
  echo "The production origin does not expose the exact rollback version." >&2
  exit 1
fi

echo "Application rollback to the exact HayaSend $HAYASEND_VERCEL_ROLLBACK_VERSION deployment completed."
echo "Vercel does not roll active Cron configuration back automatically; redeploy the reviewed vercel.json if its Cron definition changed."
