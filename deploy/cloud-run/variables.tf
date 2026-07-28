variable "project_id" {
  description = "Google Cloud project that owns the complete HayaSend data plane."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid Google Cloud project ID."
  }
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL, Cloud Storage, and Secret Manager."
  type        = string
  default     = "asia-northeast1"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]$", var.region))
    error_message = "region must be a valid Google Cloud region name."
  }
}

variable "name_prefix" {
  description = "Short deterministic prefix for HayaSend resources."
  type        = string
  default     = "hayasend"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must contain 3-20 lowercase letters, numbers, or hyphens."
  }
}

variable "image" {
  description = "Immutable public GHCR or Artifact Registry HayaSend image digest."
  type        = string

  validation {
    condition = can(regex(
      "^(?:ghcr\\.io|[a-z0-9-]+-docker\\.pkg\\.dev)/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$",
      var.image,
    ))
    error_message = "image must be an allowed GHCR or Artifact Registry image pinned by sha256 digest."
  }
}

variable "api_key" {
  description = "Bootstrap HayaSend API key. Supply with TF_VAR_api_key; it is write-only and never stored in Terraform state."
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
  description = "Monotonic rotation number for the write-only API key."
  type        = number
  default     = 1

  validation {
    condition     = floor(var.api_key_version) == var.api_key_version && var.api_key_version >= 1
    error_message = "api_key_version must be a positive integer."
  }
}

variable "database_password" {
  description = "Built-in Cloud SQL user password. Supply with TF_VAR_database_password; it is write-only and never stored in Terraform state."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition = (
      length(var.database_password) >= 32 &&
      length(var.database_password) <= 256 &&
      !can(regex("[\\r\\n\\u0000]", var.database_password))
    )
    error_message = "database_password must be a single-line value between 32 and 256 characters."
  }
}

variable "database_password_version" {
  description = "Monotonic rotation number for the write-only database password and URL."
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
  description = "Built-in PostgreSQL application user."
  type        = string
  default     = "hayasend"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.database_user))
    error_message = "database_user must be a safe lowercase PostgreSQL identifier."
  }
}

variable "database_tier" {
  description = "Cloud SQL Enterprise machine tier."
  type        = string
  default     = "db-custom-1-3840"

  validation {
    condition     = can(regex("^db-[a-z0-9-]+$", var.database_tier))
    error_message = "database_tier must be a Cloud SQL db-* tier."
  }
}

variable "database_availability_type" {
  description = "REGIONAL is the production default; ZONAL lowers non-production cost."
  type        = string
  default     = "REGIONAL"

  validation {
    condition     = contains(["REGIONAL", "ZONAL"], var.database_availability_type)
    error_message = "database_availability_type must be REGIONAL or ZONAL."
  }
}

variable "database_disk_size_gb" {
  description = "Initial SSD size; automatic growth remains enabled."
  type        = number
  default     = 20

  validation {
    condition     = floor(var.database_disk_size_gb) == var.database_disk_size_gb && var.database_disk_size_gb >= 10 && var.database_disk_size_gb <= 65536
    error_message = "database_disk_size_gb must be an integer between 10 and 65536."
  }
}

variable "vpc_subnet_cidr" {
  description = "Dedicated Direct VPC subnet. /26 or larger is required for Cloud Run address allocation."
  type        = string
  default     = "10.42.0.0/24"

  validation {
    condition = (
      can(cidrnetmask(var.vpc_subnet_cidr)) &&
      can(tonumber(split("/", var.vpc_subnet_cidr)[1])) &&
      tonumber(split("/", var.vpc_subnet_cidr)[1]) >= 16 &&
      tonumber(split("/", var.vpc_subnet_cidr)[1]) <= 26
    )
    error_message = "vpc_subnet_cidr must be an IPv4 CIDR between /16 and /26."
  }
}

variable "deletion_protection" {
  description = "Protect Cloud Run, Cloud SQL, and Secret Manager resources from accidental Terraform deletion."
  type        = bool
  default     = true
}

variable "force_destroy_attachment_bucket" {
  description = "Allow Terraform to delete non-empty attachment storage. Keep false outside disposable test deployments."
  type        = bool
  default     = false
}

variable "attachment_retention_days" {
  description = "Delete attachment objects after this many days."
  type        = number
  default     = 30

  validation {
    condition     = floor(var.attachment_retention_days) == var.attachment_retention_days && var.attachment_retention_days >= 1 && var.attachment_retention_days <= 3650
    error_message = "attachment_retention_days must be an integer between 1 and 3650."
  }
}

variable "bucket_soft_delete_retention_seconds" {
  description = "Cloud Storage soft-delete retention. Use 0 only for disposable cleanup tests."
  type        = number
  default     = 604800

  validation {
    condition = (
      floor(var.bucket_soft_delete_retention_seconds) == var.bucket_soft_delete_retention_seconds &&
      (
        var.bucket_soft_delete_retention_seconds == 0 ||
        (
          var.bucket_soft_delete_retention_seconds >= 604800 &&
          var.bucket_soft_delete_retention_seconds <= 7776000
        )
      )
    )
    error_message = "bucket_soft_delete_retention_seconds must be 0 or between 604800 and 7776000."
  }
}

variable "attachment_cors_origins" {
  description = "Exact HTTPS browser origins allowed to upload attachments directly."
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
    error_message = "attachment_cors_origins must contain at most 20 exact HTTPS origins without paths."
  }
}

