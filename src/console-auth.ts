import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import type { ApiScope, AuthenticatedPrincipal } from "./core/types.js";

const ADMIN_SCOPES: ApiScope[] = ["*"];
const CONSOLE_SESSION_SECONDS = 8 * 60 * 60;

export interface ConsoleAuthSession {
  principal: AuthenticatedPrincipal;
  email: string;
  image?: string | undefined;
}

export interface ConsoleAuth {
  provider: "google";
  handler(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<ConsoleAuthSession | null>;
}

export type ConsoleAuthProvider = () => Promise<ConsoleAuth>;

export interface ConsoleAuthOptions {
  baseUrl: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  allowedEmails: string[];
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizedAllowedEmails(values: string[]) {
  const emails = new Set(values.map(normalizeEmail).filter(Boolean));
  if (emails.size === 0) {
    throw new Error(
      "Console authentication requires at least one allowed email address.",
    );
  }
  return emails;
}

export function createConsoleAuth(options: ConsoleAuthOptions): ConsoleAuth {
  const allowedEmails = normalizedAllowedEmails(options.allowedEmails);
  const auth = betterAuth({
    appName: "HayaSend",
    basePath: "/api/auth",
    baseURL: options.baseUrl,
    secret: options.secret,
    trustedOrigins: [options.baseUrl],
    telemetry: { enabled: false },
    session: {
      expiresIn: CONSOLE_SESSION_SECONDS,
    },
    socialProviders: {
      google: {
        clientId: options.googleClientId,
        clientSecret: options.googleClientSecret,
        prompt: "select_account",
        mapProfileToUser(profile) {
          const email = normalizeEmail(profile.email ?? "");
          if (!profile.email_verified || !allowedEmails.has(email)) {
            throw new APIError("FORBIDDEN", {
              message:
                "This verified Google account is not allowed to operate this HayaSend deployment.",
            });
          }
          return { email };
        },
      },
    },
  });

  return {
    provider: "google",
    handler: (request) => auth.handler(request),
    async getSession(headers) {
      const session = await auth.api.getSession({ headers });
      if (!session?.user) {
        return null;
      }
      const email = normalizeEmail(session.user.email);
      if (!allowedEmails.has(email)) {
        return null;
      }
      return {
        principal: {
          id: `user:${session.user.id}`,
          name: session.user.name || email,
          scopes: ADMIN_SCOPES,
          bootstrap: false,
        },
        email,
        ...(session.user.image ? { image: session.user.image } : {}),
      };
    },
  };
}
