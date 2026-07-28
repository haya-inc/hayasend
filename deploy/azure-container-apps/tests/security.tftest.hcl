mock_provider "azurerm" {}

run "secure_foundation_defaults" {
  command = plan

  override_resource {
    target          = azurerm_user_assigned_identity.runtime
    override_during = plan
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/hayasend-azure/providers/Microsoft.ManagedIdentity/userAssignedIdentities/hayasend-runtime"
      client_id    = "10000000-0000-0000-0000-000000000000"
      principal_id = "20000000-0000-0000-0000-000000000000"
      tenant_id    = "00000000-0000-0000-0000-000000000000"
    }
  }

  override_resource {
    target          = azurerm_postgresql_flexible_server.hayasend
    override_during = plan
    values = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/hayasend-azure/providers/Microsoft.DBforPostgreSQL/flexibleServers/hayasend-postgres"
      fqdn = "hayasend.private.postgres.database.azure.com"
    }
  }

  variables {
    subscription_id                = "00000000-0000-0000-0000-000000000000"
    tenant_id                      = "00000000-0000-0000-0000-000000000000"
    deployer_object_id             = "30000000-0000-0000-0000-000000000000"
    image                          = "ghcr.io/haya-inc/hayasend@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    api_key                        = "re_test_test_test_test_test_test_test"
    database_password              = "test-test-test-test-test-test-test-test"
    event_grid_secret              = "event-grid-test-test-test-test-test"
    acs_resource_group_name        = "hayasend-email"
    acs_communication_service_name = "hayasend-communication"
    acs_email_service_name         = "hayasend-email"
    acs_email_domain_resource_name = "example.com"
    acs_email_endpoint             = "https://hayasend-communication.communication.azure.com"
    key_vault_operator_ip_cidrs    = ["203.0.113.10/32"]
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.hayasend.version == "18"
    error_message = "Azure PostgreSQL must use major version 18."
  }

  assert {
    condition     = !azurerm_postgresql_flexible_server.hayasend.public_network_access_enabled
    error_message = "Azure PostgreSQL must not have a public endpoint."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.hayasend.backup_retention_days == 14
    error_message = "PostgreSQL must retain point-in-time backups for 14 days by default."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.hayasend.high_availability[0].mode == "ZoneRedundant"
    error_message = "PostgreSQL must use zone-redundant HA by default."
  }

  assert {
    condition     = !azurerm_storage_account.attachments.allow_nested_items_to_be_public
    error_message = "Blob items must never allow anonymous public access."
  }

  assert {
    condition     = !azurerm_storage_account.attachments.shared_access_key_enabled
    error_message = "Storage shared keys must be disabled."
  }

  assert {
    condition     = azurerm_storage_container.attachments.container_access_type == "private"
    error_message = "The attachment container must remain private."
  }

  assert {
    condition     = azurerm_key_vault.hayasend.rbac_authorization_enabled
    error_message = "Key Vault must use Azure RBAC."
  }

  assert {
    condition     = azurerm_key_vault.hayasend.network_acls[0].default_action == "Deny"
    error_message = "Key Vault public access must default-deny."
  }

  assert {
    condition     = azurerm_container_app_job.migration.replica_retry_limit == 0
    error_message = "Migration failure must not be hidden by automatic job retries."
  }

  assert {
    condition     = azurerm_container_app.api.template[0].container[0].image == var.image
    error_message = "The API must use the immutable caller-supplied image digest."
  }

  assert {
    condition     = azurerm_container_app.worker.template[0].container[0].image == var.image
    error_message = "The worker must use the same immutable image digest."
  }

  assert {
    condition     = azurerm_container_app.worker.template[0].min_replicas == 1 && azurerm_container_app.worker.template[0].max_replicas == 1
    error_message = "The PostgreSQL recovery worker must remain continuously available by default."
  }

  assert {
    condition     = length(azurerm_management_lock.runtime) == 1
    error_message = "The dedicated runtime resource group must be deletion-protected by default."
  }
}

run "disposable_cleanup_requires_explicit_weaker_settings" {
  command = plan

  override_resource {
    target          = azurerm_user_assigned_identity.runtime
    override_during = plan
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/hayasend-azure/providers/Microsoft.ManagedIdentity/userAssignedIdentities/hayasend-runtime"
      client_id    = "10000000-0000-0000-0000-000000000000"
      principal_id = "20000000-0000-0000-0000-000000000000"
      tenant_id    = "00000000-0000-0000-0000-000000000000"
    }
  }

  override_resource {
    target          = azurerm_postgresql_flexible_server.hayasend
    override_during = plan
    values = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/hayasend-azure/providers/Microsoft.DBforPostgreSQL/flexibleServers/hayasend-postgres"
      fqdn = "hayasend.private.postgres.database.azure.com"
    }
  }

  variables {
    subscription_id                    = "00000000-0000-0000-0000-000000000000"
    tenant_id                          = "00000000-0000-0000-0000-000000000000"
    deployer_object_id                 = "30000000-0000-0000-0000-000000000000"
    image                              = "ghcr.io/haya-inc/hayasend@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    api_key                            = "re_test_test_test_test_test_test_test"
    database_password                  = "test-test-test-test-test-test-test-test"
    event_grid_secret                  = "event-grid-test-test-test-test-test"
    acs_resource_group_name            = "hayasend-email"
    acs_communication_service_name     = "hayasend-communication"
    acs_email_service_name             = "hayasend-email"
    acs_email_domain_resource_name     = "example.com"
    acs_email_endpoint                 = "https://hayasend-communication.communication.azure.com"
    key_vault_operator_ip_cidrs        = ["203.0.113.10/32"]
    database_high_availability_enabled = false
    database_sku_name                  = "B_Standard_B1ms"
    deletion_protection                = false
    key_vault_purge_protection_enabled = false
    storage_soft_delete_days           = 0
  }

  assert {
    condition     = length(azurerm_management_lock.runtime) == 0
    error_message = "Disposable cleanup must remove the resource-group lock explicitly."
  }

  assert {
    condition     = length(azurerm_postgresql_flexible_server.hayasend.high_availability) == 0
    error_message = "A disposable low-cost proof may explicitly disable PostgreSQL HA."
  }

  assert {
    condition     = !azurerm_key_vault.hayasend.purge_protection_enabled
    error_message = "A disposable zero-residue proof must explicitly disable Key Vault purge protection."
  }
}

run "key_vault_access_path_fails_closed" {
  command = plan

  variables {
    subscription_id                = "00000000-0000-0000-0000-000000000000"
    tenant_id                      = "00000000-0000-0000-0000-000000000000"
    deployer_object_id             = "30000000-0000-0000-0000-000000000000"
    image                          = "ghcr.io/haya-inc/hayasend@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    api_key                        = "re_test_test_test_test_test_test_test"
    database_password              = "test-test-test-test-test-test-test-test"
    event_grid_secret              = "event-grid-test-test-test-test-test"
    acs_resource_group_name        = "hayasend-email"
    acs_communication_service_name = "hayasend-communication"
    acs_email_service_name         = "hayasend-email"
    acs_email_domain_resource_name = "example.com"
    acs_email_endpoint             = "https://hayasend-communication.communication.azure.com"
  }

  expect_failures = [check.key_vault_operator_path]
}
