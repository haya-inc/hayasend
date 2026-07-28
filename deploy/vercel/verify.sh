#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=deploy/vercel/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_vercel_cli
require_project_inputs
assert_linked_project

: "${HAYASEND_VERCEL_API_URL:?Set HAYASEND_VERCEL_API_URL to the exact deployment or production origin.}"
: "${CRON_SECRET:?Export the deployed Vercel Cron secret.}"
require_https_origin "HAYASEND_VERCEL_API_URL" "$HAYASEND_VERCEL_API_URL"
if [[ "${#CRON_SECRET}" -lt 32 ]] ||
  [[ "${#CRON_SECRET}" -gt 512 ]]; then
  echo "CRON_SECRET must contain 32 to 512 characters." >&2
  exit 1
fi

inspect_ready_deployment "$HAYASEND_VERCEL_API_URL"
curl --fail --silent --show-error \
  "$HAYASEND_VERCEL_API_URL/healthz" >/dev/null
curl --fail --silent --show-error \
  "$HAYASEND_VERCEL_API_URL/readyz" >/dev/null

queue_status="$(
  curl --silent --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --request POST \
    "$HAYASEND_VERCEL_API_URL/api/queue"
)"
if [[ "$queue_status" != "404" ]]; then
  echo "The Vercel Queue consumer is externally reachable; expected HTTP 404." >&2
  exit 1
fi

cron_status="$(
  curl --silent --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    "$HAYASEND_VERCEL_API_URL/api/reconcile"
)"
if [[ "$cron_status" != "401" ]]; then
  echo "The Vercel Cron endpoint did not fail closed; expected HTTP 401." >&2
  exit 1
fi

cron_result="$(
  curl --fail --silent --show-error \
    "$HAYASEND_VERCEL_API_URL/api/reconcile" \
    --header "Authorization: Bearer $CRON_SECRET"
)"
if ! jq --exit-status \
  '.ok == true and
    (.ticks | type == "number") and
    (.leased | type == "number") and
    (.completed | type == "number") and
    (.retried | type == "number") and
    (.failed | type == "number") and
    (.lost | type == "number")' \
  <<<"$cron_result" >/dev/null; then
  echo "The authenticated Vercel reconciliation probe returned an invalid result." >&2
  exit 1
fi

echo "Vercel deployment, readiness, private Queue, and authenticated Cron checks passed."
