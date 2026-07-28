variable "subscription_id" {
  description = "Azure subscription that owns the complete HayaSend runtime and the referenced ACS resources."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be an Azure subscription UUID."
  }
}

variable "tenant_id" {
  description = "Microsoft Entra tenant for the subscription and managed identity."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.tenant_id))
    error_message = "tenant_id must be a Microsoft Entra tenant UUID."
  }
}

variable "deployer_object_id" {
  description = "Object ID of the Terraform principal; it receives only Key Vault Secrets Officer on this deployment vault."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.deployer_object_id))
    error_message = "deployer_object_id must be a Microsoft Entra object UUID."
  }
}

variable "resource_group_name" {
  description = "Dedicated resource group created for the HayaSend Azure runtime."
  type        = string
  default     = "hayasend-azure"

  validation {
    condition = (
      length(var.resource_group_name) >= 1 &&
      length(var.resource_group_name) <= 90 &&
      can(regex("^[A-Za-z0-9_().-]+$", var.resource_group_name)) &&
      !endswith(var.resource_group_name, ".")
    )
    error_message = "resource_group_name must be a valid Azure resource-group name."
  }
}

variable "location" {
  description = "Azure region shared by the runtime, PostgreSQL, Blob Storage, and Key Vault."
  type        = string
  default     = "japaneast"

  validation {
    condition     = can(regex("^[a-z0-9]+$", var.location))
    error_message = "location must be a normalized Azure location name such as japaneast."
  }
}

variable "name_prefix" {
  description = "Short deterministic prefix for Azure resources."
  type        = string
  default     = "hayasend"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,13}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must contain 3-15 lowercase letters, numbers, or hyphens."
  }
}

variable "image" {
  description = "Immutable public GHCR image or explicitly authorized ACR image."
  type        = string

  validation {
    condition = can(regex(
      "^(?:ghcr\\.io|[a-z0-9]+\\.azurecr\\.io)/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$",
      var.image,
    ))
    error_message = "image must be an allowed GHCR or ACR image pinned by sha256 digest."
  }
}

variable "acr_resource_id" {
  description = "Exact ACR resource ID when image uses azurecr.io; null for public GHCR."
  type        = string
  default     = null

  validation {
    condition = (
      var.acr_resource_id == null ||
      can(regex(
        "^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[A-Za-z0-9_().-]+/providers/Microsoft\\.ContainerRegistry/registries/[A-Za-z0-9]+$",
        var.acr_resource_id,
      ))
    )
    error_message = "acr_resource_id must be a complete Azure Container Registry resource ID."
  }
}

variable "api_key" {
  description = "Bootstrap HayaSend API key supplied through TF_VAR_api_key; never stored in Terraform state."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition = (
      startswith(var.api_key, "re_") &&
      length(var.api_key) >= 32 &&
      length(var.api_key) <= 512 &&
      !can(regex("[\\r\\n\\u0000]", var.api_key))
    )
    error_message = "api_key must be a single-line re_ key between 32 and 512 characters."
  }
}

variable "api_key_version" {
  description = "Monotonic write-only Key Vault rotation number for the API key."
  type        = number
  default     = 1

  validation {
    condition     = floor(var.api_key_version) == var.api_key_version && var.api_key_version >= 1
    error_message = "api_key_version must be a positive integer."
  }
}

variable "database_password" {
  description = "PostgreSQL administrator password supplied through TF_VAR_database_password; never stored in Terraform state."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition = (
      length(var.database_password) >= 32 &&
      length(var.database_password) <= 128 &&
      !can(regex("[\\r\\n\\u0000]", var.database_password))
    )
    error_message = "database_password must be a single-line value between 32 and 128 characters."
  }
}

variable "database_password_version" {
  description = "Monotonic write-only rotation number for PostgreSQL and its Key Vault URL."
  type        = number
  default     = 1

  validation {
    condition     = floor(var.database_password_version) == var.database_password_version && var.database_password_version >= 1
    error_message = "database_password_version must be a positive integer."
  }
}

variable "database_name" {
  description = "PostgreSQL database name."
  type        = string
  default     = "hayasend"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name must be a safe lowercase PostgreSQL identifier."
  }
}

variable "database_user" {
  description = "PostgreSQL administrator login used only by this HayaSend deployment."
  type        = string
  default     = "hayasend"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.database_user))
    error_message = "database_user must be a safe lowercase PostgreSQL identifier."
  }
}

