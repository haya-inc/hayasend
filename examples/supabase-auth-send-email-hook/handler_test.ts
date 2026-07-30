import { Webhook } from "standardwebhooks";
import { createSupabaseAuthEmailHandler } from "./handler.ts";
import type { SupabaseAuthEmailAction } from "./email.ts";

const hookSecret = "MDEyMzQ1Njc4OWFiY2RlZg==";
const hayasendApiKey = `re_hs_key_${"a".repeat(32)}.${"B".repeat(43)}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function signedRequest(body: string, webhookId = "msg_hook_123") {
  const timestamp = new Date();
  const signer = new Webhook(`whsec_${hookSecret}`);
  return new Request("https://function.example.net/hayasend-auth-email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-signature": signer.sign(webhookId, timestamp, body),
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
    },
    body,
  });
}

function hookBody(action: SupabaseAuthEmailAction = "recovery") {
  return JSON.stringify({
    user: {
      email: "person@example.net",
      new_email: "new-person@example.net",
    },
    email_data: {
      token: "123456",
      token_hash: "signed-token-hash",
      token_new: "654321",
      token_hash_new: "signed-new-token-hash",
      redirect_to: "https://app.example.com/auth/callback",
      email_action_type: action,
      site_url: "https://app.example.com",
    },
  });
}

function mockFetch() {
  const calls: Array<{
    input: RequestInfo | URL;
    init?: RequestInit;
  }> = [];
  const fetchImplementation = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    );
  }) as typeof fetch;
  return { calls, fetchImplementation };
}

function hookHandler(fetchImplementation: typeof fetch) {
  return createSupabaseAuthEmailHandler(
    {
      hayasendBaseUrl: "https://api.hayasend.example",
      hayasendApiKey,
      hayasendFrom: "Example <auth@example.com>",
      emailBrand: "Example",
      supabaseUrl: "https://project.supabase.co",
      sendEmailHookSecret: `v1,whsec_${hookSecret}`,
    },
    { fetchImplementation },
  );
}

Deno.test("verifies the signed raw body before submitting to HayaSend", async () => {
  const { calls, fetchImplementation } = mockFetch();
  const handler = hookHandler(fetchImplementation);
  const response = await handler(signedRequest(hookBody()));

  assert(response.status === 200, "Expected a successful hook response.");
  assert(calls.length === 1, "Expected one HayaSend request.");
  const call = calls[0]!;
  assert(
    String(call.input) === "https://api.hayasend.example/emails",
    "Expected the configured HayaSend endpoint.",
  );
  const headers = new Headers(call.init?.headers);
  assert(
    headers.get("authorization") === `Bearer ${hayasendApiKey}`,
    "Expected the scoped HayaSend credential.",
  );
  assert(
    /^supabase-auth-[a-f0-9]{64}$/.test(
      headers.get("idempotency-key") ?? "",
    ),
    "Expected a bounded hashed idempotency key.",
  );
  const email = JSON.parse(String(call.init?.body)) as {
    to?: string[];
    subject?: string;
  };
  assert(
    email.to?.[0] === "person@example.net",
    "Expected the signed recipient.",
  );
  assert(
    email.subject === "Reset your password — Example",
    "Expected the deterministic subject.",
  );
});

Deno.test("uses one idempotency claim for retries of the same signed hook", async () => {
  const { calls, fetchImplementation } = mockFetch();
  const handler = hookHandler(fetchImplementation);
  const body = hookBody();

  await handler(signedRequest(body, "msg_stable_hook_id"));
  await handler(signedRequest(body, "msg_stable_hook_id"));

  assert(calls.length === 2, "Expected both deliveries to reach HayaSend.");
  const first = new Headers(calls[0]!.init?.headers).get("idempotency-key");
  const second = new Headers(calls[1]!.init?.headers).get("idempotency-key");
  assert(first === second, "Expected retries to use one idempotency claim.");
});

Deno.test("submits both Secure Email Change messages with distinct claims", async () => {
  const { calls, fetchImplementation } = mockFetch();
  const handler = hookHandler(fetchImplementation);
  const response = await handler(signedRequest(hookBody("email_change")));

  assert(response.status === 200, "Expected a successful hook response.");
  assert(calls.length === 2, "Expected both email-change messages.");
  const recipients = calls.map((call) => {
    const email = JSON.parse(String(call.init?.body)) as {
      to?: string[];
    };
    return email.to?.[0];
  });
  assert(
    recipients[0] === "person@example.net" &&
      recipients[1] === "new-person@example.net",
    "Expected current and new recipients in documented order.",
  );
  const keys = calls.map((call) =>
    new Headers(call.init?.headers).get("idempotency-key")
  );
  assert(
    keys[0] !== keys[1],
    "Expected a distinct deterministic claim for each message.",
  );
});

Deno.test("rejects unsigned payloads without contacting HayaSend", async () => {
  const { calls, fetchImplementation } = mockFetch();
  const handler = hookHandler(fetchImplementation);
  const response = await handler(
    new Request("https://function.example.net/hayasend-auth-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: hookBody(),
    }),
  );

  assert(response.status === 401, "Expected unsigned input to be rejected.");
  assert(calls.length === 0, "Unsigned input must not contact HayaSend.");
});

Deno.test("rejects bootstrap or development API keys at startup", () => {
  const { fetchImplementation } = mockFetch();
  let rejected = false;
  try {
    createSupabaseAuthEmailHandler(
      {
        hayasendBaseUrl: "https://api.hayasend.example",
        hayasendApiKey: "re_hayasend_dev",
        hayasendFrom: "Example <auth@example.com>",
        emailBrand: "Example",
        supabaseUrl: "https://project.supabase.co",
        sendEmailHookSecret: `v1,whsec_${hookSecret}`,
      },
      { fetchImplementation },
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "Expected only scoped HayaSend keys to be accepted.");
});
