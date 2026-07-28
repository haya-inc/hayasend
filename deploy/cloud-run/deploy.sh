#!/usr/bin/env bash
set -euo pipefail

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
cd "$deployment_directory"

: "${TF_VAR_project_id:?Set TF_VAR_project_id.}"
: "${TF_VAR_image:?Set TF_VAR_image to an immutable sha256 image digest.}"
: "${TF_VAR_api_key:?Set TF_VAR_api_key without placing it on the command line.}"
: "${TF_VAR_database_password:?Set TF_VAR_database_password without placing it on the command line.}"

terraform_version="$(terraform version -json | jq --raw-output .terraform_version)"
if [[ "$terraform_version" != 1.15.* ]]; then
  echo "Terraform 1.15.x is required; found $terraform_version." >&2
  exit 1
fi

terraform init -input=false -lockfile=readonly
terraform validate

for argument in "$@"; do
  if [[ "$argument" == -target* || "$argument" == -replace* || "$argument" == -destroy ]]; then
    echo "deploy.sh rejects destructive or caller-supplied targeting: $argument." >&2
    exit 1
  fi
done

terraform apply -input=false -lock-timeout=5m "$@" \
  -target=google_cloud_run_v2_job.migration

migration_job="$(terraform output -raw migration_job_name)"
region="${TF_VAR_region:-asia-northeast1}"
gcloud run jobs execute "$migration_job" \
  --project="$TF_VAR_project_id" \
  --region="$region" \
  --wait

terraform apply -input=false -lock-timeout=5m "$@"

api_url="$(terraform output -raw api_url)"
if [[ "$(terraform output -raw api_is_public)" == "true" ]]; then
  curl --fail --silent --show-error "$api_url/readyz" >/dev/null
else
  identity_token="$(gcloud auth print-identity-token)"
  curl --fail --silent --show-error \
    --header "Authorization: Bearer $identity_token" \
    "$api_url/readyz" >/dev/null
fi

echo "HayaSend is ready at $api_url"
