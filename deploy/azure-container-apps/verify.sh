#!/usr/bin/env bash
set -euo pipefail

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
cd "$deployment_directory"

: "${TF_VAR_subscription_id:?Set TF_VAR_subscription_id.}"
: "${TF_VAR_tenant_id:?Set TF_VAR_tenant_id.}"
: "${TF_VAR_image:?Set TF_VAR_image to the deployed immutable digest.}"

resource_group="${TF_VAR_resource_group_name:-hayasend-azure}"
account_json="$(az account show --only-show-errors --output json)"
if [[ "$(jq --raw-output .id <<<"$account_json")" != "$TF_VAR_subscription_id" ]] ||
  [[ "$(jq --raw-output .tenantId <<<"$account_json")" != "$TF_VAR_tenant_id" ]]; then
  echo "Azure CLI is not authenticated to the exact configured subscription and tenant." >&2
  exit 1
fi

terraform init -input=false -lockfile=readonly >/dev/null

api_name="$(terraform output -raw api_name)"
worker_name="$(terraform output -raw worker_name)"
migration_job="$(terraform output -raw migration_job_name)"
runtime_identity="$(terraform output -raw runtime_identity_id)"
postgres_server="$(terraform output -raw postgres_server_name)"
storage_account="$(terraform output -raw storage_account_name)"
attachment_container="$(terraform output -raw attachment_container_name)"
key_vault="$(terraform output -raw key_vault_name)"
api_url="$(terraform output -raw api_url)"

api_json="$(
  az containerapp show \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$resource_group" \
    --name "$api_name" \
    --only-show-errors \
    --output json
)"
jq --exit-status \
  --arg image "$TF_VAR_image" \
  --arg identity "$runtime_identity" '
    .properties.template.containers[0].image == $image
    and .properties.configuration.ingress.external == true
    and .properties.configuration.ingress.allowInsecure == false
    and (.identity.userAssignedIdentities | has($identity))
  ' <<<"$api_json" >/dev/null

worker_json="$(
  az containerapp show \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$resource_group" \
    --name "$worker_name" \
    --only-show-errors \
    --output json
)"
jq --exit-status \
  --arg image "$TF_VAR_image" \
  --arg identity "$runtime_identity" '
    .properties.template.containers[0].image == $image
    and .properties.template.scale.minReplicas >= 1
    and .properties.template.scale.maxReplicas == .properties.template.scale.minReplicas
    and (.identity.userAssignedIdentities | has($identity))
  ' <<<"$worker_json" >/dev/null

job_json="$(
  az containerapp job show \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$resource_group" \
    --name "$migration_job" \
    --only-show-errors \
    --output json
)"
jq --exit-status \
  --arg image "$TF_VAR_image" \
  --arg identity "$runtime_identity" '
    .properties.template.containers[0].image == $image
    and .properties.configuration.replicaRetryLimit == 0
    and (.identity.userAssignedIdentities | has($identity))
  ' <<<"$job_json" >/dev/null

postgres_json="$(
  az postgres flexible-server show \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$resource_group" \
    --name "$postgres_server" \
    --only-show-errors \
    --output json
)"
jq --exit-status '
  .version == "18"
  and .network.publicNetworkAccess == "Disabled"
  and (.backup.backupRetentionDays >= 7)
' <<<"$postgres_json" >/dev/null

storage_json="$(
  az storage account show \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$resource_group" \
    --name "$storage_account" \
    --only-show-errors \
    --output json
)"
jq --exit-status '
  .allowBlobPublicAccess == false
  and .allowSharedKeyAccess == false
  and .minimumTlsVersion == "TLS1_2"
  and .enableHttpsTrafficOnly == true
' <<<"$storage_json" >/dev/null

container_access="$(
  az storage container show \
    --account-name "$storage_account" \
    --name "$attachment_container" \
    --auth-mode login \
    --query properties.publicAccess \
    --output tsv \
    --only-show-errors
)"
if [[ -n "$container_access" && "$container_access" != "None" ]]; then
  echo "Attachment container unexpectedly allows public access." >&2
  exit 1
fi

key_vault_json="$(
  az keyvault show \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$resource_group" \
    --name "$key_vault" \
    --only-show-errors \
    --output json
)"
jq --exit-status '
  .properties.enableRbacAuthorization == true
  and .properties.networkAcls.defaultAction == "Deny"
' <<<"$key_vault_json" >/dev/null

curl --fail --silent --show-error "$api_url/readyz" >/dev/null

export HAYASEND_AZURE_SUBSCRIPTION_ID="$TF_VAR_subscription_id"
export HAYASEND_AZURE_TENANT_ID="$TF_VAR_tenant_id"
export HAYASEND_AZURE_EVENT_SCOPE
HAYASEND_AZURE_EVENT_SCOPE="$(terraform output -raw event_subscription_scope)"
export HAYASEND_AZURE_EVENT_SUBSCRIPTION_NAME
HAYASEND_AZURE_EVENT_SUBSCRIPTION_NAME="$(terraform output -raw event_subscription_name)"
export HAYASEND_AZURE_API_URL="$api_url"
export HAYASEND_AZURE_DEPLOYMENT_ID
HAYASEND_AZURE_DEPLOYMENT_ID="$(terraform output -raw deployment_id)"
node event-grid.mjs verify

echo "HayaSend Azure runtime is ready at $api_url"