variable "transport" {
  description = "Portable transport. console is lifecycle-only; sendgrid uses the scoped HTTP API and Signed Event Webhook."
  type        = string
  default     = "console"

  validation {
    condition     = contains(["console", "aws-ses", "sendgrid"], var.transport)
    error_message = "transport must be console, aws-ses, or sendgrid."
  }
}

variable "sendgrid_api_key" {
  description = "Scoped SendGrid API key used only when transport is sendgrid. Supply with TF_VAR_sendgrid_api_key; it is write-only and never stored in Terraform state."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null
  nullable    = true

  validation {
    condition = var.transport != "sendgrid" || try(
      startswith(var.sendgrid_api_key, "SG.") &&
      length(var.sendgrid_api_key) >= 32 &&
      length(var.sendgrid_api_key) <= 512 &&
      !can(regex("[\\r\\n\\u0000]", var.sendgrid_api_key)),
      false,
    )
    error_message = "sendgrid_api_key must be a single-line SG. key between 32 and 512 characters when transport is sendgrid."
  }
}

variable "sendgrid_event_webhook_public_key" {
  description = "SendGrid Signed Event Webhook verification key used only when transport is sendgrid. Supply with TF_VAR_sendgrid_event_webhook_public_key; it is write-only and never stored in Terraform state."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null
  nullable    = true

  validation {
    condition = var.transport != "sendgrid" || try(
      length(var.sendgrid_event_webhook_public_key) >= 64 &&
      length(var.sendgrid_event_webhook_public_key) <= 16384 &&
      !can(regex("\\u0000", var.sendgrid_event_webhook_public_key)),
      false,
    )
    error_message = "sendgrid_event_webhook_public_key must contain the 64-16384 character SendGrid verification key when transport is sendgrid."
  }
}

variable "sendgrid_secret_version" {
  description = "Monotonic rotation number shared by the write-only SendGrid API and webhook verification keys."
  type        = number
  default     = 1

  validation {
    condition     = floor(var.sendgrid_secret_version) == var.sendgrid_secret_version && var.sendgrid_secret_version >= 1
    error_message = "sendgrid_secret_version must be a positive integer."
  }
}

variable "aws_region" {
  description = "AWS region used only when transport is aws-ses."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must be a valid AWS region."
  }
}

variable "api_min_instances" {
  description = "Minimum Cloud Run API instances."
  type        = number
  default     = 0

  validation {
    condition     = floor(var.api_min_instances) == var.api_min_instances && var.api_min_instances >= 0 && var.api_min_instances <= 100
    error_message = "api_min_instances must be an integer between 0 and 100."
  }
}

variable "api_max_instances" {
  description = "Maximum Cloud Run API instances."
  type        = number
  default     = 10

  validation {
    condition     = floor(var.api_max_instances) == var.api_max_instances && var.api_max_instances >= 1 && var.api_max_instances <= 1000
    error_message = "api_max_instances must be an integer between 1 and 1000."
  }
}

variable "api_concurrency" {
  description = "Maximum concurrent requests per API instance."
  type        = number
  default     = 20

  validation {
    condition     = floor(var.api_concurrency) == var.api_concurrency && var.api_concurrency >= 1 && var.api_concurrency <= 1000
    error_message = "api_concurrency must be an integer between 1 and 1000."
  }
}

variable "worker_instances" {
  description = "Manually scaled Cloud Run Worker Pool instances."
  type        = number
  default     = 1

  validation {
    condition     = floor(var.worker_instances) == var.worker_instances && var.worker_instances >= 1 && var.worker_instances <= 100
    error_message = "worker_instances must be an integer between 1 and 100."
  }
}

variable "worker_concurrency" {
  description = "Database job leases processed concurrently by each worker instance."
  type        = number
  default     = 4

  validation {
    condition     = floor(var.worker_concurrency) == var.worker_concurrency && var.worker_concurrency >= 1 && var.worker_concurrency <= 32
    error_message = "worker_concurrency must be an integer between 1 and 32."
  }
}

variable "worker_poll_interval_ms" {
  description = "Bounded PostgreSQL polling interval when the optional Pub/Sub accelerator is disabled."
  type        = number
  default     = 500

  validation {
    condition     = floor(var.worker_poll_interval_ms) == var.worker_poll_interval_ms && var.worker_poll_interval_ms >= 50 && var.worker_poll_interval_ms <= 60000
    error_message = "worker_poll_interval_ms must be an integer between 50 and 60000."
  }
}

variable "enable_pubsub_wakeup" {
  description = "Provision a content-free Pub/Sub hint path. PostgreSQL remains the only durable queue authority."
  type        = bool
  default     = false
}

variable "pubsub_pull_timeout_ms" {
  description = "Bounded unary pull request timeout and PostgreSQL fallback interval when Pub/Sub wake-up is enabled."
  type        = number
  default     = 5000

  validation {
    condition     = floor(var.pubsub_pull_timeout_ms) == var.pubsub_pull_timeout_ms && var.pubsub_pull_timeout_ms >= 1000 && var.pubsub_pull_timeout_ms <= 60000
    error_message = "pubsub_pull_timeout_ms must be an integer between 1000 and 60000."
  }
}

variable "allow_public_api" {
  description = "Grant allUsers Cloud Run invocation. HayaSend API-key authentication still applies."
  type        = bool
  default     = true
}

variable "disable_apis_on_destroy" {
  description = "Disable managed Google APIs on destroy. Keep false in shared projects."
  type        = bool
  default     = false
}
