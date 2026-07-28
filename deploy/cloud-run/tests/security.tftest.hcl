mock_provider "google" {}

run "secure_foundation_defaults" {
  command = plan

  variables {
    project_id        = "hayasend-test-project"
    image             = "ghcr.io/haya-inc/hayasend@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    api_key           = "re_test_test_test_test_test_test_test"
    database_password = "test-test-test-test-test-test-test-test"
  }

  assert {
    condition     = google_sql_database_instance.postgres.database_version == "POSTGRES_18"
    error_message = "Cloud SQL must use PostgreSQL 18."
  }

  assert {
    condition     = google_sql_database_instance.postgres.deletion_protection
    error_message = "Cloud SQL deletion protection must default to enabled."
  }

  assert {
    condition     = google_storage_bucket.attachments.public_access_prevention == "enforced"
    error_message = "The attachment bucket must enforce public-access prevention."
  }

  assert {
    condition     = google_storage_bucket.attachments.uniform_bucket_level_access
    error_message = "The attachment bucket must use uniform bucket-level access."
  }

  assert {
    condition     = google_cloud_run_v2_job.migration.template[0].template[0].max_retries == 0
    error_message = "Migration failure must not be hidden by automatic job retries."
  }

  assert {
    condition     = google_sql_database_instance.postgres.settings[0].connector_enforcement == "REQUIRED"
    error_message = "Cloud SQL must reject connections that bypass approved connectors."
  }

  assert {
    condition     = !google_sql_database_instance.postgres.settings[0].ip_configuration[0].ipv4_enabled
    error_message = "Cloud SQL must not receive a public IPv4 address."
  }

  assert {
    condition     = google_compute_subnetwork.cloud_run.private_ip_google_access
    error_message = "The Direct VPC subnet must retain private Google API access."
  }
}

run "workloads_use_pinned_identity_and_manual_worker" {
  command = plan

  override_resource {
    target          = google_service_account.runtime
    override_during = plan
    values = {
      email = "hayasend-runtime@hayasend-test-project.iam.gserviceaccount.com"
      name  = "projects/hayasend-test-project/serviceAccounts/hayasend-runtime@hayasend-test-project.iam.gserviceaccount.com"
    }
  }

  variables {
    project_id        = "hayasend-test-project"
    image             = "ghcr.io/haya-inc/hayasend@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    api_key           = "re_test_test_test_test_test_test_test"
    database_password = "test-test-test-test-test-test-test-test"
  }

  assert {
    condition     = google_cloud_run_v2_service.api.template[0].service_account == "hayasend-runtime@hayasend-test-project.iam.gserviceaccount.com"
    error_message = "The API must use the dedicated runtime identity."
  }

  assert {
    condition     = google_cloud_run_v2_worker_pool.worker.template[0].service_account == "hayasend-runtime@hayasend-test-project.iam.gserviceaccount.com"
    error_message = "The worker must use the dedicated runtime identity."
  }

  assert {
    condition     = google_cloud_run_v2_worker_pool.worker.scaling[0].manual_instance_count == 1
    error_message = "The worker pool must keep one recovery worker by default."
  }

  assert {
    condition     = google_cloud_run_v2_service.api.template[0].containers[0].image == var.image
    error_message = "The API must deploy the caller-supplied immutable digest."
  }

  assert {
    condition     = google_cloud_run_v2_worker_pool.worker.template[0].containers[0].image == var.image
    error_message = "The worker must deploy the same immutable digest."
  }
}
