#!/usr/bin/env bash
set -euo pipefail

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
cd "$deployment_directory"

if [[ "${HAYASEND_ALLOW_DESTROY:-}" != "azure-container-apps" ]]; then
  echo "Set HAYASEND_ALLOW_DESTROY=azure-container-apps to confirm disposable cleanup." >&2
  exit 1
fi
if [[ "${HAYASEND_ALLOW_PURGE_KEY_VAULT:-}" != "azure-container-apps" ]]; then
  echo "Set HAYASEND_ALLOW_PURGE_KEY_VAULT=azure-container-apps for zero-residue disposable cleanup." >&2
  exit 1
fi

: "${TF_VAR_subscription_id:?Set TF_VAR_subscription_id.}"
: "${TF_VAR_tenant_id:?Set TF_VAR_tenant_id.}"
: "${TF_VAR_deployer_object_id:?Set TF_VAR_deployer_object_id.}"
: "${TF_VAR_image:?Set TF_VAR_image.}"
: "${TF_VAR_api_key:?Set TF_VAR_api_key.}"
: "${TF_VAR_database_password:?Set TF_VAR_database_password.}"
: "${TF_VAR_event_grid_secret:?Set TF_VAR_event_grid_secret.}"
: "${TF_VAR_acs_resource_group_name:?Set TF_VAR_acs_resource_group_name.}"
: "${TF_VAR_acs_communication_service_name:?Set TF_VAR_acs_communication_service_name.}"
: "${TF_VAR_acs_email_service_name:?Set TF_VAR_acs_email_service_name.}"
: "${TF_VAR_acs_email_domain_resource_name:?Set TF_VAR_acs_email_domain_resource_name.}"
: "${TF_VAR_acs_email_endpoint:?Set TF_VAR_acs_email_endpoint.}"

if [[ "${TF_VAR_deletion_protection:-}" != "false" ]]; then
  echo "Set TF_VAR_deletion_protection=false before disposable cleanup." >&2
  exit 1
fi
if [[ "${TF_VAR_key_vault_purge_protection_enabled:-}" != "false" ]]; then
  echo "Set TF_VAR_key_vault_purge_protection_enabled=false only for a disposable deployment." >&2
  exit 1
fi
if [[ "${TF_VAR_storage_soft_delete_days:-}" != "0" ]]; then
  echo "Set TF_VAR_storage_soft_delete_days=0 only for a disposable deployment." >&2
  exit 1
fi

for argument in "$@"; do
  if [[ "$argument" == -target* || "$argument" == -replace* || "$argument" == -destroy ]]; then
    echo "cleanup.sh owns the complete destroy; remove $argument." >&2
    exit 1
  fi
done

account_json="$(az account show --only-show-errors --output json)"
if [[ "$(jq --raw-output .id <<<"$account_json")" != "$TF_VAR_subscription_id" ]] ||
  [[ "$(jq --raw-output .tenantId <<<"$account_json")" != "$TF_VAR_tenant_id" ]]; then
  echo "Azure CLI is not authenticated to the exact configured subscription and tenant." >&2
  exit 1
fi

terraform init -input=false -lockfile=readonly
resource_group="${TF_VAR_resource_group_name:-hayasend-azure}"
deployment_id="$(terraform output -raw deployment_id)"
key_vault="$(terraform output -raw key_vault_name)"
infrastructure_group="$(terraform output -raw infrastructure_resource_group_name)"
environment_name="$(terraform output -raw container_app_environment_name)"

actual_infrastructure_group="$(
  az containerapp env show \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$resource_group" \
    --name "$environment_name" \
    --query properties.infrastructureResourceGroup \
    --output tsv \
    --only-show-errors
)"
if [[ "$actual_infrastructure_group" != "$infrastructure_group" ]]; then
  echo "Refusing cleanup because the managed infrastructure group does not match Terraform output." >&2
  exit 1
fi

active_purge_protection="$(
  az keyvault show \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$resource_group" \
    --name "$key_vault" \
    --query properties.enablePurgeProtection \
    --output tsv \
    --only-show-errors
)"
if [[ "$active_purge_protection" == "true" ]]; then
  echo "Refusing cleanup because Azure Key Vault purge protection is active and irreversible." >&2
  exit 1
