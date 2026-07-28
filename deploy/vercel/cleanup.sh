#!/usr/bin/env bash
set -euo pipefail

if [[ "${HAYASEND_ALLOW_DESTROY:-}" != "vercel" ]]; then
  echo "Set HAYASEND_ALLOW_DESTROY=vercel to confirm destructive cleanup." >&2
  exit 1
fi
if [[ "${HAYASEND_VERCEL_DEDICATED_PROJECT:-}" != "true" ]]; then
  echo "Set HAYASEND_VERCEL_DEDICATED_PROJECT=true only for an isolated proof project." >&2
  exit 1
fi
if [[ "${HAYASEND_EXTERNAL_POSTGRES_CLEANUP_CONFIRMED:-}" != "true" ]]; then
  echo "Remove the external PostgreSQL database and backups, then set HAYASEND_EXTERNAL_POSTGRES_CLEANUP_CONFIRMED=true." >&2
  exit 1
fi

# shellcheck source=deploy/vercel/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_vercel_cli
require_project_inputs
assert_linked_project

: "${HAYASEND_VERCEL_BLOB_STORE_ID:?Set the exact dedicated store_* ID.}"
: "${BLOB_READ_WRITE_TOKEN:?Export the dedicated private Blob store token.}"
if [[ ! "$HAYASEND_VERCEL_BLOB_STORE_ID" =~ ^store_[A-Za-z0-9]+$ ]]; then
  echo "HAYASEND_VERCEL_BLOB_STORE_ID must be an exact store_* ID." >&2
  exit 1
fi

VERCEL_ORG_ID="$HAYASEND_VERCEL_ORG_ID" \
  VERCEL_PROJECT_ID="$HAYASEND_VERCEL_PROJECT_ID" \
  "$vercel_cli" blob get-store "$HAYASEND_VERCEL_BLOB_STORE_ID" \
    --cwd "$repository_root" \
    --non-interactive \
    --no-color >/dev/null

objects="$(node "$pack_directory/blob-count.mjs")"
if ! jq --exit-status '.count == 0' <<<"$objects" >/dev/null; then
  echo "The Vercel Blob store is not empty; cleanup refused." >&2
  exit 1
fi

VERCEL_ORG_ID="$HAYASEND_VERCEL_ORG_ID" \
  VERCEL_PROJECT_ID="$HAYASEND_VERCEL_PROJECT_ID" \
  "$vercel_cli" blob delete-store "$HAYASEND_VERCEL_BLOB_STORE_ID" \
    --cwd "$repository_root" \
    --yes

echo "The dedicated Blob store was deleted."
echo "Vercel project deletion requires interactive confirmation for the exact project below:"
echo "  $HAYASEND_VERCEL_PROJECT_NAME"
"$vercel_cli" project rm "$HAYASEND_VERCEL_PROJECT_NAME" \
  --cwd "$repository_root"

if VERCEL_ORG_ID="$HAYASEND_VERCEL_ORG_ID" \
  VERCEL_PROJECT_ID="$HAYASEND_VERCEL_PROJECT_ID" \
  "$vercel_cli" project inspect "$HAYASEND_VERCEL_PROJECT_NAME" \
    --cwd "$repository_root" \
    --non-interactive \
    --no-color >/dev/null 2>&1; then
  echo "The Vercel project remains visible; verify pending deletion and billing." >&2
  exit 1
fi

echo "The dedicated HayaSend Vercel project is absent."
