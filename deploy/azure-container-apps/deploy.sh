#!/usr/bin/env bash
set -euo pipefail

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
cd "$deployment_directory"

: "${TF_VAR_subscription_id:?Set TF_VAR_subscription_id.}"
: "${TF_VAR_tenant_id:?Set TF_VAR_tenant_id.}"
: "${TF_VAR_deployer_object_id:?Set TF_VAR_deployer_object_id.}"
: "${TF_VAR_image:?Set TF_VAR_image to an immutable sha256 image digest.}"
: "${TF_VAR_api_key:?Set TF_VAR_api_key without placing it on the command line.}"
: "${TF_VAR_database_password:?Set TF_VAR_database_password without placing it on the command line.}"
: "${TF_VAR_event_grid_secret:?Set TF_VAR_event_grid_secret independently from the API key.}"
: "${TF_VAR_acs_resource_group_name:?Set TF_VAR_acs_resource_group_name.}"
: "${TF_VAR_acs_communication_service_name:?Set TF_VAR_acs_communication_service_name.}"
: "${TF_VAR_acs_email_service_name:?Set TF_VAR_acs_email_service_name.}"
: "${TF_VAR_acs_email_domain_resource_name:?Set TF_VAR_acs_email_domain_resource_name.}"
: "${TF_VAR_acs_email_endpoint:?Set TF_VAR_acs_email_endpoint.}"

required_terraform_version="$(tr -d '[:space:]' < .terraform-version)"
terraform_version="$(terraform version -json | jq --raw-output .terraform_version)"
if [[ "$terraform_version" != "$required_terraform_version" ]]; then
  echo "Terraform $required_terraform_version is required; found $terraform_version." >&2
  exit 1
fi

required_azure_cli_version="$(tr -d '[:space:]' < .azure-cli-version)"
azure_cli_version="$(az version --output json | jq --raw-output '.["azure-cli"]')"
if [[ "$azure_cli_version" != "$required_azure_cli_version" ]]; then
  echo "Azure CLI $required_azure_cli_version is required; found $azure_cli_version." >&2
  exit 1
fi

for argument in "$@"; do
  if [[ "$argument" == -target* || "$argument" == -replace* || "$argument" == -destroy ]]; then
    echo "deploy.sh rejects destructive or caller-supplied targeting: $argument." >&2
    exit 1
  fi
done

account_json="$(az account show --only-show-errors --output json)"
if [[ "$(jq --raw-output .id <<<"$account_json")" != "$TF_VAR_subscription_id" ]] ||
  [[ "$(jq --raw-output .tenantId <<<"$account_json")" != "$TF_VAR_tenant_id" ]]; then
  echo "Azure CLI is not authenticated to the exact configured subscription and tenant." >&2
  exit 1
fi

for provider_namespace in \
  Microsoft.App \
  Microsoft.Communication \
  Microsoft.EventGrid \
  Microsoft.Insights \
  Microsoft.KeyVault \
  Microsoft.ManagedIdentity \
  Microsoft.Network \
  Microsoft.OperationalInsights \
  Microsoft.Storage \
  Microsoft.DBforPostgreSQL; do
  registration_state="$(
    az provider show \
      --namespace "$provider_namespace" \
      --query registrationState \
      --output tsv \
      --only-show-errors
  )"
  if [[ "$registration_state" != "Registered" ]]; then
    echo "$provider_namespace must be explicitly registered before deployment." >&2
    exit 1
  fi
done

docker buildx imagetools inspect "$TF_VAR_image" >/dev/null

terraform init -input=false -lockfile=readonly
terraform validate

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

reject_protected_deletes() {
  local plan_path="$1"
  local plan_json="$temporary_directory/plan.json"
  terraform show -json "$plan_path" > "$plan_json"
  if ! jq --exit-status '
    [
      .resource_changes[]?
      | select(
          (.type | IN(
            "azurerm_key_vault",
            "azurerm_postgresql_flexible_server",
            "azurerm_resource_group",
            "azurerm_storage_account"
          ))
          and (.change.actions | index("delete"))
        )
    ]
    | length == 0
  ' "$plan_json" >/dev/null; then
    echo "Deployment plan would delete or replace protected durable infrastructure." >&2
    exit 1
  fi
}

stage_plan="$temporary_directory/migration-stage.tfplan"
terraform plan \
  -input=false \
  -lock-timeout=5m \
  -out="$stage_plan" \
  -target=azurerm_container_app_job.migration \
  "$@"
reject_protected_deletes "$stage_plan"
terraform apply -input=false -lock-timeout=5m "$stage_plan"

migration_job="$(terraform output -raw migration_job_name)"
migration_execution="$(
  az containerapp job start \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "${TF_VAR_resource_group_name:-hayasend-azure}" \
    --name "$migration_job" \
    --only-show-errors \
    --output json \
    | jq --raw-output .name
)"
if [[ -z "$migration_execution" || "$migration_execution" == "null" ]]; then
  echo "Azure did not return a migration execution name." >&2
  exit 1
fi

for _ in {1..120}; do
  migration_status="$(
    az containerapp job execution show \
      --subscription "$TF_VAR_subscription_id" \
      --resource-group "${TF_VAR_resource_group_name:-hayasend-azure}" \
      --name "$migration_job" \
      --job-execution-name "$migration_execution" \
      --query properties.status \
      --output tsv \
      --only-show-errors
  )"
  case "$migration_status" in
    Succeeded)
      break
      ;;
    Failed | Canceled | Degraded)
      echo "Migration execution ended with status $migration_status." >&2
      exit 1
      ;;
  esac
  sleep 5
done
if [[ "$migration_status" != "Succeeded" ]]; then
  echo "Migration execution did not succeed within ten minutes." >&2
  exit 1
fi

full_plan="$temporary_directory/full.tfplan"
terraform plan \
  -input=false \
  -lock-timeout=5m \
  -out="$full_plan" \
  "$@"
reject_protected_deletes "$full_plan"
terraform apply -input=false -lock-timeout=5m "$full_plan"

export HAYASEND_AZURE_SUBSCRIPTION_ID="$TF_VAR_subscription_id"
export HAYASEND_AZURE_TENANT_ID="$TF_VAR_tenant_id"
export HAYASEND_AZURE_EVENT_SCOPE
HAYASEND_AZURE_EVENT_SCOPE="$(terraform output -raw event_subscription_scope)"
export HAYASEND_AZURE_EVENT_SUBSCRIPTION_NAME
HAYASEND_AZURE_EVENT_SUBSCRIPTION_NAME="$(terraform output -raw event_subscription_name)"
export HAYASEND_AZURE_API_URL
HAYASEND_AZURE_API_URL="$(terraform output -raw api_url)"
export HAYASEND_AZURE_DEPLOYMENT_ID
HAYASEND_AZURE_DEPLOYMENT_ID="$(terraform output -raw deployment_id)"
export HAYASEND_AZURE_EVENT_GRID_SECRET="$TF_VAR_event_grid_secret"
node event-grid.mjs ensure
unset HAYASEND_AZURE_EVENT_GRID_SECRET

./verify.sh
