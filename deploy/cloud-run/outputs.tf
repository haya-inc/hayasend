output "api_url" {
  description = "Cloud Run API URL."
  value       = google_cloud_run_v2_service.api.uri
}

output "api_is_public" {
  description = "Whether Terraform grants allUsers permission to invoke the API."
  value       = var.allow_public_api
}

output "migration_job_name" {
  description = "Cloud Run Job that applies checksum-pinned forward migrations."
  value       = google_cloud_run_v2_job.migration.name
}

output "worker_pool_name" {
  description = "Cloud Run Worker Pool name."
  value       = google_cloud_run_v2_worker_pool.worker.name
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name mounted at /cloudsql."
  value       = google_sql_database_instance.postgres.connection_name
}

output "attachment_bucket" {
  description = "Private GCS attachment bucket."
  value       = google_storage_bucket.attachments.name
}

output "runtime_service_accounts" {
  description = "Least-privilege identities for the API, worker, and migration workloads."
  value = {
    api       = google_service_account.api.email
    worker    = google_service_account.worker.email
    migration = google_service_account.migration.email
  }
}

output "pubsub_wakeup" {
  description = "Optional content-free Pub/Sub wake-up resources; null when disabled."
  value = var.enable_pubsub_wakeup ? {
    topic        = google_pubsub_topic.wakeup[0].id
    subscription = google_pubsub_subscription.wakeup[0].id
  } : null
}

output "vpc_network" {
  description = "Dedicated Direct VPC network."
  value       = google_compute_network.hayasend.name
}
