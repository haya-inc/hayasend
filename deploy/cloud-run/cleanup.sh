#!/usr/bin/env bash
set -euo pipefail

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
cd "$deployment_directory"

if [[ "${HAYASEND_ALLOW_DESTROY:-}" != "cloud-run" ]]; then
  echo "Set HAYASEND_ALLOW_DESTROY=cloud-run to confirm this destructive cleanup." >&2
  exit 1
fi

: "${TF_VAR_project_id:?Set TF_VAR_project_id.}"
: "${TF_VAR_image:?Set TF_VAR_image.}"
: "${TF_VAR_api_key:?Set TF_VAR_api_key.}"
: "${TF_VAR_database_password:?Set TF_VAR_database_password.}"

terraform_version="$(terraform version -json | jq --raw-output .terraform_version)"
if [[ "$terraform_version" != 1.15.* ]]; then
  echo "Terraform 1.15.x is required; found $terraform_version." >&2
  exit 1
fi

if [[ "${TF_VAR_deletion_protection:-}" != "false" ]]; then
  echo "Set TF_VAR_deletion_protection=false before cleanup." >&2
  exit 1
fi
if [[ "${TF_VAR_force_destroy_attachment_bucket:-}" != "true" ]]; then
  echo "Set TF_VAR_force_destroy_attachment_bucket=true before cleanup." >&2
  exit 1
fi
if [[ "${TF_VAR_bucket_soft_delete_retention_seconds:-}" != "0" ]]; then
  echo "Set TF_VAR_bucket_soft_delete_retention_seconds=0 only for a disposable deployment." >&2
  exit 1
fi

terraform init -input=false -lockfile=readonly

for argument in "$@"; do
  if [[ "$argument" == -target* || "$argument" == -replace* || "$argument" == -destroy ]]; then
    echo "cleanup.sh owns the complete staged destroy; remove $argument." >&2
    exit 1
  fi
done

allow_partial="${HAYASEND_CLOUD_RUN_ALLOW_PARTIAL:-false}"
if [[ "$allow_partial" != "true" && "$allow_partial" != "false" ]]; then
  echo "HAYASEND_CLOUD_RUN_ALLOW_PARTIAL must be true or false." >&2
  exit 1
fi

if [[ "$allow_partial" == "true" ]]; then
  if [[ -z "$(terraform state list)" ]]; then
    "$deployment_directory/verify-zero-residue.sh"
    exit 0
  fi
else
  terraform apply -input=false -lock-timeout=5m "$@"
fi
terraform destroy -input=false -lock-timeout=5m "$@"
"$deployment_directory/verify-zero-residue.sh"
