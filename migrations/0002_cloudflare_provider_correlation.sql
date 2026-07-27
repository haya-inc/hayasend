ALTER TABLE delivery_attempts
  ADD COLUMN provider_message_id TEXT;

ALTER TABLE delivery_attempts
  ADD COLUMN provider TEXT;

CREATE UNIQUE INDEX delivery_attempts_provider_message
  ON delivery_attempts(provider, provider_message_id)
  WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL;
