CREATE TABLE emails (
  id text PRIMARY KEY,
  entity jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE delivery_messages (
  id text PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  entity jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE delivery_recipients (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES delivery_messages(id) ON DELETE CASCADE,
  role text NOT NULL,
  ordinal integer NOT NULL,
  entity jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (message_id, role, ordinal)
);

CREATE INDEX delivery_recipients_message
  ON delivery_recipients(message_id, ordinal, id);

CREATE TABLE delivery_attempts (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES delivery_messages(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  provider text NOT NULL,
  provider_message_id text,
  entity jsonb NOT NULL,
  UNIQUE (message_id, sequence)
);

CREATE INDEX delivery_attempts_message
  ON delivery_attempts(message_id, sequence, id);

CREATE INDEX delivery_attempts_provider_message
  ON delivery_attempts(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE provider_events (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES delivery_messages(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL,
  entity jsonb NOT NULL
);

CREATE INDEX provider_events_message
  ON provider_events(message_id, received_at, id);

CREATE TABLE provider_event_metrics (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  latest_received_at timestamptz
);

INSERT INTO provider_event_metrics(singleton, latest_received_at)
VALUES (true, NULL);

CREATE TABLE idempotency_claims (
  key_hash text PRIMARY KEY,
  request_hash text NOT NULL,
  email_id text NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL
);

CREATE INDEX idempotency_claims_expiry
  ON idempotency_claims(expires_at);

CREATE TABLE outbox_items (
  id text PRIMARY KEY,
  message_id text NOT NULL UNIQUE
    REFERENCES delivery_messages(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  dispatched_at timestamptz,
  attempts integer NOT NULL CHECK (attempts >= 0),
  last_diagnostic_category text,
  entity jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX outbox_due
  ON outbox_items(due_at, id)
  WHERE dispatched_at IS NULL;

CREATE INDEX outbox_lease
  ON outbox_items(lease_expires_at, id)
  WHERE dispatched_at IS NULL;

CREATE TABLE outbox_metrics (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  publish_failures_total bigint NOT NULL DEFAULT 0
    CHECK (publish_failures_total >= 0)
);

INSERT INTO outbox_metrics(singleton, publish_failures_total)
VALUES (true, 0);
