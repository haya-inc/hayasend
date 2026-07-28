resource "google_project_service" "required" {
  for_each = toset(concat([
    "compute.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ], var.enable_pubsub_wakeup ? ["pubsub.googleapis.com"] : []))

  project            = var.project_id
  service            = each.value
  disable_on_destroy = var.disable_apis_on_destroy
}

resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = local.api_account_id
  display_name = "HayaSend portable API"
  description  = "Least-privilege identity for the HayaSend API service."

  depends_on = [google_project_service.required]
}

resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = local.worker_account_id
  display_name = "HayaSend portable worker"
  description  = "Least-privilege identity for the HayaSend worker pool."

  depends_on = [google_project_service.required]
}

resource "google_service_account" "migration" {
  project      = var.project_id
  account_id   = local.migration_account_id
  display_name = "HayaSend portable migration"
  description  = "Least-privilege identity for the HayaSend migration job."

  depends_on = [google_project_service.required]
}

resource "google_compute_network" "hayasend" {
  project                 = var.project_id
  name                    = local.network_name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  mtu                     = 1460

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "cloud_run" {
  project                  = var.project_id
  name                     = local.subnet_name
  region                   = var.region
  network                  = google_compute_network.hayasend.id
  ip_cidr_range            = var.vpc_subnet_cidr
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services" {
  project       = var.project_id
  name          = local.private_services_name
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.hayasend.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.hayasend.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

resource "google_sql_database_instance" "postgres" {
  project             = var.project_id
  name                = local.database_instance
  region              = var.region
  database_version    = "POSTGRES_18"
  deletion_protection = var.deletion_protection

  settings {
    tier                  = var.database_tier
    edition               = "ENTERPRISE"
    availability_type     = var.database_availability_type
    connector_enforcement = "REQUIRED"
    disk_type             = "PD_SSD"
    disk_size             = var.database_disk_size_gb
    disk_autoresize       = true

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "18:00"
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.hayasend.id
      enable_private_path_for_google_cloud_services = true
      ssl_mode                                      = "ENCRYPTED_ONLY"
    }

    maintenance_window {
      day          = 7
      hour         = 17
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      query_plans_per_minute  = 5
      query_string_length     = 1024
      record_application_tags = true
    }

    user_labels = local.labels
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "hayasend" {
  project  = var.project_id
  name     = var.database_name
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "hayasend" {
  project             = var.project_id
  name                = var.database_user
  instance            = google_sql_database_instance.postgres.name
  password_wo         = var.database_password
  password_wo_version = var.database_password_version
  deletion_policy     = "DELETE"
}

resource "google_secret_manager_secret" "database_url" {
  project             = var.project_id
  secret_id           = local.database_secret_id
  deletion_protection = var.deletion_protection
  labels              = local.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret                 = google_secret_manager_secret.database_url.id
  secret_data_wo         = local.database_url
  secret_data_wo_version = var.database_password_version
  deletion_policy        = "DELETE"
}

resource "google_secret_manager_secret" "api_key" {
  project             = var.project_id
  secret_id           = local.api_key_secret_id
  deletion_protection = var.deletion_protection
  labels              = local.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "api_key" {
  secret                 = google_secret_manager_secret.api_key.id
  secret_data_wo         = var.api_key
  secret_data_wo_version = var.api_key_version
  deletion_policy        = "DELETE"
}

resource "google_secret_manager_secret" "sendgrid_api_key" {
  count = var.transport == "sendgrid" ? 1 : 0

  project             = var.project_id
  secret_id           = local.sendgrid_api_secret_id
  deletion_protection = var.deletion_protection
  labels              = local.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "sendgrid_api_key" {
  count = var.transport == "sendgrid" ? 1 : 0

  secret                 = google_secret_manager_secret.sendgrid_api_key[0].id
  secret_data_wo         = var.sendgrid_api_key
  secret_data_wo_version = var.sendgrid_secret_version
  deletion_policy        = "DELETE"
}

resource "google_secret_manager_secret" "sendgrid_webhook_public_key" {
  count = var.transport == "sendgrid" ? 1 : 0

  project             = var.project_id
  secret_id           = local.sendgrid_webhook_secret_id
  deletion_protection = var.deletion_protection
  labels              = local.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "sendgrid_webhook_public_key" {
  count = var.transport == "sendgrid" ? 1 : 0

  secret                 = google_secret_manager_secret.sendgrid_webhook_public_key[0].id
  secret_data_wo         = var.sendgrid_event_webhook_public_key
  secret_data_wo_version = var.sendgrid_secret_version
  deletion_policy        = "DELETE"
}

resource "google_secret_manager_secret_iam_member" "database_url" {
  for_each = local.workload_service_account_members

  project   = var.project_id
  secret_id = google_secret_manager_secret.database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

resource "google_secret_manager_secret_iam_member" "api_key" {
  for_each = local.runtime_service_account_members

  project   = var.project_id
  secret_id = google_secret_manager_secret.api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

resource "google_secret_manager_secret_iam_member" "sendgrid_api_key" {
  for_each = var.transport == "sendgrid" ? local.runtime_service_account_members : {}

  project   = var.project_id
  secret_id = google_secret_manager_secret.sendgrid_api_key[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}

resource "google_secret_manager_secret_iam_member" "sendgrid_webhook_public_key" {
  count = var.transport == "sendgrid" ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.sendgrid_webhook_public_key[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.api_service_account_member
}

resource "google_project_iam_member" "cloud_sql_client" {
  for_each = local.workload_service_account_members

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = each.value
}

resource "google_service_account_iam_member" "api_self_signing" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.api_service_account_member
}

resource "google_storage_bucket" "attachments" {
  project                     = var.project_id
  name                        = local.attachment_bucket
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.force_destroy_attachment_bucket
  labels                      = local.labels

  versioning {
    enabled = false
  }

  soft_delete_policy {
    retention_duration_seconds = var.bucket_soft_delete_retention_seconds
  }

  lifecycle_rule {
    condition {
      age = var.attachment_retention_days
    }
    action {
      type = "Delete"
    }
  }

  dynamic "cors" {
    for_each = length(var.attachment_cors_origins) == 0 ? [] : [var.attachment_cors_origins]
    content {
      origin = cors.value
      method = ["PUT"]
      response_header = [
        "Content-Type",
        "x-goog-meta-hayasend-sha256",
      ]
      max_age_seconds = 3600
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "runtime_objects" {
  for_each = local.runtime_service_account_members

  bucket = google_storage_bucket.attachments.name
  role   = "roles/storage.objectUser"
  member = each.value
}

resource "google_pubsub_topic" "wakeup" {
  count = var.enable_pubsub_wakeup ? 1 : 0

  project = var.project_id
  name    = local.pubsub_topic_name
  labels  = local.labels

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }

  depends_on = [google_project_service.required]
}

resource "google_pubsub_subscription" "wakeup" {
  count = var.enable_pubsub_wakeup ? 1 : 0

  project                    = var.project_id
  name                       = local.pubsub_subscription_name
  topic                      = google_pubsub_topic.wakeup[0].id
  ack_deadline_seconds       = 10
  message_retention_duration = "600s"
  retain_acked_messages      = false
  labels                     = local.labels
}

resource "google_pubsub_topic_iam_member" "api_publisher" {
  count = var.enable_pubsub_wakeup ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.wakeup[0].name
  role    = "roles/pubsub.publisher"
  member  = local.api_service_account_member
}

resource "google_pubsub_subscription_iam_member" "worker_subscriber" {
  count = var.enable_pubsub_wakeup ? 1 : 0

  project      = var.project_id
  subscription = google_pubsub_subscription.wakeup[0].name
  role         = "roles/pubsub.subscriber"
  member       = local.worker_service_account_member
}

resource "google_cloud_run_v2_job" "migration" {
  project             = var.project_id
  name                = local.migration_name
  location            = var.region
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account       = google_service_account.migration.email
      timeout               = "600s"
      max_retries           = 0
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.hayasend.id
          subnetwork = google_compute_subnetwork.cloud_run.id
        }
      }

      containers {
        name    = "migration"
        image   = var.image
        command = ["node"]
        args    = ["dist/portable/migrate.js"]

        dynamic "env" {
          for_each = local.migration_environment
          content {
            name  = env.key
            value = env.value
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
        volume_mounts {
          name       = "database-url"
          mount_path = "/var/run/hayasend/database-url"
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.postgres.connection_name]
        }
      }
      volumes {
        name = "database-url"
        secret {
          secret       = google_secret_manager_secret.database_url.secret_id
          default_mode = 292
          items {
            version = google_secret_manager_secret_version.database_url.version
            path    = "value"
            mode    = 292
          }
        }
      }
    }
  }

  depends_on = [
    google_project_iam_member.cloud_sql_client,
    google_secret_manager_secret_iam_member.database_url,
    google_sql_database.hayasend,
    google_sql_user.hayasend,
  ]
}

resource "google_cloud_run_v2_service" "api" {
  project             = var.project_id
  name                = local.api_name
  location            = var.region
  deletion_protection = var.deletion_protection
  ingress             = "INGRESS_TRAFFIC_ALL"
  labels              = local.labels

  scaling {
    min_instance_count = var.api_min_instances
    max_instance_count = var.api_max_instances
  }

  template {
    service_account                  = google_service_account.api.email
    timeout                          = "300s"
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.api_concurrency

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.hayasend.id
        subnetwork = google_compute_subnetwork.cloud_run.id
      }
    }

    containers {
      name  = "api"
      image = var.image

      dynamic "env" {
        for_each = local.api_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      ports {
        name           = "http1"
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 24
        http_get {
          path = "/healthz"
          port = 8080
        }
      }

      liveness_probe {
        initial_delay_seconds = 10
        timeout_seconds       = 3
        period_seconds        = 30
        failure_threshold     = 3
        http_get {
          path = "/healthz"
          port = 8080
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      volume_mounts {
        name       = "database-url"
        mount_path = "/var/run/hayasend/database-url"
      }
      volume_mounts {
        name       = "api-key"
        mount_path = "/var/run/hayasend/api-key"
      }
      dynamic "volume_mounts" {
        for_each = var.transport == "sendgrid" ? [1] : []
        content {
          name       = "sendgrid-api-key"
          mount_path = "/var/run/hayasend/sendgrid-api-key"
        }
      }
      dynamic "volume_mounts" {
        for_each = var.transport == "sendgrid" ? [1] : []
        content {
          name       = "sendgrid-webhook-public-key"
          mount_path = "/var/run/hayasend/sendgrid-webhook-public-key"
        }
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.postgres.connection_name]
      }
    }
    volumes {
      name = "database-url"
      secret {
        secret       = google_secret_manager_secret.database_url.secret_id
        default_mode = 292
        items {
          version = google_secret_manager_secret_version.database_url.version
          path    = "value"
          mode    = 292
        }
      }
    }
    volumes {
      name = "api-key"
      secret {
        secret       = google_secret_manager_secret.api_key.secret_id
        default_mode = 292
        items {
          version = google_secret_manager_secret_version.api_key.version
          path    = "value"
          mode    = 292
        }
      }
    }
    dynamic "volumes" {
      for_each = var.transport == "sendgrid" ? [1] : []
      content {
        name = "sendgrid-api-key"
        secret {
          secret       = google_secret_manager_secret.sendgrid_api_key[0].secret_id
          default_mode = 292
          items {
            version = google_secret_manager_secret_version.sendgrid_api_key[0].version
            path    = "value"
            mode    = 292
          }
        }
      }
    }
    dynamic "volumes" {
      for_each = var.transport == "sendgrid" ? [1] : []
      content {
        name = "sendgrid-webhook-public-key"
        secret {
          secret       = google_secret_manager_secret.sendgrid_webhook_public_key[0].secret_id
          default_mode = 292
          items {
            version = google_secret_manager_secret_version.sendgrid_webhook_public_key[0].version
            path    = "value"
            mode    = 292
          }
        }
      }
    }
  }

  depends_on = [
    google_cloud_run_v2_job.migration,
    google_project_iam_member.cloud_sql_client,
    google_pubsub_topic_iam_member.api_publisher,
    google_service_account_iam_member.api_self_signing,
    google_secret_manager_secret_iam_member.api_key,
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.sendgrid_api_key,
    google_secret_manager_secret_iam_member.sendgrid_webhook_public_key,
    google_storage_bucket_iam_member.runtime_objects,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public_api" {
  count = var.allow_public_api ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_worker_pool" "worker" {
  project             = var.project_id
  name                = local.worker_name
  location            = var.region
  deletion_protection = var.deletion_protection
  launch_stage        = "BETA"
  labels              = local.labels

  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = var.worker_instances
  }

  template {
    service_account = google_service_account.worker.email

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.hayasend.id
        subnetwork = google_compute_subnetwork.cloud_run.id
      }
    }

    containers {
      name    = "worker"
      image   = var.image
      command = ["node"]
      args    = ["dist/portable/worker.js"]

      dynamic "env" {
        for_each = local.worker_environment
        content {
          name  = env.key
          value = env.value
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      volume_mounts {
        name       = "database-url"
        mount_path = "/var/run/hayasend/database-url"
      }
      volume_mounts {
        name       = "api-key"
        mount_path = "/var/run/hayasend/api-key"
      }
      dynamic "volume_mounts" {
        for_each = var.transport == "sendgrid" ? [1] : []
        content {
          name       = "sendgrid-api-key"
          mount_path = "/var/run/hayasend/sendgrid-api-key"
        }
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.postgres.connection_name]
      }
    }
    volumes {
      name = "database-url"
      secret {
        secret       = google_secret_manager_secret.database_url.secret_id
        default_mode = 292
        items {
          version = google_secret_manager_secret_version.database_url.version
          path    = "value"
          mode    = 292
        }
      }
    }
    volumes {
      name = "api-key"
      secret {
        secret       = google_secret_manager_secret.api_key.secret_id
        default_mode = 292
        items {
          version = google_secret_manager_secret_version.api_key.version
          path    = "value"
          mode    = 292
        }
      }
    }
    dynamic "volumes" {
      for_each = var.transport == "sendgrid" ? [1] : []
      content {
        name = "sendgrid-api-key"
        secret {
          secret       = google_secret_manager_secret.sendgrid_api_key[0].secret_id
          default_mode = 292
          items {
            version = google_secret_manager_secret_version.sendgrid_api_key[0].version
            path    = "value"
            mode    = 292
          }
        }
      }
    }
  }

  depends_on = [
    google_cloud_run_v2_job.migration,
    google_project_iam_member.cloud_sql_client,
    google_pubsub_subscription_iam_member.worker_subscriber,
    google_secret_manager_secret_iam_member.api_key,
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.sendgrid_api_key,
    google_storage_bucket_iam_member.runtime_objects,
  ]
}