variable "database_sku_name" {
  description = "PostgreSQL Flexible Server SKU; the production default supports zone-redundant HA."
  type        = string
  default     = "GP_Standard_D2ds_v5"

  validation {
    condition     = can(regex("^(?:B|GP|MO)_Standard_[A-Za-z0-9_]+$", var.database_sku_name))
    error_message = "database_sku_name must be an Azure PostgreSQL Flexible Server SKU."
  }
}

variable "database_storage_mb" {
  description = "PostgreSQL storage in MiB."
  type        = number
  default     = 32768

  validation {
    condition     = floor(var.database_storage_mb) == var.database_storage_mb && var.database_storage_mb >= 32768
    error_message = "database_storage_mb must be an integer of at least 32768."
  }
}

variable "database_backup_retention_days" {
  description = "Point-in-time backup retention for PostgreSQL."
  type        = number
  default     = 14

  validation {
    condition     = floor(var.database_backup_retention_days) == var.database_backup_retention_days && var.database_backup_retention_days >= 7 && var.database_backup_retention_days <= 35
    error_message = "database_backup_retention_days must be an integer from 7 through 35."
  }
}

variable "database_high_availability_enabled" {
  description = "Use zone-redundant PostgreSQL HA. Disable only for an explicitly non-production cost test."
  type        = bool
  default     = true
}

variable "vnet_cidr" {
  description = "Dedicated VNet CIDR. The module derives non-overlapping Container Apps, PostgreSQL, and private-endpoint subnets."
  type        = string
  default     = "10.43.0.0/16"

  validation {
    condition = (
      can(cidrnetmask(var.vnet_cidr)) &&
      can(tonumber(split("/", var.vnet_cidr)[1])) &&
      tonumber(split("/", var.vnet_cidr)[1]) >= 12 &&
      tonumber(split("/", var.vnet_cidr)[1]) <= 20
    )
    error_message = "vnet_cidr must be an IPv4 CIDR between /12 and /20."
  }
}

variable "key_vault_operator_ip_cidrs" {
  description = "Exact public IPv4 CIDRs allowed to administer Key Vault; leave empty only from a VNet-connected Terraform runner."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.key_vault_operator_ip_cidrs :
      can(cidrnetmask(cidr)) && !strcontains(cidr, ":")
    ])
    error_message = "key_vault_operator_ip_cidrs must contain valid IPv4 CIDRs."
  }
}

variable "terraform_runner_has_private_vnet_access" {
  description = "Explicit acknowledgement that Terraform reaches the Key Vault private endpoint when no operator IP is allowed."
  type        = bool
  default     = false
}

variable "key_vault_purge_protection_enabled" {
  description = "Protect secret history from purge. Keep true for production; a disposable proof may set false only before its initial create because Azure cannot disable it later."
  type        = bool
  default     = true
}

variable "storage_soft_delete_days" {
  description = "Blob and container soft-delete retention. Set 0 only immediately before an authorized disposable cleanup."
  type        = number
  default     = 7

  validation {
    condition = (
      floor(var.storage_soft_delete_days) == var.storage_soft_delete_days &&
      (var.storage_soft_delete_days == 0 || (var.storage_soft_delete_days >= 1 && var.storage_soft_delete_days <= 365))
    )
    error_message = "storage_soft_delete_days must be 0 or an integer from 1 through 365."
  }
}

variable "attachment_retention_days" {
  description = "Delete live attachment blobs after this many days."
  type        = number
  default     = 30

  validation {
    condition     = floor(var.attachment_retention_days) == var.attachment_retention_days && var.attachment_retention_days >= 1 && var.attachment_retention_days <= 3650
    error_message = "attachment_retention_days must be an integer from 1 through 3650."
  }
}

variable "attachment_cors_origins" {
  description = "Exact HTTPS application origins allowed to upload directly with short-lived user-delegation SAS URLs."
  type        = list(string)
  default     = []

  validation {
    condition = (
      length(var.attachment_cors_origins) <= 20 &&
      alltrue([
        for origin in var.attachment_cors_origins :
        can(regex("^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$", origin))
      ])
    )
    error_message = "attachment_cors_origins accepts at most 20 absolute HTTPS origins without paths."
  }
}

variable "transport" {
  description = "Azure pack transport. Console is rejected because deployed containers run in production mode."
  type        = string
  default     = "azure-communication-services"

  validation {
    condition     = var.transport == "azure-communication-services"
    error_message = "The Azure production-mode pack currently requires azure-communication-services."
  }
}

