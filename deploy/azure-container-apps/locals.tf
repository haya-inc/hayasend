locals {
  deployment_id  = substr(sha256("${lower(var.subscription_id)}:${lower(var.resource_group_name)}:${var.name_prefix}"), 0, 12)
  compact_prefix = replace(var.name_prefix, "-", "")

  api_name             = "${var.name_prefix}-api"
  worker_name          = "${var.name_prefix}-worker"
  migration_name       = "${var.name_prefix}-migrate"
  hosted_proof_name    = "${var.name_prefix}-proof"
  environment_name     = "${var.name_prefix}-environment"
  infrastructure_rg    = "${var.name_prefix}-${local.deployment_id}-managed"
  log_analytics_name   = "${var.name_prefix}-logs"
  identity_name        = "${var.name_prefix}-runtime"
  network_name         = "${var.name_prefix}-network"
  postgres_name        = "${var.name_prefix}-${local.deployment_id}-postgres"
  storage_account_name = substr("${local.compact_prefix}${local.deployment_id}blob", 0, 24)
  attachment_container = "attachments"
  key_vault_name       = substr("${var.name_prefix}-${local.deployment_id}-kv", 0, 24)
  event_subscription   = substr("${local.compact_prefix}${local.deployment_id}emailevents", 0, 64)
  image_registry       = split("/", var.image)[0]
  uses_acr             = endswith(local.image_registry, ".azurecr.io")

  vnet_prefix_length = tonumber(split("/", var.vnet_cidr)[1])
  container_apps_cidr = cidrsubnet(
    var.vnet_cidr,
    23 - local.vnet_prefix_length,
    0,
  )
  postgres_cidr = cidrsubnet(
    var.vnet_cidr,
    24 - local.vnet_prefix_length,
    2,
  )
  private_endpoints_cidr = cidrsubnet(
    var.vnet_cidr,
    24 - local.vnet_prefix_length,
    3,
  )

  subscription_resource_id = "/subscriptions/${var.subscription_id}"
  communication_service_id = "${local.subscription_resource_id}/resourceGroups/${var.acs_resource_group_name}/providers/Microsoft.Communication/communicationServices/${var.acs_communication_service_name}"
  email_service_id         = "${local.subscription_resource_id}/resourceGroups/${var.acs_resource_group_name}/providers/Microsoft.Communication/emailServices/${var.acs_email_service_name}"
  email_domain_id          = "${local.email_service_id}/domains/${var.acs_email_domain_resource_name}"
  expected_event_topic     = lower(local.communication_service_id)

  database_url = "postgresql://${var.database_user}:${urlencode(var.database_password)}@${azurerm_postgresql_flexible_server.hayasend.fqdn}:5432/${var.database_name}?sslmode=require"

  tags = {
    application            = "hayasend"
    managed_by             = "terraform"
    runtime                = "portable-postgres"
    transport              = "azure-communication-services"
    hayasend_deployment_id = local.deployment_id
  }

  common_environment = {
    HAYASEND_MODE                      = "portable"
    HAYASEND_HOST                      = "0.0.0.0"
    HAYASEND_TRANSPORT                 = var.transport
    HAYASEND_OBJECT_STORAGE            = "azure-blob"
    HAYASEND_OBJECT_STORAGE_BUCKET     = azurerm_storage_container.attachments.name
    HAYASEND_REGION                    = var.location
    AZURE_LOCATION                     = var.location
    AZURE_CLIENT_ID                    = azurerm_user_assigned_identity.runtime.client_id
    AZURE_TENANT_ID                    = var.tenant_id
    AZURE_SUBSCRIPTION_ID              = var.subscription_id
    AZURE_RESOURCE_GROUP               = var.acs_resource_group_name
    AZURE_COMMUNICATION_SERVICE_NAME   = var.acs_communication_service_name
    AZURE_EMAIL_SERVICE_NAME           = var.acs_email_service_name
    AZURE_EMAIL_DOMAIN_RESOURCE_NAME   = var.acs_email_domain_resource_name
    AZURE_COMMUNICATION_EMAIL_ENDPOINT = trimsuffix(var.acs_email_endpoint, "/")
    AZURE_STORAGE_ACCOUNT_NAME         = azurerm_storage_account.attachments.name
  }

  shared_secret_environment = {
    HAYASEND_DATABASE_URL = "database-url"
    HAYASEND_API_KEY      = "api-key"
  }

  hosted_proof_environment = {
    HAYASEND_MODE                         = "portable"
    HAYASEND_TRANSPORT                    = "console"
    HAYASEND_CONSOLE_PROOF_CONFIRM        = "isolated-non-sending"
    HAYASEND_OBJECT_STORAGE               = "disabled"
    HAYASEND_HOSTED_PROOF_API_URL         = "https://${azurerm_container_app.api.ingress[0].fqdn}"
    HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS   = "30"
    HAYASEND_HOSTED_PROOF_TIMEOUT_SECONDS = "300"
  }
}

check "acr_configuration" {
  assert {
    condition     = !local.uses_acr || var.acr_resource_id != null
    error_message = "An azurecr.io image requires acr_resource_id so the runtime can use managed-identity AcrPull."
  }
}

check "key_vault_operator_path" {
  assert {
    condition     = length(var.key_vault_operator_ip_cidrs) > 0 || var.terraform_runner_has_private_vnet_access
    error_message = "Allow an exact Key Vault operator CIDR or explicitly confirm the Terraform runner has private VNet access."
  }
}

check "api_scaling" {
  assert {
    condition     = var.api_min_replicas <= var.api_max_replicas
    error_message = "api_min_replicas cannot exceed api_max_replicas."
  }
}

check "database_ha_sku" {
  assert {
    condition     = !var.database_high_availability_enabled || !startswith(var.database_sku_name, "B_")
    error_message = "Burstable PostgreSQL SKUs cannot be used with the production HA default."
  }
}

check "hosted_proof_job_safety" {
  assert {
    condition = (
      !var.enable_hosted_proof_job ||
      (
        !var.database_high_availability_enabled &&
        !var.deletion_protection &&
        !var.key_vault_purge_protection_enabled &&
        var.storage_soft_delete_days == 0
      )
    )
    error_message = "The hosted proof job requires an explicitly disposable, low-cost deployment with HA, deletion protection, Key Vault purge protection, and Blob soft delete disabled."
  }
}
