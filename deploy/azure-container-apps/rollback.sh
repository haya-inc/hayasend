#!/usr/bin/env bash
set -euo pipefail

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
cd "$deployment_directory"

if [[ "${HAYASEND_ALLOW_ROLLBACK:-}" != "azure-container-apps" ]]; then
  echo "Set HAYASEND_ALLOW_ROLLBACK=azure-container-apps to confirm the reviewed digest rollback." >&2
  exit 1
fi

: "${TF_VAR_image:?Set TF_VAR_image to the reviewed previous immutable digest.}"

echo "Rollback keeps forward migrations and deploys the reviewed previous application digest."
./deploy.sh "$@"
