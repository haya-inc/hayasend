resource "azurerm_resource_group" "hayasend" {
  name     = var.resource_group_name
  location = var.location
  tags = merge(local.tags, {
    hayasend_dedicated = "true"
  })
}

resource "azurerm_log_analytics_workspace" "hayasend" {
  name                         = local.log_analytics_name
  location                     = azurerm_resource_group.hayasend.location
  resource_group_name          = azurerm_resource_group.hayasend.name
  sku                          = "PerGB2018"
  retention_in_days            = 30
  daily_quota_gb               = 1
  local_authentication_enabled = false
  tags                         = local.tags
}

resource "azurerm_virtual_network" "hayasend" {
  name                = local.network_name
  location            = azurerm_resource_group.hayasend.location
  resource_group_name = azurerm_resource_group.hayasend.name
  address_space       = [var.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "container_apps" {
  name                 = "${var.name_prefix}-container-apps"
  resource_group_name  = azurerm_resource_group.hayasend.name
  virtual_network_name = azurerm_virtual_network.hayasend.name
  address_prefixes     = [local.container_apps_cidr]

  delegation {
    name = "Microsoft.App.environments"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  name                 = "${var.name_prefix}-postgres"
  resource_group_name  = azurerm_resource_group.hayasend.name
  virtual_network_name = azurerm_virtual_network.hayasend.name
  address_prefixes     = [local.postgres_cidr]
  service_endpoints    = ["Microsoft.Storage"]

  delegation {
    name = "Microsoft.DBforPostgreSQL.flexibleServers"
    service_delegation {
      name = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = [
        "Microsoft.Network/virtualNetworks/subnets/join/action",
      ]
    }
  }
}

resource "azurerm_subnet" "private_endpoints" {
  name                              = "${var.name_prefix}-private-endpoints"
  resource_group_name               = azurerm_resource_group.hayasend.name
  virtual_network_name              = azurerm_virtual_network.hayasend.name
  address_prefixes                  = [local.private_endpoints_cidr]
  private_endpoint_network_policies = "Disabled"
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${var.name_prefix}.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.hayasend.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${var.name_prefix}-postgres"
  resource_group_name   = azurerm_resource_group.hayasend.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.hayasend.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_postgresql_flexible_server" "hayasend" {
  name                              = local.postgres_name
  resource_group_name               = azurerm_resource_group.hayasend.name
  location                          = azurerm_resource_group.hayasend.location
  version                           = "18"
  delegated_subnet_id               = azurerm_subnet.postgres.id
  private_dns_zone_id               = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled     = false
  administrator_login               = var.database_user
  administrator_password_wo         = var.database_password
  administrator_password_wo_version = var.database_password_version
  sku_name                          = var.database_sku_name
  storage_mb                        = var.database_storage_mb
  auto_grow_enabled                 = true
  backup_retention_days             = var.database_backup_retention_days
  geo_redundant_backup_enabled      = false
  tags                              = local.tags

  authentication {
    active_directory_auth_enabled = false
    password_auth_enabled         = true
  }

  dynamic "high_availability" {
    for_each = var.database_high_availability_enabled ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  maintenance_window {
    day_of_week  = 0
    start_hour   = 17
    start_minute = 0
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

resource "azurerm_postgresql_flexible_server_database" "hayasend" {
  name      = var.database_name
  server_id = azurerm_postgresql_flexible_server.hayasend.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_user_assigned_identity" "runtime" {
  name                = local.identity_name
  location            = azurerm_resource_group.hayasend.location
  resource_group_name = azurerm_resource_group.hayasend.name
  tags                = local.tags
}

resource "azurerm_key_vault" "hayasend" {
  name                          = local.key_vault_name
  location                      = azurerm_resource_group.hayasend.location
  resource_group_name           = azurerm_resource_group.hayasend.name
  tenant_id                     = var.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = var.key_vault_purge_protection_enabled
  soft_delete_retention_days    = 90
  public_network_access_enabled = true
  tags                          = local.tags

  network_acls {
    bypass                     = "AzureServices"
    default_action             = "Deny"
    ip_rules                   = var.key_vault_operator_ip_cidrs
    virtual_network_subnet_ids = []
  }
}

resource "azurerm_role_assignment" "deployer_key_vault_secrets" {
  name                             = uuidv5("url", "${azurerm_key_vault.hayasend.id}:deployer-secrets:${var.deployer_object_id}")
  scope                            = azurerm_key_vault.hayasend.id
  role_definition_name             = "Key Vault Secrets Officer"
  principal_id                     = var.deployer_object_id
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "runtime_key_vault_secrets" {
  name                             = uuidv5("url", "${azurerm_key_vault.hayasend.id}:runtime-secrets:${azurerm_user_assigned_identity.runtime.principal_id}")
  scope                            = azurerm_key_vault.hayasend.id
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = azurerm_user_assigned_identity.runtime.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_key_vault_secret" "database_url" {
  name             = "database-url"
  value_wo         = local.database_url
  value_wo_version = var.database_password_version
  key_vault_id     = azurerm_key_vault.hayasend.id
  content_type     = "HayaSend PostgreSQL URL"
  tags             = local.tags

  depends_on = [azurerm_role_assignment.deployer_key_vault_secrets]
}

resource "azurerm_key_vault_secret" "api_key" {
  name             = "api-key"
  value_wo         = var.api_key
  value_wo_version = var.api_key_version
  key_vault_id     = azurerm_key_vault.hayasend.id
  content_type     = "HayaSend bootstrap API key"
  tags             = local.tags

  depends_on = [azurerm_role_assignment.deployer_key_vault_secrets]
}

resource "azurerm_key_vault_secret" "event_grid_secret" {
  name             = "event-grid-secret"
  value_wo         = var.event_grid_secret
  value_wo_version = var.event_grid_secret_version
  key_vault_id     = azurerm_key_vault.hayasend.id
  content_type     = "HayaSend Event Grid delivery header"
  tags             = local.tags

  depends_on = [azurerm_role_assignment.deployer_key_vault_secrets]
}

resource "azurerm_private_dns_zone" "key_vault" {
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = azurerm_resource_group.hayasend.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "key_vault" {
  name                  = "${var.name_prefix}-key-vault"
  resource_group_name   = azurerm_resource_group.hayasend.name
  private_dns_zone_name = azurerm_private_dns_zone.key_vault.name
  virtual_network_id    = azurerm_virtual_network.hayasend.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "key_vault" {
  name                = "${var.name_prefix}-key-vault"
  location            = azurerm_resource_group.hayasend.location
  resource_group_name = azurerm_resource_group.hayasend.name
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "${var.name_prefix}-key-vault"
    private_connection_resource_id = azurerm_key_vault.hayasend.id
    is_manual_connection           = false
    subresource_names              = ["vault"]
  }

  private_dns_zone_group {
    name                 = "key-vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.key_vault.id]
  }
}

# The authenticated upload endpoint must remain Internet-reachable for browser
# user-delegation SAS uploads. Anonymous blob access, shared keys, local users,
# and cross-tenant replication are disabled; runtime traffic uses Private Link.
#trivy:ignore:AVD-AZU-0012
resource "azurerm_storage_account" "attachments" {
  name                             = local.storage_account_name
  resource_group_name              = azurerm_resource_group.hayasend.name
  location                         = azurerm_resource_group.hayasend.location
  account_tier                     = "Standard"
  account_replication_type         = "ZRS"
  account_kind                     = "StorageV2"
  access_tier                      = "Hot"
  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  allow_nested_items_to_be_public  = false
  shared_access_key_enabled        = false
  default_to_oauth_authentication  = true
  local_user_enabled               = false
  cross_tenant_replication_enabled = false
  public_network_access_enabled    = true
  tags                             = local.tags

  blob_properties {
    versioning_enabled       = true
    change_feed_enabled      = true
    last_access_time_enabled = true

    dynamic "delete_retention_policy" {
      for_each = var.storage_soft_delete_days == 0 ? [] : [var.storage_soft_delete_days]
      content {
        days = delete_retention_policy.value
      }
    }

    dynamic "container_delete_retention_policy" {
      for_each = var.storage_soft_delete_days == 0 ? [] : [var.storage_soft_delete_days]
      content {
        days = container_delete_retention_policy.value
      }
    }

    dynamic "cors_rule" {
      for_each = length(var.attachment_cors_origins) == 0 ? [] : [var.attachment_cors_origins]
      content {
        allowed_headers = [
          "content-type",
          "x-ms-blob-type",
          "x-ms-meta-hayasend-sha256",
          "x-ms-version",
        ]
        allowed_methods    = ["PUT"]
        allowed_origins    = cors_rule.value
        exposed_headers    = ["etag", "x-ms-request-id"]
        max_age_in_seconds = 3600
      }
    }
  }
}

resource "azurerm_storage_container" "attachments" {
  name                  = local.attachment_container
  storage_account_id    = azurerm_storage_account.attachments.id
  container_access_type = "private"
}

resource "azurerm_storage_management_policy" "attachments" {
  storage_account_id = azurerm_storage_account.attachments.id

  rule {
    name    = "expire-hayasend-attachments"
    enabled = true

    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["${azurerm_storage_container.attachments.name}/"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = var.attachment_retention_days
      }
      snapshot {
        delete_after_days_since_creation_greater_than = var.storage_soft_delete_days == 0 ? 1 : var.storage_soft_delete_days
      }
      version {
        delete_after_days_since_creation = var.storage_soft_delete_days == 0 ? 1 : var.storage_soft_delete_days
      }
    }
  }
}

resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.hayasend.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  name                  = "${var.name_prefix}-blob"
  resource_group_name   = azurerm_resource_group.hayasend.name
  private_dns_zone_name = azurerm_private_dns_zone.blob.name
  virtual_network_id    = azurerm_virtual_network.hayasend.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "blob" {
  name                = "${var.name_prefix}-blob"
  location            = azurerm_resource_group.hayasend.location
  resource_group_name = azurerm_resource_group.hayasend.name
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "${var.name_prefix}-blob"
    private_connection_resource_id = azurerm_storage_account.attachments.id
    is_manual_connection           = false
    subresource_names              = ["blob"]
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }
}

resource "azurerm_role_assignment" "runtime_blob_data" {
  name                             = uuidv5("url", "${azurerm_storage_container.attachments.id}:runtime-blob:${azurerm_user_assigned_identity.runtime.principal_id}")
  scope                            = azurerm_storage_container.attachments.id
  role_definition_name             = "Storage Blob Data Contributor"
  principal_id                     = azurerm_user_assigned_identity.runtime.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "runtime_blob_delegator" {
  name                             = uuidv5("url", "${azurerm_storage_account.attachments.id}:runtime-delegator:${azurerm_user_assigned_identity.runtime.principal_id}")
  scope                            = azurerm_storage_account.attachments.id
  role_definition_name             = "Storage Blob Delegator"
  principal_id                     = azurerm_user_assigned_identity.runtime.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "runtime_acr_pull" {
  count = local.uses_acr ? 1 : 0

  name                             = uuidv5("url", "${var.acr_resource_id}:runtime-pull:${azurerm_user_assigned_identity.runtime.principal_id}")
  scope                            = var.acr_resource_id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_user_assigned_identity.runtime.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_definition" "acs_runtime" {
  name        = "${var.name_prefix}-${local.deployment_id}-acs-runtime"
  scope       = local.subscription_resource_id
  description = "HayaSend managed identity: ACS Email submission and read-only domain inspection."

  permissions {
    actions = [
      "Microsoft.Communication/CommunicationServices/Read",
      "Microsoft.Communication/CommunicationServices/Write",
      "Microsoft.Communication/EmailServices/Read",
      "Microsoft.Communication/EmailServices/Domains/Read",
      "Microsoft.Communication/EmailServices/Domains/SenderUsernames/Read",
    ]
    not_actions = []
  }

  assignable_scopes = [local.subscription_resource_id]
}

resource "azurerm_role_assignment" "runtime_acs" {
  name                             = uuidv5("url", "${local.communication_service_id}:runtime-acs:${azurerm_user_assigned_identity.runtime.principal_id}")
  scope                            = local.communication_service_id
  role_definition_id               = azurerm_role_definition.acs_runtime.role_definition_resource_id
  principal_id                     = azurerm_user_assigned_identity.runtime.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "runtime_email_service" {
  name                             = uuidv5("url", "${local.email_service_id}:runtime-email:${azurerm_user_assigned_identity.runtime.principal_id}")
  scope                            = local.email_service_id
  role_definition_id               = azurerm_role_definition.acs_runtime.role_definition_resource_id
  principal_id                     = azurerm_user_assigned_identity.runtime.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_container_app_environment" "hayasend" {
  name                               = local.environment_name
  location                           = azurerm_resource_group.hayasend.location
  resource_group_name                = azurerm_resource_group.hayasend.name
  infrastructure_resource_group_name = local.infrastructure_rg
  infrastructure_subnet_id           = azurerm_subnet.container_apps.id
  internal_load_balancer_enabled     = false
  zone_redundancy_enabled            = true
  log_analytics_workspace_id         = azurerm_log_analytics_workspace.hayasend.id
  mutual_tls_enabled                 = false
  tags                               = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_container_app_job" "migration" {
  name                         = local.migration_name
  location                     = azurerm_resource_group.hayasend.location
  resource_group_name          = azurerm_resource_group.hayasend.name
  container_app_environment_id = azurerm_container_app_environment.hayasend.id
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 0
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.runtime.id]
  }

  dynamic "registry" {
    for_each = local.uses_acr ? [1] : []
    content {
      server   = local.image_registry
      identity = azurerm_user_assigned_identity.runtime.id
    }
  }

  secret {
    name                = "database-url"
    identity            = azurerm_user_assigned_identity.runtime.id
    key_vault_secret_id = azurerm_key_vault_secret.database_url.versionless_id
  }

  secret {
    name                = "api-key"
    identity            = azurerm_user_assigned_identity.runtime.id
    key_vault_secret_id = azurerm_key_vault_secret.api_key.versionless_id
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "migration"
      image   = var.image
      command = ["node"]
      args    = ["dist/portable/migrate.js"]
      cpu     = 0.5
      memory  = "1Gi"

      dynamic "env" {
        for_each = local.common_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.shared_secret_environment
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }
  }

  depends_on = [
    azurerm_postgresql_flexible_server_database.hayasend,
    azurerm_private_endpoint.blob,
    azurerm_private_endpoint.key_vault,
    azurerm_role_assignment.runtime_acr_pull,
    azurerm_role_assignment.runtime_blob_data,
    azurerm_role_assignment.runtime_blob_delegator,
    azurerm_role_assignment.runtime_email_service,
    azurerm_role_assignment.runtime_key_vault_secrets,
    azurerm_role_assignment.runtime_acs,
  ]
}

resource "azurerm_container_app_job" "hosted_proof" {
  count = var.enable_hosted_proof_job ? 1 : 0

  name                         = local.hosted_proof_name
  location                     = azurerm_resource_group.hayasend.location
  resource_group_name          = azurerm_resource_group.hayasend.name
  container_app_environment_id = azurerm_container_app_environment.hayasend.id
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 0
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.runtime.id]
  }

  dynamic "registry" {
    for_each = local.uses_acr ? [1] : []
    content {
      server   = local.image_registry
      identity = azurerm_user_assigned_identity.runtime.id
    }
  }

  secret {
    name                = "database-url"
    identity            = azurerm_user_assigned_identity.runtime.id
    key_vault_secret_id = azurerm_key_vault_secret.database_url.versionless_id
  }

  secret {
    name                = "api-key"
    identity            = azurerm_user_assigned_identity.runtime.id
    key_vault_secret_id = azurerm_key_vault_secret.api_key.versionless_id
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "hosted-proof"
      image   = var.image
      command = ["node"]
      args    = ["dist/portable/hosted-proof.js"]
      cpu     = 0.5
      memory  = "1Gi"

      dynamic "env" {
        for_each = local.hosted_proof_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.shared_secret_environment
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }
  }

  depends_on = [
    azurerm_container_app.api,
    azurerm_role_assignment.runtime_key_vault_secrets,
  ]
}

resource "azurerm_container_app" "api" {
  name                         = local.api_name
  resource_group_name          = azurerm_resource_group.hayasend.name
  container_app_environment_id = azurerm_container_app_environment.hayasend.id
  revision_mode                = "Single"
  max_inactive_revisions       = 3
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.runtime.id]
  }

  dynamic "registry" {
    for_each = local.uses_acr ? [1] : []
    content {
      server   = local.image_registry
      identity = azurerm_user_assigned_identity.runtime.id
    }
  }

  secret {
    name                = "database-url"
    identity            = azurerm_user_assigned_identity.runtime.id
    key_vault_secret_id = azurerm_key_vault_secret.database_url.versionless_id
  }

  secret {
    name                = "api-key"
    identity            = azurerm_user_assigned_identity.runtime.id
    key_vault_secret_id = azurerm_key_vault_secret.api_key.versionless_id
  }

  secret {
    name                = "event-grid-secret"
    identity            = azurerm_user_assigned_identity.runtime.id
    key_vault_secret_id = azurerm_key_vault_secret.event_grid_secret.versionless_id
  }

  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 8080
    transport                  = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = var.api_max_replicas

    http_scale_rule {
      name                = "http"
      concurrent_requests = "80"
    }

    container {
      name   = "api"
      image  = var.image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = merge(local.common_environment, {
          HAYASEND_PORT = "8080"
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = merge(local.shared_secret_environment, {
          HAYASEND_AZURE_EVENT_GRID_SECRET = "event-grid-secret"
        })
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/healthz"
        initial_delay           = 0
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 24
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/healthz"
        initial_delay           = 10
        interval_seconds        = 30
        timeout                 = 3
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/readyz"
        initial_delay           = 5
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 6
      }
    }
  }

  depends_on = [azurerm_container_app_job.migration]
}

resource "azurerm_container_app" "worker" {
  name                         = local.worker_name
  resource_group_name          = azurerm_resource_group.hayasend.name
  container_app_environment_id = azurerm_container_app_environment.hayasend.id
  revision_mode                = "Single"
  max_inactive_revisions       = 3
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.runtime.id]
  }

  dynamic "registry" {
    for_each = local.uses_acr ? [1] : []
    content {
      server   = local.image_registry
      identity = azurerm_user_assigned_identity.runtime.id
    }
  }

  secret {
    name                = "database-url"
    identity            = azurerm_user_assigned_identity.runtime.id
    key_vault_secret_id = azurerm_key_vault_secret.database_url.versionless_id
  }

  secret {
    name                = "api-key"
    identity            = azurerm_user_assigned_identity.runtime.id
    key_vault_secret_id = azurerm_key_vault_secret.api_key.versionless_id
  }

  template {
    min_replicas = var.worker_replicas
    max_replicas = var.worker_replicas

    container {
      name    = "worker"
      image   = var.image
      command = ["node"]
      args    = ["dist/portable/worker.js"]
      cpu     = 0.5
      memory  = "1Gi"

      dynamic "env" {
        for_each = merge(local.common_environment, {
          HAYASEND_WORKER_CONCURRENCY = tostring(var.worker_concurrency)
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.shared_secret_environment
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }
  }

  depends_on = [azurerm_container_app_job.migration]
}

resource "azurerm_management_lock" "runtime" {
  count = var.deletion_protection ? 1 : 0

  name       = "${var.name_prefix}-runtime-protection"
  scope      = azurerm_resource_group.hayasend.id
  lock_level = "CanNotDelete"
  notes      = "Remove only through the guarded HayaSend cleanup workflow."

  depends_on = [
    azurerm_container_app.api,
    azurerm_container_app.worker,
  ]
}
