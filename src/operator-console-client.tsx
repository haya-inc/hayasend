/** @jsxImportSource hono/jsx/dom */

import { render, useState } from "hono/jsx/dom";

import {
  OPERATOR_CONSOLE_NAVIGATION,
  type OperatorConsoleView,
} from "./operator-console-model.js";

type StatusTone = "success" | "warning" | "danger" | "neutral";

interface EmailSummary {
  id: string;
  subject?: string | null;
  from?: string | null;
  to?: string[];
  status?: string | null;
  created_at?: string | null;
}

interface EmailRecord extends EmailSummary {
  html?: string | null;
  text?: string | null;
  last_event?: string | null;
  message_id?: string | null;
  provider_id?: string | null;
  attachments?: unknown[];
  [key: string]: unknown;
}

interface RecipientAttempt {
  sequence: number;
}

interface RecipientRecord {
  role: string;
  ordinal: number;
  status: string;
  recovery_state: string;
  latest_attempt?: RecipientAttempt | null;
}

interface RecipientPage {
  aggregate_status?: string | null;
  recipient_count?: number | null;
  data?: RecipientRecord[];
}

interface NavigationOptions {
  initialView: OperatorConsoleView;
  onNavigate: (view: OperatorConsoleView) => void;
}

interface AuthOptions {
  betterAuthEnabled: boolean;
  onConnect: (apiKey: string) => Promise<void>;
  onGoogleSignIn: () => Promise<void>;
}

interface SendDialogOptions {
  onSubmit: (form: HTMLFormElement) => Promise<void>;
}

interface EmailBrowserOptions {
  emails: EmailSummary[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onCopyMessageId: (id: string) => void | Promise<void>;
}

type EmailDetailState =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      email: EmailRecord;
      recipients: RecipientPage;
      safeMarkup: string;
    };

interface EmailBrowserController {
  setSelectedId: (id: string | null) => void;
  setDetail: (detail: EmailDetailState) => void;
}

interface NavigationController {
  setActiveView: (view: OperatorConsoleView) => void;
  setEmailCount: (count: number) => void;
}

interface AuthController {
  reset: (message: string) => void;
}

interface SendDialogController {
  open: () => void;
}

interface OperatorConsoleUiBridge {
  mountAuth(options: AuthOptions): void;
  resetAuth(message?: string): void;
  mountNavigation(options: NavigationOptions): void;
  setActiveView(view: OperatorConsoleView): void;
  setEmailCount(count: number): void;
  renderEmails(options: EmailBrowserOptions): void;
  setSelectedEmail(id: string | null): void;
  showEmailEmpty(): void;
  showEmailLoading(): void;
  showEmailError(message: string): void;
  showEmailDetail(
    email: EmailRecord,
    recipients: RecipientPage,
    safeMarkup: string,
  ): void;
  mountSendDialog(options: SendDialogOptions): void;
  openSendDialog(): void;
}

declare global {
  interface Window {
    HayaSendConsoleUI?: OperatorConsoleUiBridge;
  }
}

let navigationController: NavigationController | null = null;
let emailBrowserController: EmailBrowserController | null = null;
let authController: AuthController | null = null;
let sendDialogController: SendDialogController | null = null;
let activePreviewMarkup = "";

const PREVIEW_MESSAGE_TYPE = "hayasend.operator-console.preview.v1";
const PREVIEW_READY_TYPE = "hayasend.operator-console.preview-ready.v1";

window.addEventListener("message", (event) => {
  if (
    !event.data ||
    event.data.type !== PREVIEW_READY_TYPE ||
    !activePreviewMarkup
  ) {
    return;
  }
  const source = event.source;
  if (!source || !("postMessage" in source)) return;
  (source as Window).postMessage(
    { type: PREVIEW_MESSAGE_TYPE, markup: activePreviewMarkup },
    "*",
  );
});

function formatDate(value: string | null | undefined, includeSeconds = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  }).format(date);
}

