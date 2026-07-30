import { describe, expect, it } from "vitest";
import {
  SUPABASE_AUTH_EMAIL_ACTIONS,
  buildSupabaseConfirmationUrl,
  createSupabaseHookIdempotencyKey,
  mapHayaSendHookFailure,
  normalizeSupabaseHookSecret,
  parseSupabaseAuthHookPayload,
  renderSupabaseAuthEmails,
  requireHttpsOrigin,
  type SupabaseAuthEmailAction,
} from "../examples/supabase-auth-send-email-hook/email.js";

function fixture(action: SupabaseAuthEmailAction) {
  return parseSupabaseAuthHookPayload({
    user: {
      email: "person@example.net",
      new_email: "new-person@example.net",
    },
    email_data: {
      token: "123456",
      token_hash: "signed-token-hash",
      redirect_to: "https://app.example.com/auth/callback?next=%2Faccount",
      email_action_type: action,
      site_url: "https://app.example.com",
      token_new: "",
      token_hash_new: "",
      old_email: "",
      old_phone: "",
      provider: "email",
      factor_type: "totp",
    },
  });
}

describe("Supabase Auth Send Email Hook example", () => {
  it("parses every currently documented email action", () => {
    for (const action of SUPABASE_AUTH_EMAIL_ACTIONS) {
      expect(fixture(action).email_data.email_action_type).toBe(action);
    }
    expect(() =>
      parseSupabaseAuthHookPayload({
        user: { email: "person@example.net" },
        email_data: { email_action_type: "unknown_action" },
      }),
    ).toThrow("Unsupported email_action_type");
    expect(() =>
      parseSupabaseAuthHookPayload({
        user: { email: "person@example.net\nBcc: other@example.net" },
        email_data: { email_action_type: "signup" },
      }),
    ).toThrow("Invalid user email");
  });

  it("constructs the signed Supabase confirmation URL deterministically", () => {
    const url = new URL(
      buildSupabaseConfirmationUrl(
        fixture("recovery"),
        "https://project.supabase.co",
      ),
    );

    expect(url.origin).toBe("https://project.supabase.co");
    expect(url.pathname).toBe("/auth/v1/verify");
    expect(url.searchParams.get("token")).toBe("signed-token-hash");
    expect(url.searchParams.get("type")).toBe("recovery");
    expect(url.searchParams.get("redirect_to")).toBe(
      "https://app.example.com/auth/callback?next=%2Faccount",
    );
  });

  it("renders deterministic text and escaped HTML for every action", () => {
    for (const action of SUPABASE_AUTH_EMAIL_ACTIONS) {
      const emails = renderSupabaseAuthEmails(fixture(action), {
        brand: "Example <script>alert(1)</script>",
        from: "Example <auth@example.com>",
        supabaseUrl: "https://project.supabase.co",
      });

      expect(emails).toHaveLength(1);
      for (const email of emails) {
        expect(email.from).toBe("Example <auth@example.com>");
        expect(email.subject).toContain("Example <script>");
        expect(email.text.length).toBeGreaterThan(40);
        expect(email.html).not.toContain("<script>");
        expect(email.html).toContain("&lt;script&gt;");
        expect(email.subject).not.toContain("123456");
      }
    }
  });

  it("requires a token for code-only actions", () => {
    const payload = fixture("reauthentication");
    payload.email_data.token = "";

    expect(() =>
      renderSupabaseAuthEmails(payload, {
        brand: "Example",
        from: "Example <auth@example.com>",
        supabaseUrl: "https://project.supabase.co",
      }),
    ).toThrow("Missing token");
  });

  it("renders both Secure Email Change messages with the documented hashes", () => {
    const payload = fixture("email_change");
    payload.email_data.token_new = "654321";
    payload.email_data.token_hash_new = "signed-new-token-hash";

    const emails = renderSupabaseAuthEmails(payload, {
      brand: "Example",
      from: "Example <auth@example.com>",
      supabaseUrl: "https://project.supabase.co",
    });

    expect(emails).toHaveLength(2);
    expect(emails[0]!.to).toEqual(["person@example.net"]);
    expect(emails[1]!.to).toEqual(["new-person@example.net"]);
    const currentUrl = new URL(emails[0]!.text.split("\n\n")[1]!);
    const newUrl = new URL(emails[1]!.text.split("\n\n")[1]!);
    expect(currentUrl.searchParams.get("token")).toBe(
      "signed-new-token-hash",
    );
    expect(newUrl.searchParams.get("token")).toBe("signed-token-hash");
    expect(currentUrl.searchParams.get("type")).toBe("email_change");
    expect(newUrl.searchParams.get("type")).toBe("email_change");
  });

  it("hashes the webhook ID into a stable bounded idempotency key", async () => {
    const first = await createSupabaseHookIdempotencyKey(
      "msg_sensitive-provider-hook-id",
    );
    const second = await createSupabaseHookIdempotencyKey(
      "msg_sensitive-provider-hook-id",
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^supabase-auth-[a-f0-9]{64}$/);
    expect(first).not.toContain("sensitive");
    expect(first.length).toBeLessThanOrEqual(256);
  });

  it("maps only documented retryable outcomes to Supabase retry semantics", () => {
    expect(mapHayaSendHookFailure(429)).toEqual({
      status: 503,
      retryAfter: "2",
    });
    expect(mapHayaSendHookFailure(503)).toEqual({
      status: 503,
      retryAfter: "2",
    });
    expect(mapHayaSendHookFailure(401)).toEqual({ status: 422 });
    expect(mapHayaSendHookFailure(422)).toEqual({ status: 422 });
  });

  it("normalizes the displayed hook secret and rejects unsafe origins", () => {
    expect(
      normalizeSupabaseHookSecret(
        ["v1,whsec_", "0123456789abcdef0123456789abcdef"].join(""),
      ),
    ).toBe("0123456789abcdef0123456789abcdef");
    expect(
      requireHttpsOrigin(
        "https://api.hayasend.example/",
        "HAYASEND_BASE_URL",
      ),
    ).toBe("https://api.hayasend.example");
    expect(() =>
      requireHttpsOrigin(
        "http://api.hayasend.example",
        "HAYASEND_BASE_URL",
      ),
    ).toThrow("HTTPS origin");
  });
});
