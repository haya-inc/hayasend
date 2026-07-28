CREATE TABLE jobs (
  id text PRIMARY KEY,
  job_type text NOT NULL
    CHECK (
      job_type IN (
        'send_email',
        'reconcile_outbox',
        'publish_received_email',
        'deliver_webhook'
      )
    ),
  envelope jsonb NOT NULL,
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
    CHECK (attempts >= 0),
  max_attempts integer NOT NULL
    CHECK (max_attempts BETWEEN 1 AND 100),
  completed_at timestamptz,
  failed_at timestamptz,
  last_diagnostic_category text
    CHECK (
      last_diagnostic_category IS NULL OR
      last_diagnostic_category IN (
        'application_error',
        'invalid_data',
        'network_dns',
        'network_refused',
        'network_reset',
        'provider_error',
        'provider_rejected',
        'provider_throttled',
        'provider_unavailable',
        'timeout'
      )
    ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (completed_at IS NULL OR failed_at IS NULL)
);

CREATE INDEX jobs_due
  ON jobs(available_at, id)
  WHERE completed_at IS NULL AND failed_at IS NULL;

CREATE INDEX jobs_lease
  ON jobs(lease_expires_at, id)
  WHERE completed_at IS NULL AND failed_at IS NULL;

CREATE INDEX jobs_failed
  ON jobs(job_type, failed_at, id)
  WHERE failed_at IS NOT NULL;
