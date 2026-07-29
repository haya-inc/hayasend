#!/usr/bin/env bash
set -euo pipefail

deployment_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
cd "$deployment_directory"

: "${TF_VAR_subscription_id:?Set TF_VAR_subscription_id.}"
: "${TF_VAR_tenant_id:?Set TF_VAR_tenant_id.}"
: "${TF_VAR_acs_resource_group_name:?Set TF_VAR_acs_resource_group_name.}"
: "${TF_VAR_acs_communication_service_name:?Set TF_VAR_acs_communication_service_name.}"
: "${TF_VAR_acs_email_service_name:?Set TF_VAR_acs_email_service_name.}"
: "${TF_VAR_acs_email_domain_resource_name:?Set TF_VAR_acs_email_domain_resource_name.}"
: "${TF_VAR_acs_email_endpoint:?Set TF_VAR_acs_email_endpoint.}"
: "${AZURE_TERMINAL_FROM:?Set AZURE_TERMINAL_FROM to an exact controlled sender.}"

control_plane_api_version="$(
  tr -d '[:space:]' < .communication-control-plane-api-version
)"
if [[ "$control_plane_api_version" != "2026-03-18" ]]; then
  echo "The reviewed Azure Communication control-plane API version is required." >&2
  exit 1
fi
if [[ ! "$AZURE_TERMINAL_FROM" =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$ ]] ||
  [[ "$AZURE_TERMINAL_FROM" == *$'\n'* ]] ||
  [[ "$AZURE_TERMINAL_FROM" == *$'\r'* ]]; then
  echo "AZURE_TERMINAL_FROM must be a single controlled email address." >&2
  exit 1
fi
if [[ ! "$TF_VAR_acs_email_endpoint" =~ ^https://[A-Za-z0-9.-]+\.communication\.azure\.com/?$ ]]; then
  echo "TF_VAR_acs_email_endpoint must be a credential-free ACS HTTPS endpoint." >&2
  exit 1
fi

account_json="$(az account show --only-show-errors --output json)"
if [[ "$(jq --raw-output .id <<<"$account_json")" != "$TF_VAR_subscription_id" ]] ||
  [[ "$(jq --raw-output .tenantId <<<"$account_json")" != "$TF_VAR_tenant_id" ]]; then
  echo "Azure CLI is not authenticated to the exact configured subscription and tenant." >&2
  exit 1
fi

acs_group_json="$(
  az group show \
    --subscription "$TF_VAR_subscription_id" \
    --name "$TF_VAR_acs_resource_group_name" \
    --only-show-errors \
    --output json
)"
if ! jq --exit-status '
  .tags.hayasend_test == "true" and
  .tags.purpose == "hayasend-azure-integration"
' <<<"$acs_group_json" >/dev/null; then
  echo "The ACS resource group must be explicitly tagged as the dedicated HayaSend integration graph." >&2
  exit 1
fi

subscription_root="/subscriptions/$TF_VAR_subscription_id"
acs_id="$subscription_root/resourceGroups/$TF_VAR_acs_resource_group_name/providers/Microsoft.Communication/communicationServices/$TF_VAR_acs_communication_service_name"
email_service_id="$subscription_root/resourceGroups/$TF_VAR_acs_resource_group_name/providers/Microsoft.Communication/emailServices/$TF_VAR_acs_email_service_name"
domain_id="$email_service_id/domains/$TF_VAR_acs_email_domain_resource_name"
sender_username="${AZURE_TERMINAL_FROM%%@*}"
sender_domain="${AZURE_TERMINAL_FROM#*@}"
sender_username_uri="$(
  jq --null-input --raw-output \
    --arg value "$sender_username" \
    '$value | @uri'
)"
endpoint_host="${TF_VAR_acs_email_endpoint#https://}"
endpoint_host="${endpoint_host%/}"
acs_id_lower="$(tr '[:upper:]' '[:lower:]' <<<"$acs_id")"
email_service_id_lower="$(
  tr '[:upper:]' '[:lower:]' <<<"$email_service_id"
)"
domain_id_lower="$(tr '[:upper:]' '[:lower:]' <<<"$domain_id")"
endpoint_host_lower="$(tr '[:upper:]' '[:lower:]' <<<"$endpoint_host")"
sender_domain_lower="$(tr '[:upper:]' '[:lower:]' <<<"$sender_domain")"

acs_json="$(
  az rest \
    --method get \
    --url "https://management.azure.com${acs_id}?api-version=${control_plane_api_version}" \
    --only-show-errors \
    --output json
)"
if ! jq --exit-status \
  --arg id "$acs_id_lower" \
  --arg domain_id "$domain_id_lower" \
  --arg endpoint_host "$endpoint_host_lower" '
    (.id | ascii_downcase) == $id and
    (.properties.provisioningState | IN("Running", "Succeeded")) and
    (.properties.hostName | ascii_downcase) == $endpoint_host and
    (
      [.properties.linkedDomains[]? | ascii_downcase]
      | index($domain_id) != null
    )
  ' <<<"$acs_json" >/dev/null; then
  echo "The exact ready ACS resource, endpoint, and linked domain were not observed." >&2
  exit 1
fi

