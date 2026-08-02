import {
  createConsoleAuth,
  type ConsoleAuthProvider,
} from "./console-auth.js";

interface ConsoleAuthCredentials {
  better_auth_secret: string;
  google_client_secret: string;
}

export interface ConsoleAuthProviderOptions {
  origin: string;
  googleClientId: string;
  allowedEmails: string[];
  credentials: () => Promise<string>;
}

function parseCredentials(value: string): ConsoleAuthCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "The console authentication secret must be a JSON object.",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "The console authentication secret must be a JSON object.",
    );
  }
  const record = parsed as Record<string, unknown>;
  const betterAuthSecret = record.better_auth_secret;
  const googleClientSecret = record.google_client_secret;
  if (
    typeof betterAuthSecret !== "string" ||
    betterAuthSecret.length < 32 ||
    betterAuthSecret.length > 512 ||
    typeof googleClientSecret !== "string" ||
    googleClientSecret.length < 8 ||
    googleClientSecret.length > 512
  ) {
    throw new Error(
      "The console authentication secret must contain better_auth_secret (32-512 characters) and google_client_secret (8-512 characters).",
    );
  }
  return {
    better_auth_secret: betterAuthSecret,
    google_client_secret: googleClientSecret,
  };
}

export function createConsoleAuthProvider(
  options: ConsoleAuthProviderOptions,
): ConsoleAuthProvider {
  let inFlight: ReturnType<ConsoleAuthProvider> | undefined;
  return () => {
    inFlight ??= options.credentials().then((value) => {
      const credentials = parseCredentials(value);
      return createConsoleAuth({
        baseUrl: options.origin,
        secret: credentials.better_auth_secret,
        googleClientId: options.googleClientId,
        googleClientSecret: credentials.google_client_secret,
        allowedEmails: options.allowedEmails,
      });
    });
    return inFlight;
  };
}
