import { createHash } from "node:crypto";
import type { Pool } from "pg";

const deliveryMigrationSql = `CREATE TABLE emails (
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
VALUES (true, 0);`;

const applicationStoreMigrationSql = `CREATE TABLE app_entities (
  kind text NOT NULL,
  id text NOT NULL,
  scope text,
  entity jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz,
  revision integer,
  PRIMARY KEY (kind, id)
);

CREATE INDEX app_entities_created
  ON app_entities(kind, created_at DESC, id DESC);

CREATE INDEX app_entities_scoped_created
  ON app_entities(kind, scope, created_at DESC, id DESC);

CREATE INDEX app_entities_expiry
  ON app_entities(kind, expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE template_aliases (
  alias_type text NOT NULL
    CHECK (alias_type IN ('draft', 'published')),
  alias text NOT NULL,
  template_id text NOT NULL,
  PRIMARY KEY (alias_type, alias)
);

CREATE INDEX template_aliases_template
  ON template_aliases(template_id);

CREATE TABLE received_email_claims (
  id text PRIMARY KEY,
  lease_until bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE INDEX received_email_claims_expiry
  ON received_email_claims(expires_at);`;

export const POSTGRES_MIGRATIONS = [
  { version: "0001_delivery", sql: deliveryMigrationSql },
  { version: "0002_application_store", sql: applicationStoreMigrationSql },
] as const;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function migratePostgres(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      ["hayasend:postgres-schema"],
    );
    locked = true;
    await client.query(
      `CREATE TABLE IF NOT EXISTS hayasend_schema_migrations (
         version text PRIMARY KEY,
         checksum_sha256 text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    );

    for (const migration of POSTGRES_MIGRATIONS) {
      const expectedChecksum = checksum(migration.sql);
      const existing = await client.query<{ checksum_sha256: string }>(
        "SELECT checksum_sha256 FROM hayasend_schema_migrations WHERE version = $1",
        [migration.version],
      );
      const appliedChecksum = existing.rows[0]?.checksum_sha256;
      if (appliedChecksum) {
        if (appliedChecksum !== expectedChecksum) {
          throw new Error(
            `PostgreSQL migration ${migration.version} checksum does not match the applied migration.`,
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO hayasend_schema_migrations(version, checksum_sha256) VALUES ($1, $2)",
          [migration.version, expectedChecksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (locked) {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        ["hayasend:postgres-schema"],
      );
    }
    client.release();
  }
}
