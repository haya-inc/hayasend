export const SUPABASE_AUTH_EMAIL_ACTIONS = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
  "reauthentication",
  "password_changed_notification",
  "email_changed_notification",
  "phone_changed_notification",
  "identity_linked_notification",
  "identity_unlinked_notification",
  "mfa_factor_enrolled_notification",
  "mfa_factor_unenrolled_notification",
] as const;

export type SupabaseAuthEmailAction =
  (typeof SUPABASE_AUTH_EMAIL_ACTIONS)[number];

export interface SupabaseAuthHookPayload {
  user: {
    email: string;
    new_email: string;
  };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: SupabaseAuthEmailAction;
    site_url: string;
    token_new: string;
    token_hash_new: string;
    old_email: string;
    old_phone: string;
    provider: string;
    factor_type: string;
  };
}

export interface SupabaseAuthEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

const actionSet = new Set<string>(SUPABASE_AUTH_EMAIL_ACTIONS);
const confirmationActions = new Set<SupabaseAuthEmailAction>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
]);

const subjects: Record<SupabaseAuthEmailAction, string> = {
  signup: "Confirm your email address",
  invite: "You have been invited",
  magiclink: "Your sign-in link",
  recovery: "Reset your password",
  email_change: "Confirm your new email address",
  email: "Your verification code",
  reauthentication: "Your verification code",
  password_changed_notification: "Your password was changed",
  email_changed_notification: "Your email address was changed",
  phone_changed_notification: "Your phone number was changed",
  identity_linked_notification: "A sign-in identity was linked",
  identity_unlinked_notification: "A sign-in identity was unlinked",
  mfa_factor_enrolled_notification: "A multi-factor method was added",
  mfa_factor_unenrolled_notification: "A multi-factor method was removed",
};

const introductions: Record<SupabaseAuthEmailAction, string> = {
  signup:
    "Follow the link below to confirm your email address and finish signing up.",
  invite:
    "Follow the link below to accept the invitation and finish creating your account.",
  magiclink:
    "Use the link below to sign in. It expires shortly and can only be used once.",
  recovery:
    "We received a request to reset your password. Use the link below to continue.",
  email_change:
    "Follow the link below to confirm the requested email-address change.",
  email: "Use the verification code below to continue.",
  reauthentication: "Use the verification code below to verify your identity.",
  password_changed_notification: "The password for your account was changed.",
  email_changed_notification: "The email address for your account was changed.",
  phone_changed_notification: "The phone number for your account was changed.",
  identity_linked_notification:
    "A new sign-in identity was linked to your account.",
  identity_unlinked_notification:
    "A sign-in identity was unlinked from your account.",
  mfa_factor_enrolled_notification:
    "A new multi-factor authentication method was added to your account.",
  mfa_factor_unenrolled_notification:
    "A multi-factor authentication method was removed from your account.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  record: Record<string, unknown>,
  name: string,
  maximumLength: number,
  required = false,
) {
  const value = record[name];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`Missing ${name}.`);
    }
    return "";
  }
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    /[\0]/.test(value)
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  if (required && value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function safeEmail(value: string) {
  if (
    value.length > 320 ||
    /[\r\n\0\s]/.test(value) ||
    !/^[^@]+@[^@]+$/.test(value)
  ) {
    throw new Error("Invalid user email.");
  }
  return value;
}

function optionalSafeEmail(value: string) {
  return value ? safeEmail(value) : "";
}

function safeInlineSetting(value: string, name: string, maximumLength: number) {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\r\n\0]/.test(normalized)
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return normalized;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseSupabaseAuthHookPayload(
  input: unknown,
): SupabaseAuthHookPayload {
  if (
    !isRecord(input) || !isRecord(input.user) || !isRecord(input.email_data)
  ) {
    throw new Error("Invalid Supabase Auth hook payload.");
  }
  const action = boundedString(
    input.email_data,
    "email_action_type",
    64,
    true,
  );
  if (!actionSet.has(action)) {
    throw new Error("Unsupported email_action_type.");
  }
  return {
    user: {
      email: safeEmail(boundedString(input.user, "email", 320, true)),
      new_email: optionalSafeEmail(
        boundedString(input.user, "new_email", 320),
      ),
    },
    email_data: {
      token: boundedString(input.email_data, "token", 64),
      token_hash: boundedString(input.email_data, "token_hash", 512),
      redirect_to: boundedString(input.email_data, "redirect_to", 4_096),
      email_action_type: action as SupabaseAuthEmailAction,
      site_url: boundedString(input.email_data, "site_url", 4_096),
      token_new: boundedString(input.email_data, "token_new", 64),
      token_hash_new: boundedString(
        input.email_data,
        "token_hash_new",
        512,
      ),
      old_email: boundedString(input.email_data, "old_email", 320),
      old_phone: boundedString(input.email_data, "old_phone", 128),
      provider: boundedString(input.email_data, "provider", 128),
      factor_type: boundedString(input.email_data, "factor_type", 64),
    },
  };
}

export function normalizeSupabaseHookSecret(value: string) {
  const secret = value.replace(/^v1,whsec_/, "");
  if (
    secret.length < 16 ||
    secret.length > 1_024 ||
    /[\r\n\0]/.test(secret)
  ) {
    throw new Error("Invalid SEND_EMAIL_HOOK_SECRET.");
  }
  return secret;
}

export function requireHttpsOrigin(
  value: string,
  name: string,
  allowLoopback = false,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}.`);
  }
  const loopback = url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (
    (url.protocol !== "https:" && !(allowLoopback && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin.`);
  }
  return url.origin;
}

