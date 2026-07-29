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
required_containerapp_extension_version="$(
  tr -d '[:space:]' < .containerapp-extension-version
)"
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
containerapp_extension_version="$(
  az extension show \
    --name containerapp \
    --query version \
    --output tsv \
    --only-show-errors
)"
if [[ "$containerapp_extension_version" != "$required_containerapp_extension_version" ]]; then
  echo "Azure CLI containerapp extension $required_containerapp_extension_version is required; found $containerapp_extension_version." >&2
  exit 1
fi

terraform init -input=false -lockfile=readonly
resource_group="${TF_VAR_resource_group_name:-hayasend-azure}"
name_prefix="${TF_VAR_name_prefix:-hayasend}"
normalized_subscription="$(
  printf '%s' "$TF_VAR_subscription_id" |
    tr '[:upper:]' '[:lower:]'
)"
normalized_resource_group="$(
  printf '%s' "$resource_group" |
    tr '[:upper:]' '[:lower:]'
)"
deployment_id="$(
  printf '%s:%s:%s' \
    "$normalized_subscription" \
    "$normalized_resource_group" \
    "$name_prefix" |
    openssl dgst -sha256 -r |
    awk '{print substr($1, 1, 12)}'
)"
if [[ ! "$deployment_id" =~ ^[a-f0-9]{12}$ ]]; then
  echo "Unable to derive the exact Terraform deployment ID." >&2
  exit 1
fi
key_vault="${name_prefix}-${deployment_id}-kv"
key_vault="${key_vault:0:24}"
environment_name="${name_prefix}-environment"
infrastructure_group="${name_prefix}-${deployment_id}-managed"
role_definition_name="${name_prefix}-${deployment_id}-acs-runtime"
compact_prefix="${name_prefix//-/}"
event_subscription="${compact_prefix}${deployment_id}emailevents"

resource_group_exists="$(
  az group exists \
    --subscription "$TF_VAR_subscription_id" \
    --name "$resource_group" \
    --output tsv
)"
if [[ "$resource_group_exists" == "true" ]]; then
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

  resource_inventory="$(
    az resource list \
      --subscription "$TF_VAR_subscription_id" \
      --resource-group "$resource_group" \
      --only-show-errors \
      --output json
  )"
  unexpected_resources="$(
    jq --arg deployment_id "$deployment_id" '
          [
            .[]
            | select((.tags.hayasend_deployment_id // "") != $deployment_id)
            | {name, type}
          ]
        ' <<<"$resource_inventory"
  )"
  if [[ "$(jq length <<<"$unexpected_resources")" != "0" ]]; then
    echo "Refusing cleanup because the dedicated group contains unrecognized resources:" >&2
    jq . <<<"$unexpected_resources" >&2
    exit 1
  fi

  if actual_infrastructure_group="$(
    az containerapp env show \
      --subscription "$TF_VAR_subscription_id" \
      --resource-group "$resource_group" \
      --name "$environment_name" \
      --query properties.infrastructureResourceGroup \
      --output tsv \
      --only-show-errors 2>/dev/null
  )"; then
    if [[ "$actual_infrastructure_group" != "$infrastructure_group" ]]; then
      echo "Refusing cleanup because the managed infrastructure group does not match the deterministic Terraform name." >&2
      exit 1
    fi
  elif [[ "${HAYASEND_AZURE_ALLOW_PARTIAL:-}" != "true" ]]; then
    echo "The Container Apps environment is absent; set HAYASEND_AZURE_ALLOW_PARTIAL=true only for an interrupted disposable deployment." >&2
    exit 1
  fi
elif [[ "${HAYASEND_AZURE_ALLOW_PARTIAL:-}" != "true" ]]; then
  echo "The runtime resource group is absent; set HAYASEND_AZURE_ALLOW_PARTIAL=true only to converge interrupted cleanup." >&2
  exit 1
fi

vault_requires_purge=false
if [[ "$resource_group_exists" == "true" ]] &&
  jq --exit-status \
    --arg name "$key_vault" '
      [
        .[]
        | select(
            .name == $name and
            (.type | ascii_downcase) == "microsoft.keyvault/vaults"
          )
      ]
      | length == 1
    ' <<<"$resource_inventory" >/dev/null; then
  active_purge_protection="$(
    az keyvault show \
      --subscription "$TF_VAR_subscription_id" \
      --resource-group "$resource_group" \
      --name "$key_vault" \
      --query properties.enablePurgeProtection \
      --output tsv \
      --only-show-errors
  )"
  vault_requires_purge=true
  if [[ "$active_purge_protection" == "true" ]]; then
    echo "Refusing cleanup because Azure Key Vault purge protection is active and irreversible." >&2
    exit 1
  fi
