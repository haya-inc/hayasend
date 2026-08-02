import { describe, expect, it, vi } from "vitest";
import { createConsoleAuthProvider } from "../src/console-auth-runtime.js";

const credentials = JSON.stringify({
  better_auth_secret:
    "q5ydm7GJ2Z4uX9cK1Vf8sN6pR3wT0aLhE7iB4oM2jU9xC5gF",
  google_client_secret: "google-oauth-client-secret",
});

describe("Better Auth console runtime", () => {
  it("creates one stateless Hono-compatible auth instance and exposes no anonymous session", async () => {
    const readCredentials = vi.fn(async () => credentials);
    const provider = createConsoleAuthProvider({
      origin: "https://mail.example.com",
      googleClientId: "client.apps.googleusercontent.com",
      allowedEmails: ["operator@example.com"],
      credentials: readCredentials,
    });

    const [first, second] = await Promise.all([provider(), provider()]);
    expect(first).toBe(second);
    expect(readCredentials).toHaveBeenCalledOnce();
    await expect(first.getSession(new Headers())).resolves.toBeNull();

    const sessionResponse = await first.handler(
      new Request("https://mail.example.com/api/auth/get-session"),
    );
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toBeNull();
  });

  it("fails closed when the secret payload is malformed", async () => {
    const provider = createConsoleAuthProvider({
      origin: "https://mail.example.com",
      googleClientId: "client.apps.googleusercontent.com",
      allowedEmails: ["operator@example.com"],
      credentials: async () => "not-json",
    });
    await expect(provider()).rejects.toThrow("must be a JSON object");
  });
});