export function buildSupabaseConfirmationUrl(
  payload: SupabaseAuthHookPayload,
  supabaseUrl: string,
  tokenHash = payload.email_data.token_hash,
) {
  const baseUrl = requireHttpsOrigin(supabaseUrl, "SUPABASE_URL", true);
  if (!tokenHash) {
    throw new Error("Missing token_hash for confirmation email.");
  }
  const url = new URL("/auth/v1/verify", baseUrl);
  url.searchParams.set("token", tokenHash);
  url.searchParams.set("type", payload.email_data.email_action_type);
  if (payload.email_data.redirect_to) {
    url.searchParams.set("redirect_to", payload.email_data.redirect_to);
  }
  return url.toString();
}

export async function createSupabaseHookIdempotencyKey(
  webhookId: string,
  discriminator = "",
) {
  if (
    webhookId.length === 0 ||
    webhookId.length > 1_024 ||
    /[\r\n\0]/.test(webhookId) ||
    discriminator.length > 64 ||
    /[^a-z0-9_-]/.test(discriminator)
  ) {
    throw new Error("Invalid webhook-id.");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      discriminator ? `${webhookId}\0${discriminator}` : webhookId,
    ),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `supabase-auth-${hash}`;
}

export function mapHayaSendHookFailure(status: number) {
  if (status === 429 || status >= 500) {
    return { status: 503 as const, retryAfter: "2" };
  }
  return { status: 422 as const };
}

function renderEmail(
  options: {
    action: SupabaseAuthEmailAction;
    brand: string;
    confirmationUrl?: string | undefined;
    from: string;
    introduction?: string;
    recipient: string;
    subject?: string;
    token?: string | undefined;
  },
) {
  const subject = options.subject ?? subjects[options.action];
  const introduction = options.introduction ?? introductions[options.action];
  const token = options.token ?? "";
  if (
    (options.action === "email" ||
      options.action === "reauthentication") &&
    !token
  ) {
    throw new Error("Missing token for verification email.");
  }
  const safetyNotice =
    "If you did not initiate this action, review your account security.";
  const textParts = [
    introduction,
    ...(options.confirmationUrl ? [options.confirmationUrl] : []),
    ...(token ? [`Verification code: ${token}`] : []),
    safetyNotice,
  ];
  const htmlParts = [
    `<p><strong>${escapeHtml(options.brand)}</strong></p>`,
    `<h2>${escapeHtml(subject)}</h2>`,
    `<p>${escapeHtml(introduction)}</p>`,
    ...(options.confirmationUrl
      ? [
        `<p><a href="${escapeHtml(options.confirmationUrl)}">Continue</a></p>`,
      ]
      : []),
    ...(token ? [`<p><code>${escapeHtml(token)}</code></p>`] : []),
    `<p>${escapeHtml(safetyNotice)}</p>`,
  ];
  return {
    from: options.from,
    to: [options.recipient],
    subject: `${subject} — ${options.brand}`,
    text: textParts.join("\n\n"),
    html: htmlParts.join(""),
  };
}

export function renderSupabaseAuthEmails(
  payload: SupabaseAuthHookPayload,
  options: {
    brand: string;
    from: string;
    supabaseUrl: string;
  },
): SupabaseAuthEmail[] {
  const brand = safeInlineSetting(options.brand, "HAYASEND_EMAIL_BRAND", 80);
  const from = safeInlineSetting(options.from, "HAYASEND_FROM", 320);
  const action = payload.email_data.email_action_type;

  if (action === "email_change") {
    const newEmail = payload.user.new_email;
    if (!newEmail) {
      throw new Error("Missing user.new_email for email change.");
    }
    const secureEmailChange = Boolean(payload.email_data.token_hash_new) ||
      Boolean(payload.email_data.token_new);
    if (secureEmailChange) {
      if (
        !payload.email_data.token ||
        !payload.email_data.token_hash ||
        !payload.email_data.token_new ||
        !payload.email_data.token_hash_new
      ) {
        throw new Error("Incomplete Secure Email Change token pairs.");
      }
      return [
        renderEmail({
          action,
          brand,
          from,
          recipient: payload.user.email,
          subject: "Confirm your email address change",
          introduction:
            "Follow the link below to confirm the requested change from your current email address.",
          confirmationUrl: buildSupabaseConfirmationUrl(
            payload,
            options.supabaseUrl,
            payload.email_data.token_hash_new,
          ),
        }),
        renderEmail({
          action,
          brand,
          from,
          recipient: newEmail,
          subject: "Confirm your new email address",
          introduction:
            "Follow the link below to confirm this as your new email address.",
          confirmationUrl: buildSupabaseConfirmationUrl(
            payload,
            options.supabaseUrl,
            payload.email_data.token_hash,
          ),
        }),
      ];
    }
    return [
      renderEmail({
        action,
        brand,
        from,
        recipient: newEmail,
        confirmationUrl: buildSupabaseConfirmationUrl(
          payload,
          options.supabaseUrl,
        ),
      }),
    ];
  }

  return [
    renderEmail({
      action,
      brand,
      from,
      recipient: payload.user.email,
      confirmationUrl: confirmationActions.has(action)
        ? buildSupabaseConfirmationUrl(payload, options.supabaseUrl)
        : undefined,
      token: action === "email" || action === "reauthentication"
        ? payload.email_data.token
        : undefined,
    }),
  ];
}
