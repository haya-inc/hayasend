#!/usr/bin/env bash
set -euo pipefail

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
cd "$deployment_directory"

if [[ "${HAYASEND_ALLOW_ROLLBACK:-}" != "cloud-run" ]]; then
  echo "Set HAYASEND_ALLOW_ROLLBACK=cloud-run to confirm the reviewed digest rollback." >&2
  exit 1
fi

: "${HAYASEND_ROLLBACK_IMAGE:?Set HAYASEND_ROLLBACK_IMAGE to the reviewed previous immutable digest.}"
if [[ ! "$HAYASEND_ROLLBACK_IMAGE" =~ ^ghcr\.io/haya-inc/hayasend@sha256:[a-f0-9]{64}$ ]]; then
  echo "HAYASEND_ROLLBACK_IMAGE must be an immutable official HayaSend GHCR digest." >&2
  exit 1
fi

export TF_VAR_image="$HAYASEND_ROLLBACK_IMAGE"
echo "Rollback preserves forward migrations and deploys the reviewed previous application digest."
./deploy.sh "$@"