variable "acs_resource_group_name" {
  description = "Existing resource group containing the linked ACS and Email Communication Services resources."
  type        = string

  validation {
    condition = (
      length(var.acs_resource_group_name) >= 1 &&
      length(var.acs_resource_group_name) <= 90 &&
      can(regex("^[A-Za-z0-9_().-]+$", var.acs_resource_group_name)) &&
      !endswith(var.acs_resource_group_name, ".")
    )
    error_message = "acs_resource_group_name must be a valid Azure resource-group name."
  }
}

variable "acs_communication_service_name" {
  description = "Existing Azure Communication Services resource linked to the verified email domain."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]{1,63}$", var.acs_communication_service_name))
    error_message = "acs_communication_service_name must be a valid ACS resource name."
  }
}

variable "acs_email_service_name" {
  description = "Existing Email Communication Services resource that owns the verified domain."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]{1,63}$", var.acs_email_service_name))
    error_message = "acs_email_service_name must be a valid Email Communication Services name."
  }
}

variable "acs_email_domain_resource_name" {
  description = "Existing linked email-domain resource name, such as AzureManagedDomain or the custom domain resource."
  type        = string

  validation {
    condition = (
      length(var.acs_email_domain_resource_name) >= 1 &&
      length(var.acs_email_domain_resource_name) <= 253 &&
      can(regex("^[A-Za-z0-9.-]+$", var.acs_email_domain_resource_name))
    )
    error_message = "acs_email_domain_resource_name must be a safe ACS email-domain resource name."
  }
}

variable "acs_email_endpoint" {
  description = "HTTPS data-plane endpoint of the existing Azure Communication Services resource."
  type        = string

  validation {
    condition = (
      can(regex("^https://[A-Za-z0-9.-]+\\.communication\\.azure\\.com/?$", var.acs_email_endpoint)) &&
      !strcontains(var.acs_email_endpoint, "@")
    )
    error_message = "acs_email_endpoint must be a credential-free https://*.communication.azure.com origin."
  }
}

variable "event_grid_secret" {
  description = "Independent Event Grid header secret supplied through TF_VAR_event_grid_secret; never stored in Terraform state."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition = (
      length(var.event_grid_secret) >= 32 &&
      length(var.event_grid_secret) <= 512 &&
      !can(regex("[\\r\\n\\u0000]", var.event_grid_secret))
    )
    error_message = "event_grid_secret must be a single-line value between 32 and 512 characters."
  }
}

variable "event_grid_secret_version" {
  description = "Monotonic write-only Key Vault rotation number for the Event Grid secret."
  type        = number
  default     = 1

  validation {
    condition     = floor(var.event_grid_secret_version) == var.event_grid_secret_version && var.event_grid_secret_version >= 1
    error_message = "event_grid_secret_version must be a positive integer."
  }
}

variable "api_min_replicas" {
  description = "Minimum API replicas. One is the production default for Event Grid availability."
  type        = number
  default     = 1

  validation {
    condition     = floor(var.api_min_replicas) == var.api_min_replicas && var.api_min_replicas >= 0 && var.api_min_replicas <= 10
    error_message = "api_min_replicas must be an integer from 0 through 10."
  }
}

variable "api_max_replicas" {
  description = "Maximum API replicas."
  type        = number
  default     = 10

  validation {
    condition     = floor(var.api_max_replicas) == var.api_max_replicas && var.api_max_replicas >= 1 && var.api_max_replicas <= 100
    error_message = "api_max_replicas must be an integer from 1 through 100."
  }
}

variable "worker_replicas" {
  description = "Always-on durable recovery workers."
  type        = number
  default     = 1

  validation {
    condition     = floor(var.worker_replicas) == var.worker_replicas && var.worker_replicas >= 1 && var.worker_replicas <= 10
    error_message = "worker_replicas must be an integer from 1 through 10."
  }
}

variable "worker_concurrency" {
  description = "Concurrent jobs per worker process."
  type        = number
  default     = 4

  validation {
    condition     = floor(var.worker_concurrency) == var.worker_concurrency && var.worker_concurrency >= 1 && var.worker_concurrency <= 64
    error_message = "worker_concurrency must be an integer from 1 through 64."
  }
}

variable "deletion_protection" {
  description = "Create a CanNotDelete lock on the dedicated runtime resource group."
  type        = bool
  default     = true
}