fi

dedicated_tag="$(
  az group show \
    --subscription "$TF_VAR_subscription_id" \
    --name "$resource_group" \
    --query tags.hayasend_dedicated \
    --output tsv \
    --only-show-errors
)"
if [[ "$dedicated_tag" != "true" ]]; then
  echo "Refusing cleanup because the resource group is not marked as dedicated." >&2
  exit 1
fi

unexpected_resources="$(
  az resource list \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$resource_group" \
    --only-show-errors \
    --output json \
    | jq --arg deployment_id "$deployment_id" '
        [
          .[]
          | select((.tags.hayasend_deployment_id // "") != $deployment_id)
          | {name, type}
        ]
      '
)"
if [[ "$(jq length <<<"$unexpected_resources")" != "0" ]]; then
  echo "Refusing cleanup because the dedicated group contains unrecognized resources:" >&2
  jq . <<<"$unexpected_resources" >&2
  exit 1
fi

export HAYASEND_AZURE_SUBSCRIPTION_ID="$TF_VAR_subscription_id"
export HAYASEND_AZURE_TENANT_ID="$TF_VAR_tenant_id"
export HAYASEND_AZURE_EVENT_SCOPE
HAYASEND_AZURE_EVENT_SCOPE="$(terraform output -raw event_subscription_scope)"
export HAYASEND_AZURE_EVENT_SUBSCRIPTION_NAME
HAYASEND_AZURE_EVENT_SUBSCRIPTION_NAME="$(terraform output -raw event_subscription_name)"
export HAYASEND_AZURE_API_URL
HAYASEND_AZURE_API_URL="$(terraform output -raw api_url)"
export HAYASEND_AZURE_DEPLOYMENT_ID="$deployment_id"
node event-grid.mjs delete

terraform apply -input=false -lock-timeout=5m "$@"
terraform destroy -input=false -lock-timeout=5m "$@"

deleted_vault_ready=false
for _ in {1..60}; do
  if az keyvault show-deleted \
    --subscription "$TF_VAR_subscription_id" \
    --name "$key_vault" \
    --location "${TF_VAR_location:-japaneast}" \
    --only-show-errors \
    >/dev/null 2>&1; then
    deleted_vault_ready=true
    break
  fi
  sleep 5
done
if [[ "$deleted_vault_ready" != "true" ]]; then
  echo "Deleted Key Vault did not become purgeable within five minutes." >&2
  exit 1
fi

az keyvault purge \
  --subscription "$TF_VAR_subscription_id" \
  --name "$key_vault" \
  --location "${TF_VAR_location:-japaneast}" \
  --only-show-errors

infrastructure_delete_requested=false
for _ in {1..120}; do
  group_exists="$(
    az group exists \
      --subscription "$TF_VAR_subscription_id" \
      --name "$resource_group" \
      --output tsv
  )"
  infrastructure_exists="$(
    az group exists \
      --subscription "$TF_VAR_subscription_id" \
      --name "$infrastructure_group" \
      --output tsv
  )"
  if [[ "$group_exists" == "false" && "$infrastructure_exists" == "true" ]]; then
    infrastructure_resource_count="$(
      az resource list \
        --subscription "$TF_VAR_subscription_id" \
        --resource-group "$infrastructure_group" \
        --only-show-errors \
        --output json \
        | jq length
    )"
    if [[ "$infrastructure_resource_count" == "0" &&
      "$infrastructure_delete_requested" == "false" ]]; then
      az group delete \
        --subscription "$TF_VAR_subscription_id" \
        --name "$infrastructure_group" \
        --yes \
        --no-wait \
        --only-show-errors
      infrastructure_delete_requested=true
    fi
  fi
  if [[ "$group_exists" == "false" && "$infrastructure_exists" == "false" ]]; then
    echo "Disposable Azure deployment has no active resource-group residue."
    exit 0
  fi
  sleep 5
done

echo "Azure resource-group residue remains after ten minutes; investigate before claiming cleanup." >&2
if [[ "$infrastructure_exists" == "true" ]]; then
  az resource list \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$infrastructure_group" \
    --query '[].{name:name,type:type}' \
    --only-show-errors \
    --output json >&2
fi
exit 1
