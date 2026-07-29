locals {
  api_name                         = "${var.name_prefix}-api"
  worker_name                      = "${var.name_prefix}-worker"
  migration_name                   = "${var.name_prefix}-migrate"
  hosted_proof_name                = "${var.name_prefix}-proof"
  database_instance                = "${var.name_prefix}-postgres"
  api_account_id                   = "${var.name_prefix}-api"
  worker_account_id                = "${var.name_prefix}-worker"
  migration_account_id             = "${var.name_prefix}-migrate"
  attachment_bucket                = "${var.project_id}-${var.name_prefix}-attachments"
  database_secret_id               = "${var.name_prefix}-database-url"
  api_key_secret_id                = "${var.name_prefix}-api-key"
  sendgrid_api_secret_id           = "${var.name_prefix}-sendgrid-api-key"
  sendgrid_webhook_secret_id       = "${var.name_prefix}-sendgrid-webhook-public-key"
  network_name                     = "${var.name_prefix}-network"
  subnet_name                      = "${var.name_prefix}-${var.region}"
  private_services_name            = "${var.name_prefix}-private-services"
  pubsub_topic_name                = "${var.name_prefix}-wakeup"
  pubsub_subscription_name         = "${var.name_prefix}-wakeup"
  database_socket                  = "/cloudsql/${google_sql_database_instance.postgres.connection_name}"
  database_url                     = "postgresql://${var.database_user}:${urlencode(var.database_password)}@localhost/${var.database_name}?host=${urlencode(local.database_socket)}"
  api_key_file                     = "/var/run/hayasend/api-key/value"
  database_url_file                = "/var/run/hayasend/database-url/value"
  sendgrid_api_key_file            = "/var/run/hayasend/sendgrid-api-key/value"
  sendgrid_webhook_key_file        = "/var/run/hayasend/sendgrid-webhook-public-key/value"
  api_service_account_member       = "serviceAccount:${google_service_account.api.email}"
  worker_service_account_member    = "serviceAccount:${google_service_account.worker.email}"
  migration_service_account_member = "serviceAccount:${google_service_account.migration.email}"
  workload_service_account_members = {
    api       = local.api_service_account_member
    worker    = local.worker_service_account_member
    migration = local.migration_service_account_member
  }
  runtime_service_account_members = {
    api    = local.api_service_account_member
    worker = local.worker_service_account_member
  }

  labels = {
    application = "hayasend"
    managed_by  = "terraform"
    runtime     = "portable-postgres"
  }

  common_environment = merge({
    HAYASEND_MODE                  = "portable"
    HAYASEND_HOST                  = "0.0.0.0"
    HAYASEND_DATABASE_URL_FILE     = local.database_url_file
    HAYASEND_API_KEY_FILE          = local.api_key_file
    HAYASEND_TRANSPORT             = var.transport
    HAYASEND_OBJECT_STORAGE        = "gcs"
    HAYASEND_OBJECT_STORAGE_BUCKET = google_storage_bucket.attachments.name
    GOOGLE_CLOUD_PROJECT           = var.project_id
    AWS_REGION                     = var.aws_region
    }, var.transport == "console" ? {
    HAYASEND_CONSOLE_PROOF_CONFIRM = "isolated-non-sending"
    } : {}, var.transport == "sendgrid" ? {
    SENDGRID_API_KEY_FILE = local.sendgrid_api_key_file
    SENDGRID_API_BASE_URL = "https://api.sendgrid.com"
  } : {})

  migration_environment = {
    HAYASEND_MODE              = "portable"
    HAYASEND_DATABASE_URL_FILE = local.database_url_file
    HAYASEND_API_KEY           = "re_migration_process_not_serving_http"
    HAYASEND_TRANSPORT         = "aws-ses"
    HAYASEND_OBJECT_STORAGE    = "disabled"
    GOOGLE_CLOUD_PROJECT       = var.project_id
  }

  hosted_proof_environment = {
    HAYASEND_MODE                         = "portable"
    HAYASEND_DATABASE_URL_FILE            = local.database_url_file
    HAYASEND_API_KEY_FILE                 = local.api_key_file
    HAYASEND_TRANSPORT                    = "console"
    HAYASEND_CONSOLE_PROOF_CONFIRM        = "isolated-non-sending"
    HAYASEND_OBJECT_STORAGE               = "disabled"
    HAYASEND_HOSTED_PROOF_API_URL         = google_cloud_run_v2_service.api.uri
    HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS   = "30"
    HAYASEND_HOSTED_PROOF_TIMEOUT_SECONDS = "300"
    GOOGLE_CLOUD_PROJECT                  = var.project_id
  }

  api_environment = merge(
    local.common_environment,
    { HAYASEND_PORT = "8080" },
    var.enable_pubsub_wakeup ? {
      HAYASEND_QUEUE_WAKEUP     = "gcp-pubsub"
      HAYASEND_GCP_PUBSUB_TOPIC = google_pubsub_topic.wakeup[0].id
    } : {},
    var.transport == "sendgrid" ? {
      SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY_FILE = local.sendgrid_webhook_key_file
    } : {},
  )

  worker_environment = merge(
    local.common_environment,
    {
      HAYASEND_WORKER_CONCURRENCY = tostring(var.worker_concurrency)
      HAYASEND_WORKER_POLL_INTERVAL_MS = tostring(
        var.enable_pubsub_wakeup
        ? var.pubsub_pull_timeout_ms
        : var.worker_poll_interval_ms
      )
    },
    var.enable_pubsub_wakeup ? {
      HAYASEND_QUEUE_WAKEUP            = "gcp-pubsub"
      HAYASEND_GCP_PUBSUB_SUBSCRIPTION = google_pubsub_subscription.wakeup[0].id
    } : {},
  )
}
