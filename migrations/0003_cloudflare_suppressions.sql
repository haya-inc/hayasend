CREATE TABLE suppressions (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX suppressions_created
  ON suppressions(created_at DESC, id DESC);
