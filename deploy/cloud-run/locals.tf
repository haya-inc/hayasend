locals {
  api_name               = "${var.name_prefix}-api"
  worker_name            = "${var.name_prefix}-worker"
  migration_name         = "${var.name_prefix}-migrate"
  database_instance      = "${var.name_prefix}-postgres"
  runtime_account_id     = "${var.name_prefix}-runtime"
  attachment_bucket      = "${var.project_id}-${var.name_prefix}-attachments"
  database_secret_id     = "${var.name_prefix}-database-url"
  api_key_secret_id      = "${var.name_prefix}-api-key"
  network_name           = "${var.name_prefix}-network"
  subnet_name            = "${var.name_prefix}-${var.region}"
  private_services_name  = "${var.name_prefix}-private-services"
  database_socket        = "/cloudsql/${google_sql_database_instance.postgres.connection_name}"
  database_url           = "postgresql://${var.database_user}:${urlencode(var.database_password)}@localhost/${var.database_name}?host=${urlencode(local.database_socket)}"
  api_key_file           = "/var/run/hayasend/api-key/value"
  database_url_file      = "/var/run/hayasend/database-url/value"
  service_account_member = "serviceAccount:${google_service_account.runtime.email}"

  labels = {
    application = "hayasend"
    managed_by  = "terraform"
    runtime     = "portable-postgres"
  }

  common_environment = {
    HAYASEND_MODE                  = "portable"
    HAYASEND_HOST                  = "0.0.0.0"
    HAYASEND_DATABASE_URL_FILE     = local.database_url_file
    HAYASEND_API_KEY_FILE          = local.api_key_file
    HAYASEND_TRANSPORT             = var.transport
    HAYASEND_OBJECT_STORAGE        = "gcs"
    HAYASEND_OBJECT_STORAGE_BUCKET = google_storage_bucket.attachments.name
    GOOGLE_CLOUD_PROJECT           = var.project_id
    AWS_REGION                     = var.aws_region
  }
}