fi
deleted_vault_inventory="$(
  az keyvault list-deleted \
  --subscription "$TF_VAR_subscription_id" \
  --resource-type vault \
  --only-show-errors \
  --output json
)"
deleted_vault_count="$(
  jq \
    --arg name "$key_vault" \
    --arg location "${TF_VAR_location:-japaneast}" '
      [
        .[]
        | select(
            .name == $name and
            ((.properties.location // .location) | ascii_downcase) ==
              ($location | ascii_downcase)
          )
      ]
      | length
    ' <<<"$deleted_vault_inventory"
)"
if [[ "$deleted_vault_count" == "1" ]]; then
  vault_requires_purge=true
elif [[ "$deleted_vault_count" != "0" ]]; then
  echo "The deleted Key Vault inventory is ambiguous." >&2
  exit 1
fi

export HAYASEND_AZURE_SUBSCRIPTION_ID="$TF_VAR_subscription_id"
export HAYASEND_AZURE_TENANT_ID="$TF_VAR_tenant_id"
export HAYASEND_AZURE_EVENT_SCOPE="/subscriptions/${TF_VAR_subscription_id}/resourceGroups/${TF_VAR_acs_resource_group_name}/providers/Microsoft.Communication/communicationServices/${TF_VAR_acs_communication_service_name}"
export HAYASEND_AZURE_EVENT_SUBSCRIPTION_NAME="$event_subscription"
unset HAYASEND_AZURE_API_URL
export HAYASEND_AZURE_DEPLOYMENT_ID="$deployment_id"
event_grid_deleted=true
if ! node event-grid-delete.mjs; then
  event_grid_deleted=false
  echo "Event Grid cleanup failed; continuing the disposable Terraform destroy before reporting failure." >&2
fi

if ! terraform destroy -input=false -lock-timeout=5m "$@"; then
  echo "Terraform destroy returned an error; verifying actual Azure residue before deciding cleanup status." >&2
fi

if [[ "$vault_requires_purge" == "true" ]]; then
  deleted_vault_ready=false
  for _ in {1..60}; do
    deleted_vault_count="$(
      az keyvault list-deleted \
        --subscription "$TF_VAR_subscription_id" \
        --resource-type vault \
        --only-show-errors \
        --output json |
        jq \
          --arg name "$key_vault" \
          --arg location "${TF_VAR_location:-japaneast}" '
            [
              .[]
              | select(
                  .name == $name and
                  ((.properties.location // .location) | ascii_downcase) ==
                    ($location | ascii_downcase)
                )
            ]
            | length
          '
    )"
    if [[ "$deleted_vault_count" == "1" ]]; then
      deleted_vault_ready=true
      break
    elif [[ "$deleted_vault_count" != "0" ]]; then
      echo "The deleted Key Vault inventory is ambiguous." >&2
      exit 1
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

  vault_absent=false
  for _ in {1..60}; do
    deleted_vault_count="$(
      az keyvault list-deleted \
        --subscription "$TF_VAR_subscription_id" \
        --resource-type vault \
        --only-show-errors \
        --output json |
        jq \
          --arg name "$key_vault" \
          --arg location "${TF_VAR_location:-japaneast}" '
            [
              .[]
              | select(
                  .name == $name and
                  ((.properties.location // .location) | ascii_downcase) ==
                    ($location | ascii_downcase)
                )
            ]
            | length
          '
    )"
    if [[ "$deleted_vault_count" == "0" ]]; then
      vault_absent=true
      break
    elif [[ "$deleted_vault_count" != "1" ]]; then
      echo "The deleted Key Vault inventory is ambiguous." >&2
      exit 1
    fi
    sleep 5
  done
  if [[ "$vault_absent" != "true" ]]; then
    echo "The deleted Key Vault remains recoverable after purge." >&2
    exit 1
  fi
fi

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
    if [[ "$infrastructure_delete_requested" == "false" ]]; then
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
    break
  fi
  sleep 5
done

if [[ "$group_exists" != "false" || "$infrastructure_exists" != "false" ]]; then
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
fi

role_definition_count="$(
  az role definition list \
    --name "$role_definition_name" \
    --subscription "$TF_VAR_subscription_id" \
    --only-show-errors \
    --output json |
    jq length
)"
if [[ "$role_definition_count" != "0" ]]; then
  echo "The disposable HayaSend ACS role definition remains after cleanup." >&2
  exit 1
fi
if [[ "$event_grid_deleted" != "true" ]]; then
  echo "Event Grid cleanup was not verified." >&2
  exit 1
fi

echo "Disposable Azure deployment has no active resource-group, recoverable Key Vault, Event Grid, or custom-role residue."
