PRAGMA foreign_keys = ON;

CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE delivery_messages (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (id) REFERENCES emails(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE delivery_recipients (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  entity TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (message_id, role, ordinal),
  FOREIGN KEY (message_id) REFERENCES delivery_messages(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX delivery_recipients_message
  ON delivery_recipients(message_id, ordinal, id);

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  entity TEXT NOT NULL,
  UNIQUE (message_id, sequence),
  FOREIGN KEY (message_id) REFERENCES delivery_messages(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX delivery_attempts_message
  ON delivery_attempts(message_id, sequence, id);

CREATE TABLE provider_events (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  entity TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES delivery_messages(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX provider_events_message
  ON provider_events(message_id, received_at, id);

CREATE TABLE provider_event_metrics (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  latest_received_at TEXT
) STRICT;

INSERT INTO provider_event_metrics(singleton, latest_received_at)
VALUES (1, NULL);

CREATE TABLE idempotency_claims (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  email_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idempotency_claims_expiry
  ON idempotency_claims(expires_at);

CREATE TABLE outbox_items (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  due_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  dispatched_at TEXT,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  last_diagnostic_category TEXT,
  entity TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES delivery_messages(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX outbox_due
  ON outbox_items(dispatched_at, due_at, lease_expires_at, id);

CREATE INDEX outbox_lease
  ON outbox_items(dispatched_at, lease_expires_at, id);

CREATE TABLE outbox_metrics (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  publish_failures_total INTEGER NOT NULL DEFAULT 0
    CHECK (publish_failures_total >= 0)
) STRICT;

INSERT INTO outbox_metrics(singleton, publish_failures_total)
VALUES (1, 0);

CREATE TABLE delivery_ledger_versions (
  message_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  FOREIGN KEY (message_id) REFERENCES delivery_messages(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE delivery_ledger_mutations (
  operation_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES delivery_messages(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER delivery_ledger_mutation_guard
BEFORE INSERT ON delivery_ledger_mutations
FOR EACH ROW
WHEN COALESCE(
  (
    SELECT revision
    FROM delivery_ledger_versions
    WHERE message_id = NEW.message_id
  ),
  -1
) != NEW.expected_revision
BEGIN
  SELECT RAISE(ABORT, 'stale delivery ledger revision');
END;

CREATE TABLE outbox_mutations (
  operation_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL,
  expected_owner TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('acknowledge', 'failure')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (outbox_id) REFERENCES outbox_items(id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER outbox_mutation_guard
BEFORE INSERT ON outbox_mutations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM outbox_items
  WHERE id = NEW.outbox_id
    AND dispatched_at IS NULL
    AND lease_owner = NEW.expected_owner
)
BEGIN
  SELECT RAISE(ABORT, 'outbox lease is not owned');
END;
