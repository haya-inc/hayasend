output "api_url" {
  description = "Public HTTPS URL of the HayaSend Container App."
  value       = "https://${azurerm_container_app.api.ingress[0].fqdn}"
}

output "api_name" {
  description = "Azure Container App running the HayaSend API."
  value       = azurerm_container_app.api.name
}

output "worker_name" {
  description = "Azure Container App running the durable HayaSend worker."
  value       = azurerm_container_app.worker.name
}

output "migration_job_name" {
  description = "Manual Container Apps Job that applies checksum-pinned forward migrations."
  value       = azurerm_container_app_job.migration.name
}

output "runtime_identity_id" {
  description = "User-assigned managed identity shared by the API, worker, and migration job."
  value       = azurerm_user_assigned_identity.runtime.id
}

output "runtime_identity_client_id" {
  description = "Client ID selected by DefaultAzureCredential inside the containers."
  value       = azurerm_user_assigned_identity.runtime.client_id
}

output "postgres_server_name" {
  description = "Private PostgreSQL Flexible Server 18 resource name."
  value       = azurerm_postgresql_flexible_server.hayasend.name
}

output "storage_account_name" {
  description = "Storage account containing private HayaSend attachment blobs."
  value       = azurerm_storage_account.attachments.name
}

output "attachment_container_name" {
  description = "Private attachment Blob container."
  value       = azurerm_storage_container.attachments.name
}

output "key_vault_name" {
  description = "Key Vault containing write-only-managed runtime secrets."
  value       = azurerm_key_vault.hayasend.name
}

output "event_subscription_name" {
  description = "Deterministic Event Grid subscription managed by event-grid.mjs outside Terraform secret state."
  value       = local.event_subscription
}

output "event_subscription_scope" {
  description = "Exact ACS resource scope from which HayaSend accepts Event Grid events."
  value       = local.communication_service_id
}

output "expected_event_topic" {
  description = "Lowercase Event Grid topic HayaSend verifies before accepting an event."
  value       = local.expected_event_topic
}

output "container_app_environment_name" {
  description = "Azure Container Apps environment."
  value       = azurerm_container_app_environment.hayasend.name
}

output "infrastructure_resource_group_name" {
  description = "Dedicated Azure-managed Container Apps infrastructure resource group."
  value       = local.infrastructure_rg
}

output "deployment_id" {
  description = "Deterministic tag used by guarded cleanup inventory checks."
  value       = local.deployment_id
}