email_service_json="$(
  az rest \
    --method get \
    --url "https://management.azure.com${email_service_id}?api-version=${control_plane_api_version}" \
    --only-show-errors \
    --output json
)"
if ! jq --exit-status \
  --arg id "$email_service_id_lower" '
    (.id | ascii_downcase) == $id and
    (.properties.provisioningState | IN("Running", "Succeeded"))
  ' <<<"$email_service_json" >/dev/null; then
  echo "The exact Email Communication Services resource is not ready." >&2
  exit 1
fi

domain_json="$(
  az rest \
    --method get \
    --url "https://management.azure.com${domain_id}?api-version=${control_plane_api_version}" \
    --only-show-errors \
    --output json
)"
if ! jq --exit-status \
  --arg id "$domain_id_lower" \
  --arg from_domain "$sender_domain_lower" '
    (.id | ascii_downcase) == $id and
    .properties.domainManagement == "CustomerManaged" and
    (.properties.provisioningState | IN("Running", "Succeeded")) and
    (.properties.fromSenderDomain | ascii_downcase) == $from_domain and
    .properties.userEngagementTracking == "Enabled" and
    .properties.verificationStates.Domain.status == "Verified" and
    .properties.verificationStates.SPF.status == "Verified" and
    .properties.verificationStates.DKIM.status == "Verified" and
    .properties.verificationStates.DKIM2.status == "Verified"
  ' <<<"$domain_json" >/dev/null; then
  echo "The custom domain must be ready with Domain, SPF, DKIM, DKIM2, and engagement tracking enabled." >&2
  exit 1
fi

sender_json="$(
  az rest \
    --method get \
    --url "https://management.azure.com${domain_id}/senderUsernames/${sender_username_uri}?api-version=${control_plane_api_version}" \
    --only-show-errors \
    --output json
)"
if ! jq --exit-status \
  --arg username "$sender_username" '
    .properties.username == $username and
    (
      .properties.provisioningState == null or
      (.properties.provisioningState | IN("Running", "Succeeded"))
    )
  ' <<<"$sender_json" >/dev/null; then
  echo "The exact controlled ACS sender username is not ready." >&2
  exit 1
fi

inventory_json="$(
  az resource list \
    --subscription "$TF_VAR_subscription_id" \
    --resource-group "$TF_VAR_acs_resource_group_name" \
    --only-show-errors \
    --output json
)"
unexpected_inventory="$(
  jq \
    --arg acs_id "$acs_id_lower" \
    --arg email_service_id "$email_service_id_lower" \
    --arg domain_id "$domain_id_lower" '
      [
        .[]
        | . as $resource
        | ($resource.id | ascii_downcase) as $id
        | ($resource.type | ascii_downcase) as $type
        | select(
            $id != $acs_id and
            $id != $email_service_id and
            $id != $domain_id and
            !(
              $type ==
                "microsoft.communication/emailservices/domains/senderusernames" and
              ($id | startswith($domain_id + "/senderusernames/"))
            )
          )
        | {name, type}
      ]
    ' <<<"$inventory_json"
)"
if [[ "$(jq length <<<"$unexpected_inventory")" != "0" ]]; then
  echo "The dedicated ACS resource group contains an unexpected resource graph:" >&2
  jq . <<<"$unexpected_inventory" >&2
  exit 1
fi

evidence="$(
  jq --null-input \
    --arg control_plane_api_version "$control_plane_api_version" \
    --arg domain_management "$(
      jq --raw-output .properties.domainManagement <<<"$domain_json"
    )" \
    --arg domain_status "$(
      jq --raw-output .properties.verificationStates.Domain.status <<<"$domain_json"
    )" \
    --arg spf_status "$(
      jq --raw-output .properties.verificationStates.SPF.status <<<"$domain_json"
    )" \
    --arg dkim_status "$(
      jq --raw-output .properties.verificationStates.DKIM.status <<<"$domain_json"
    )" \
    --arg dkim2_status "$(
      jq --raw-output .properties.verificationStates.DKIM2.status <<<"$domain_json"
    )" \
    --arg dmarc_status "$(
      jq --raw-output '.properties.verificationStates.DMARC.status // "not_reported"' <<<"$domain_json"
    )" '
      {
        object: "azure_acs_prerequisite_evidence",
        control_plane_api_version: $control_plane_api_version,
        isolated_resource_graph: true,
        linked_custom_domain: true,
        controlled_sender_ready: true,
        domain_management: $domain_management,
        verification: {
          domain: $domain_status,
          spf: $spf_status,
          dkim: $dkim_status,
          dkim2: $dkim2_status,
          dmarc: $dmarc_status
        },
        engagement_tracking: "Enabled",
        documented_default_limits: {
          send_per_minute: 30,
          send_per_hour: 100,
          recipients_per_message: 50,
          request_megabytes: 10
        },
        proof_workload: {
          messages: 1,
          recipients: 2,
          within_documented_default_limits: true
        }
      }
    '
)"
if [[ -n "${HAYASEND_AZURE_ACS_EVIDENCE_FILE:-}" ]]; then
  printf '%s\n' "$evidence" > "$HAYASEND_AZURE_ACS_EVIDENCE_FILE"
fi
printf '%s\n' "$evidence"
