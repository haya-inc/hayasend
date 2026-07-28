CREATE TABLE app_entities (
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
  ON received_email_claims(expires_at);
