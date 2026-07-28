DROP INDEX delivery_attempts_provider_message;

CREATE UNIQUE INDEX delivery_attempts_provider_message
  ON delivery_attempts(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
