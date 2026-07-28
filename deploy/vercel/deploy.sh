#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=deploy/vercel/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_vercel_cli
require_project_inputs
assert_linked_project

: "${HAYASEND_DATABASE_URL:?Export the production PostgreSQL URL for migration.}"
: "${HAYASEND_API_KEY:?Export the same bootstrap API key configured in Vercel.}"
: "${BLOB_READ_WRITE_TOKEN:?Export the private Vercel Blob read/write token.}"
: "${CRON_SECRET:?Export the same Vercel Cron secret configured in production.}"
: "${HAYASEND_VERCEL_API_URL:?Set the public production HTTPS origin to verify.}"
require_https_origin "HAYASEND_VERCEL_API_URL" "$HAYASEND_VERCEL_API_URL"

if [[ "$HAYASEND_DATABASE_URL" != postgres://* ]] &&
  [[ "$HAYASEND_DATABASE_URL" != postgresql://* ]]; then
  echo "HAYASEND_DATABASE_URL must be an explicit PostgreSQL URL." >&2
  exit 1
fi
if [[ "$HAYASEND_API_KEY" != re_* ]] ||
  [[ "${#HAYASEND_API_KEY}" -lt 16 ]] ||
  [[ "${#HAYASEND_API_KEY}" -gt 512 ]]; then
  echo "HAYASEND_API_KEY must be a 16 to 512 character re_ key." >&2
  exit 1
fi
if [[ "${#BLOB_READ_WRITE_TOKEN}" -lt 32 ]] ||
  [[ "${#BLOB_READ_WRITE_TOKEN}" -gt 4096 ]]; then
  echo "BLOB_READ_WRITE_TOKEN must contain 32 to 4096 characters." >&2
  exit 1
fi
if [[ "${#CRON_SECRET}" -lt 32 ]] ||
  [[ "${#CRON_SECRET}" -gt 512 ]]; then
  echo "CRON_SECRET must contain 32 to 512 characters." >&2
  exit 1
fi

(
  cd -- "$repository_root"
  npm ci
  npm run check
  npm run validate:vercel
  npm run build
  HAYASEND_MODE=portable \
    HAYASEND_TRANSPORT="${HAYASEND_TRANSPORT:-console}" \
    HAYASEND_OBJECT_STORAGE=vercel-blob \
    npm run migrate:postgres
)

deployment="$(
  VERCEL_ORG_ID="$HAYASEND_VERCEL_ORG_ID" \
    VERCEL_PROJECT_ID="$HAYASEND_VERCEL_PROJECT_ID" \
    "$vercel_cli" deploy "$repository_root" \
      --prod \
      --yes \
      --project "$HAYASEND_VERCEL_PROJECT_ID"
)"
require_https_origin "Vercel deployment URL" "$deployment"
inspect_ready_deployment "$deployment"

"$pack_directory/verify.sh"

echo "HayaSend Vercel deployment: $deployment"
echo "HayaSend Vercel production API: $HAYASEND_VERCEL_API_URL"
