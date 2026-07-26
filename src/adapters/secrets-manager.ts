import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { ValidationError } from "../core/errors.js";

interface SecretsManagerReader {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
}

interface SecretProviderOptions {
  cacheTtlMs?: number;
  client?: SecretsManagerReader;
  now?: () => number;
}

function decodeSecret(output: GetSecretValueCommandOutput): string {
  const value =
    output.SecretString ??
    (output.SecretBinary
      ? Buffer.from(output.SecretBinary).toString("utf8")
      : undefined);
  if (!value || value.length < 32) {
    throw new ValidationError(
      "The bootstrap secret must contain at least 32 characters.",
    );
  }
  return value;
}

export function createSecretValueProvider(
  secretId: string,
  options: SecretProviderOptions = {},
): () => Promise<string> {
  const client = options.client ?? new SecretsManagerClient({});
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? 300_000;
  let cached: { value: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  return async () => {
    const timestamp = now();
    if (cached && timestamp < cached.expiresAt) {
      return cached.value;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = client
      .send(new GetSecretValueCommand({ SecretId: secretId }))
      .then((output) => {
        const value = decodeSecret(output);
        cached = { value, expiresAt: now() + cacheTtlMs };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
