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
export HAYASEND_TRANSPORT="${HAYASEND_TRANSPORT:-console}"

if [[ "$HAYASEND_DATABASE_URL" != postgres://* ]] &&
  [[ "$HAYASEND_DATABASE_URL" != postgresql://* ]]; then
  echo "HAYASEND_DATABASE_URL must be an explicit PostgreSQL URL." >&2
  exit 1
fi
case "$HAYASEND_TRANSPORT" in
  console)
    if [[ -n "${HAYASEND_CONSOLE_PROOF_CONFIRM:-}" ]] &&
      [[ "$HAYASEND_CONSOLE_PROOF_CONFIRM" != "isolated-non-sending" ]]; then
      echo "HAYASEND_CONSOLE_PROOF_CONFIRM must equal isolated-non-sending." >&2
      exit 1
    fi
    export HAYASEND_CONSOLE_PROOF_CONFIRM="isolated-non-sending"
    ;;
  sendgrid)
    unset HAYASEND_CONSOLE_PROOF_CONFIRM
    : "${SENDGRID_API_KEY:?Export the same scoped SendGrid API key configured in production.}"
    : "${SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY:?Export the same SendGrid verification key configured in production.}"
    if [[ "$SENDGRID_API_KEY" != SG.* ]] ||
      [[ "${#SENDGRID_API_KEY}" -lt 32 ]] ||
      [[ "${#SENDGRID_API_KEY}" -gt 512 ]]; then
      echo "SENDGRID_API_KEY must be a 32 to 512 character SG. key." >&2
      exit 1
    fi
    if [[ "${#SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY}" -lt 64 ]] ||
      [[ "${#SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY}" -gt 16384 ]]; then
      echo "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY must contain the SendGrid verification key." >&2
      exit 1
    fi
    ;;
  *)
    echo "HAYASEND_TRANSPORT must be console or sendgrid for the Vercel pack." >&2
    exit 1
    ;;
esac
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
    HAYASEND_TRANSPORT="$HAYASEND_TRANSPORT" \
    HAYASEND_OBJECT_STORAGE=vercel-blob \
    npm run migrate:postgres
)

console_proof_environment=()
if [[ "$HAYASEND_TRANSPORT" == "console" ]]; then
  console_proof_environment=(
    --env
    "HAYASEND_CONSOLE_PROOF_CONFIRM=$HAYASEND_CONSOLE_PROOF_CONFIRM"
  )
fi

deployment="$(
  VERCEL_ORG_ID="$HAYASEND_VERCEL_ORG_ID" \
    VERCEL_PROJECT_ID="$HAYASEND_VERCEL_PROJECT_ID" \
    "$vercel_cli" deploy "$repository_root" \
      --prod \
      --yes \
      --env "HAYASEND_TRANSPORT=$HAYASEND_TRANSPORT" \
      "${console_proof_environment[@]}" \
      --project "$HAYASEND_VERCEL_PROJECT_ID"
)"
require_https_origin "Vercel deployment URL" "$deployment"
inspect_ready_deployment "$deployment"

"$pack_directory/verify.sh"

echo "HayaSend Vercel deployment: $deployment"
echo "HayaSend Vercel production API: $HAYASEND_VERCEL_API_URL"