function relativeTime(value: string | null | undefined) {
  const delta = Date.now() - Date.parse(value ?? "");
  if (!Number.isFinite(delta)) return "—";
  const seconds = Math.max(0, Math.floor(delta / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusTone(status: string): StatusTone {
  if (
    [
      "delivered",
      "opened",
      "clicked",
      "verified",
      "enabled",
      "production",
      "succeeded",
      "ok",
    ].includes(status)
  ) {
    return "success";
  }
  if (
    ["failed", "bounced", "complained", "rejected", "disabled"].includes(
      status,
    )
  ) {
    return "danger";
  }
  if (
    [
      "delivery_delayed",
      "suppressed",
      "pending",
      "beta",
      "experimental",
      "scheduled",
    ].includes(status)
  ) {
    return "warning";
  }
  return "neutral";
}

function StatusPill({ value }: { value: string | null | undefined }) {
  const normalized = String(value || "unknown");
  return (
    <span class="status-pill" data-tone={statusTone(normalized)}>
      {normalized.replaceAll("_", " ")}
    </span>
  );
}

function AuthPanel({
  betterAuthEnabled,
  onConnect,
  onGoogleSignIn,
}: AuthOptions) {
  const [apiKey, setApiKey] = useState("");
  const [secretVisible, setSecretVisible] = useState(false);
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState<"google" | "key" | null>(
    null,
  );

  authController = {
    reset(message) {
      setApiKey("");
      setSecretVisible(false);
      setPendingAction(null);
      setError(message);
    },
  };

  const signInWithGoogle = async () => {
    setError("");
    setPendingAction("google");
    try {
      await onGoogleSignIn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
      setPendingAction(null);
    }
  };

  const connectWithKey = async (event: Event) => {
    event.preventDefault();
    setError("");
    setPendingAction("key");
    try {
      await onConnect(apiKey.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection failed.");
      setPendingAction(null);
    }
  };

  return (
    <>
      <p class="eyebrow">Deployment-local console</p>
      <h1 id="auth-title">Operate the mail you own.</h1>
      <p class="auth-copy">
        {betterAuthEnabled
          ? "Sign in with an approved workspace account. HayaSend keeps the session on this deployment."
          : "Connect with a scoped HayaSend API key. The key stays in this browser tab and is sent only to this deployment."}
      </p>
      <button
        id="google-sign-in"
        class="primary-action auth-provider-action"
        type="button"
        hidden={!betterAuthEnabled}
        disabled={pendingAction !== null}
        onClick={() => void signInWithGoogle()}
      >
        {pendingAction === "google" ? "Opening Google…" : "Continue with Google"}
      </button>
      <details
        id="api-key-fallback"
        class="auth-fallback"
        open={!betterAuthEnabled}
      >
        <summary>{betterAuthEnabled ? "Use an API key instead" : "API key"}</summary>
        <form id="auth-form" class="auth-form" onSubmit={connectWithKey}>
          <label for="api-key">API key</label>
          <div class="secret-field">
            <input
              id="api-key"
              name="api-key"
              type={secretVisible ? "text" : "password"}
              autocomplete="current-password"
              spellcheck={false}
              required
              placeholder="re_hs_key_…"
              value={apiKey}
              onInput={(event: Event) => {
                setApiKey((event.currentTarget as HTMLInputElement).value);
              }}
            />
            <button
              id="toggle-secret"
              class="field-action"
              type="button"
              aria-label={secretVisible ? "Hide API key" : "Show API key"}
              onClick={() => setSecretVisible((visible) => !visible)}
            >
              {secretVisible ? "Hide" : "Show"}
            </button>
          </div>
          <button
            id="connect"
            class="quiet-action auth-key-action"
            type="submit"
            disabled={pendingAction !== null}
          >
            {pendingAction === "key" ? "Connecting…" : "Connect with API key"}
          </button>
        </form>
      </details>
      <p id="auth-error" class="form-error" role="alert" hidden={!error}>
        {error}
      </p>
      <div class="auth-boundary">
        <span class="boundary-dot" aria-hidden="true"></span>
        <span id="deployment-origin">Same-origin only · {location.origin}</span>
      </div>
    </>
  );
}

function SendDialog({ onSubmit }: SendDialogOptions) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const dialog = () =>
    document.getElementById("send-dialog") as HTMLDialogElement | null;
  const close = () => dialog()?.close();
  sendDialogController = {
    open() {
      setError("");
      dialog()?.showModal();
    },
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    setError("");
    setPending(true);
    try {
      await onSubmit(form);
      form.reset();
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Send failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form id="send-form" onSubmit={submit}>
      <header class="dialog-heading">
        <div>
          <p class="eyebrow">Scoped test send</p>
          <h2 id="send-title">Send one transactional email</h2>
        </div>
        <button
          id="close-send"
          class="icon-action"
          type="button"
          aria-label="Close"
          onClick={close}
        >
          ×
        </button>
      </header>
      <div class="dialog-grid">
        <label>
          From
          <input
            name="from"
            type="text"
            autocomplete="off"
            placeholder="HayaSend <hello@example.com>"
          />
        </label>
        <label>
          To
          <input
            name="to"
            type="email"
            autocomplete="off"
            required
            placeholder="recipient@example.com"
          />
        </label>
        <label class="wide">
          Subject
          <input
            name="subject"
            type="text"
            required
            maxlength={998}
            placeholder="Delivery verification"
          />
        </label>
        <label class="wide">
          HTML
          <textarea name="html" rows={7} placeholder="<h1>Hello</h1>"></textarea>
        </label>
        <label class="wide">
          Plain text
          <textarea name="text" rows={5} placeholder="Hello"></textarea>
        </label>
      </div>
      <p class="dialog-note">
        A fresh idempotency key is attached. HayaSend still applies all
        recipient, budget, and provider policies.
      </p>
      <p id="send-error" class="form-error" role="alert" hidden={!error}>
        {error}
      </p>
      <footer class="dialog-actions">
        <button
          id="cancel-send"
          class="quiet-action"
          type="button"
          onClick={close}
        >
          Cancel
        </button>
        <button
          id="submit-send"
          class="primary-action"
          type="submit"
          disabled={pending}
        >
          {pending ? "Sending…" : "Send email"}
        </button>
      </footer>
    </form>
  );
}

function Navigation({ initialView, onNavigate }: NavigationOptions) {
  const [activeView, setActiveView] = useState(initialView);
  const [emailCount, setEmailCount] = useState(0);
  navigationController = { setActiveView, setEmailCount };

  const navigate = (view: OperatorConsoleView) => {
    setActiveView(view);
    onNavigate(view);
  };

  return (
    <>
      <div class="nav-primary">
        {OPERATOR_CONSOLE_NAVIGATION.map(([view, glyph, label]) => (
          <button
            class={`nav-item${activeView === view ? " is-active" : ""}`}
            type="button"
            data-view={view}
            aria-label={view === "received" ? "Received emails" : label}
            aria-current={activeView === view ? "page" : undefined}
            onClick={() => navigate(view)}
          >
            <span class="nav-glyph" aria-hidden="true">{glyph}</span>
            <span>{label}</span>
            {view === "emails" && emailCount > 0 ? (
              <span id="nav-email-count" class="nav-count">{emailCount}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div class="nav-secondary">
        <button
          class={`nav-item${activeView === "operations" ? " is-active" : ""}`}
          type="button"
          data-view="operations"
          aria-label="Operations"
          aria-current={activeView === "operations" ? "page" : undefined}
          onClick={() => navigate("operations")}
        >
          <span class="nav-glyph" aria-hidden="true">↺</span>
          <span>Operations</span>
        </button>
        <a
          class="nav-item"
          href="https://hayasend.com/api-reference.html"
          rel="noreferrer"
        >
          <span class="nav-glyph" aria-hidden="true">↗</span>
          <span>API reference</span>
        </a>
      </div>
    </>
  );
}

function DetailEmpty() {
  return (
    <div class="detail-empty">
      <p class="eyebrow">Message inspector</p>
      <h2>Select an email to inspect its delivery truth.</h2>
      <p>
        Content stays in this deployment. Recipient summaries expose terminal
        state and recovery attention without duplicating addresses.
      </p>
    </div>
  );
}

function LoadingState() {
  return <div class="loading-state"><div class="loading-line"></div></div>;
}

function DetailError({ message }: { message: string }) {
  return (
    <div class="error-state">
      <h2>This email could not be loaded.</h2>
      <p>{message}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value == null || value === "" ? "—" : String(value)}</dd>
    </div>
  );
}

function EmailDetail({
  email,
  recipients,
  safeMarkup,
  onCopyMessageId,
}: Extract<EmailDetailState, { kind: "ready" }> & {
  onCopyMessageId: (id: string) => void | Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<"html" | "text" | "source">(
    "html",
  );
  const tabs = ["html", "text", "source"] as const;
  const status = recipients.aggregate_status || email.status;
  activePreviewMarkup = safeMarkup;

  return (
    <>
      <header class="message-head">
        <div class="message-head-line">
          <StatusPill value={status} />
          <button
            class="copy-link"
            type="button"
            onClick={() => void onCopyMessageId(email.id)}
          >
            Copy message ID
          </button>
        </div>
        <h2>{email.subject || "(no subject)"}</h2>
        <p class="message-route-detail">
          {email.from || "—"} → {(email.to || []).join(", ")}
        </p>
      </header>
      <div
        class="detail-tabs"
        role="tablist"
        aria-label="Message representation"
      >
        {tabs.map((tab) => (
          <button
            class={`detail-tab${activeTab === tab ? " is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab ? "true" : "false"}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "html" ? "HTML" : tab === "text" ? "Text" : "Source"}
          </button>
        ))}
      </div>
      <div>
        <iframe
          class="preview-frame"
          title="Sandboxed email HTML preview"
          sandbox="allow-scripts"
          src="/console/preview"
          hidden={activeTab !== "html"}
        ></iframe>
        <pre class="text-preview" hidden={activeTab !== "text"}>
          {email.text || "No plain-text body."}
        </pre>
        <pre class="text-preview" hidden={activeTab !== "source"}>
          {JSON.stringify(email, null, 2)}
        </pre>
      </div>
      <div class="detail-lower">
        <section class="detail-panel">
          <h3>Message facts</h3>
          <dl class="fact-list">
            <Fact label="Created" value={formatDate(email.created_at, true)} />
            <Fact label="Last event" value={email.last_event} />
            <Fact label="Provider ID" value={email.message_id || email.provider_id} />
            <Fact label="Recipients" value={recipients.recipient_count} />
            <Fact label="Attachments" value={(email.attachments || []).length} />
            <Fact label="Message ID" value={email.id} />
          </dl>
        </section>
        <section class="detail-panel">
          <h3>Recipient ledger</h3>
          <div class="recipient-list">
            {(recipients.data || []).map((recipient) => (
              <div class="recipient-row">
                <span class="recipient-index">
                  {recipient.role} {recipient.ordinal + 1}
                </span>
                <span class="recipient-state">
                  <StatusPill value={recipient.status} />
                </span>
                <span class="recipient-attempt">
                  {recipient.latest_attempt
                    ? `attempt ${recipient.latest_attempt.sequence} · ${recipient.recovery_state}`
                    : recipient.recovery_state}
                </span>
              </div>
            ))}
            {(recipients.data || []).length === 0 ? (
              <p class="signal-detail">No recipient summaries available.</p>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}

function EmailInspector({
  detail,
  onCopyMessageId,
}: {
  detail: EmailDetailState;
  onCopyMessageId: (id: string) => void | Promise<void>;
}) {
  if (detail.kind === "loading") return <LoadingState />;
  if (detail.kind === "error") return <DetailError message={detail.message} />;
  if (detail.kind === "ready") {
    return <EmailDetail {...detail} onCopyMessageId={onCopyMessageId} />;
  }
  return <DetailEmpty />;
}

function EmailBrowser({
  emails,
  selectedId: initialSelectedId = null,
  onSelect,
  onCopyMessageId,
}: EmailBrowserOptions) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );
  const [detail, setDetail] = useState<EmailDetailState>({ kind: "empty" });
  emailBrowserController = { setSelectedId, setDetail };

  const normalized = query.trim().toLowerCase();
  const records = emails.filter((email) => {
    if (!normalized) return true;
    return [
      email.subject,
      email.from,
      ...(email.to || []),
      email.id,
      email.status,
    ].some((value) =>
      String(value || "").toLowerCase().includes(normalized),
    );
  });

  const select = (id: string) => {
    setSelectedId(id);
    setDetail({ kind: "loading" });
    onSelect(id);
  };

  return (
    <>
      <div class="toolbar">
        <label class="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            autocomplete="off"
            placeholder="Search subject, recipient, status, or ID"
            aria-label="Search emails"
            value={query}
            onInput={(event: Event) => {
              setQuery((event.currentTarget as HTMLInputElement).value);
            }}
          />
        </label>
        <span id="email-visible-count" class="toolbar-meta">
          {records.length} shown
        </span>
      </div>
      <section class="email-workspace">
        <div class="email-list" role="listbox" aria-label="Sent emails">
          {records.map((email) => (
            <button
              class={`email-row${selectedId === email.id ? " is-selected" : ""}`}
              type="button"
              data-email-id={email.id}
              role="option"
              aria-selected={selectedId === email.id ? "true" : "false"}
              onClick={() => select(email.id)}
            >
              <span class="email-row-head">
                <span class="email-subject">{email.subject || "(no subject)"}</span>
                <time class="email-time">{relativeTime(email.created_at)}</time>
              </span>
              <span class="email-row-foot">
                <span class="email-route">
                  {(email.to || []).join(", ") || "No recipient"}
                </span>
                <StatusPill value={email.status} />
              </span>
            </button>
          ))}
          {records.length === 0 ? (
            <div class="empty-resource email-list-empty">
              <h2>{normalized ? "No matching email." : "No emails yet."}</h2>
              <p>
                {normalized
                  ? "Try a recipient, subject, status, or HayaSend message ID."
                  : "Send through the API, an official Resend SDK, or the scoped test-send action."}
              </p>
            </div>
          ) : null}
        </div>
        <article id="email-detail" class="email-detail">
          <EmailInspector
            detail={detail}
            onCopyMessageId={onCopyMessageId}
          />
        </article>
      </section>
    </>
  );
}

const bridge: OperatorConsoleUiBridge = {
  mountAuth(options) {
    const container = document.querySelector<HTMLElement>(".auth-panel");
    if (!container) throw new Error("Console authentication mount is missing.");
    render(<AuthPanel {...options} />, container);
  },
  resetAuth(message = "") {
    authController?.reset(message);
  },
  mountNavigation(options) {
    const container = document.querySelector<HTMLElement>(".side-nav");
    if (!container) throw new Error("Console navigation mount is missing.");
    render(<Navigation {...options} />, container);
  },
  setActiveView(view) {
    navigationController?.setActiveView(view);
  },
  setEmailCount(count) {
    navigationController?.setEmailCount(count);
  },
  renderEmails(options) {
    const container = document.getElementById("view-body");
    if (!container) throw new Error("Console workspace mount is missing.");
    emailBrowserController = null;
    render(<EmailBrowser {...options} />, container);
  },
  setSelectedEmail(id) {
    emailBrowserController?.setSelectedId(id);
  },
  showEmailEmpty() {
    emailBrowserController?.setDetail({ kind: "empty" });
  },
  showEmailLoading() {
    emailBrowserController?.setDetail({ kind: "loading" });
  },
  showEmailError(message) {
    emailBrowserController?.setDetail({ kind: "error", message });
  },
  showEmailDetail(email, recipients, safeMarkup) {
    emailBrowserController?.setDetail({
      kind: "ready",
      email,
      recipients,
      safeMarkup,
    });
  },
  mountSendDialog(options) {
    const container = document.getElementById("send-dialog");
    if (!container) throw new Error("Console send dialog mount is missing.");
    render(<SendDialog {...options} />, container);
  },
  openSendDialog() {
    sendDialogController?.open();
  },
};

window.HayaSendConsoleUI = bridge;
