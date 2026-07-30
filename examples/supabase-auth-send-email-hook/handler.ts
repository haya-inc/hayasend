import { Webhook } from "standardwebhooks";
import {
  createSupabaseHookIdempotencyKey,
  mapHayaSendHookFailure,
  normalizeSupabaseHookSecret,
  parseSupabaseAuthHookPayload,
  renderSupabaseAuthEmails,
  requireHttpsOrigin,
} from "./email.ts";

const MAX_HOOK_BYTES = 64 * 1024;
const HAYASEND_TIMEOUT_MS = 3_500;

export interface SupabaseAuthEmailHandlerConfig {
  hayasendBaseUrl: string;
  hayasendApiKey: string;
  hayasendFrom: string;
  emailBrand: string;
  supabaseUrl: string;
  sendEmailHookSecret: string;
}

export interface SupabaseAuthEmailHandlerDependencies {
  fetchImplementation?: typeof fetch;
}

async function readBodyWithLimit(request: Request) {
  if (!request.body) {
    throw new Error("Missing hook body.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > MAX_HOOK_BYTES) {
      await reader.cancel();
      throw new Error("Hook body is too large.");
    }
    chunks.push(value);
  }
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(content);
}

function jsonResponse(
  status: number,
  code?: string,
  retryAfter?: string,
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (retryAfter) {
    headers.set("retry-after", retryAfter);
  }
  return new Response(
    code
      ? JSON.stringify({
        error: {
          http_code: status,
          message: code,
        },
      })
      : JSON.stringify({}),
    { status, headers },
  );
}

function safeFailureCategory(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timeout";
  }
  if (error instanceof TypeError) {
    return "network";
  }
  return "internal";
}

function requireScopedApiKey(value: string) {
  if (!/^re_hs_key_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("HAYASEND_API_KEY must be an exact scoped HayaSend key.");
  }
  return value;
}

export function createSupabaseAuthEmailHandler(
  config: SupabaseAuthEmailHandlerConfig,
  dependencies: SupabaseAuthEmailHandlerDependencies = {},
) {
  const hayasendOrigin = requireHttpsOrigin(
    config.hayasendBaseUrl,
    "HAYASEND_BASE_URL",
  );
  const supabaseOrigin = requireHttpsOrigin(
    config.supabaseUrl,
    "SUPABASE_URL",
  );
  const hayasendApiKey = requireScopedApiKey(config.hayasendApiKey);
  const webhook = new Webhook(
    normalizeSupabaseHookSecret(config.sendEmailHookSecret),
  );
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;

  return async (request: Request) => {
    if (request.method !== "POST") {
      return jsonResponse(405, "method_not_allowed");
    }
    let rawBody: string;
    try {
      rawBody = await readBodyWithLimit(request);
    } catch {
      return jsonResponse(413, "invalid_hook_body");
    }

    let payload;
    try {
      payload = parseSupabaseAuthHookPayload(
        webhook.verify(rawBody, Object.fromEntries(request.headers)),
      );
    } catch {
      return jsonResponse(401, "invalid_hook_signature_or_payload");
    }

    const webhookId = request.headers.get("webhook-id") ?? "";
    let idempotencyKeys: string[];
    let emails;
    try {
      emails = renderSupabaseAuthEmails(payload, {
        brand: config.emailBrand,
        from: config.hayasendFrom,
        supabaseUrl: supabaseOrigin,
      });
      idempotencyKeys = await Promise.all(
        emails.map((_, index) =>
          createSupabaseHookIdempotencyKey(
            webhookId,
            emails.length === 1 ? "" : `message-${index}`,
          )
        ),
      );
    } catch {
      return jsonResponse(400, "invalid_hook_payload");
    }

    const outcomes = await Promise.allSettled(
      emails.map((email, index) =>
        fetchImplementation(
          new URL("/emails", hayasendOrigin),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${hayasendApiKey}`,
              "content-type": "application/json",
              "idempotency-key": idempotencyKeys[index]!,
            },
            body: JSON.stringify(email),
            redirect: "error",
            signal: AbortSignal.timeout(HAYASEND_TIMEOUT_MS),
          },
        )
      ),
    );
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    if (rejected) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Supabase Auth email submission failed",
          error_type: safeFailureCategory(rejected.reason),
        }),
      );
      return jsonResponse(503, "hayasend_temporarily_unavailable", "2");
    }
    const failures = outcomes
      .filter(
        (outcome): outcome is PromiseFulfilledResult<Response> =>
          outcome.status === "fulfilled",
      )
      .map((outcome) => outcome.value)
      .filter((response) => !response.ok)
      .map((response) => mapHayaSendHookFailure(response.status));
    if (failures.length === 0) {
      return jsonResponse(200);
    }
    const retryable = failures.find((failure) => failure.status === 503);
    if (retryable) {
      return jsonResponse(
        503,
        "hayasend_temporarily_unavailable",
        retryable.retryAfter,
      );
    }
    return jsonResponse(422, "hayasend_rejected_email");
  };
}
