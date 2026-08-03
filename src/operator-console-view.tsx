/** @jsxImportSource hono/jsx */
/** @jsx jsx */

import { jsx, type FC } from "hono/jsx";

import { OPERATOR_CONSOLE_NAVIGATION } from "./operator-console-model.js";

// SAM's esbuild integration currently emits classic JSX calls. The explicit
// factory keeps the Lambda bundle on Hono JSX while TypeScript uses its JSX
// runtime for type checking.
void jsx;

export interface OperatorConsoleViewOptions {
  betterAuthEnabled: boolean;
}

const Brand: FC<{ compact?: boolean }> = ({ compact = false }) => (
  <span class={compact ? "brand" : "auth-brand"} aria-label="HayaSend">
    <span class="brand-mark" aria-hidden="true">H</span>
    <span>HayaSend</span>
  </span>
);

const AuthScreen: FC<OperatorConsoleViewOptions> = ({ betterAuthEnabled }) => (
  <section id="auth-screen" class="auth-screen" aria-labelledby="auth-title">
    <Brand />
    <div class="auth-panel">
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
      >
        Continue with Google
      </button>
      <details
        id="api-key-fallback"
        class="auth-fallback"
        open={!betterAuthEnabled}
      >
        <summary>{betterAuthEnabled ? "Use an API key instead" : "API key"}</summary>
        <form id="auth-form" class="auth-form">
          <label for="api-key">API key</label>
          <div class="secret-field">
            <input
              id="api-key"
              name="api-key"
              type="password"
              autocomplete="current-password"
              spellcheck={false}
              required
              placeholder="re_hs_key_…"
            />
            <button id="toggle-secret" class="field-action" type="button" aria-label="Show API key">Show</button>
          </div>
          <button id="connect" class="quiet-action auth-key-action" type="submit">Connect with API key</button>
        </form>
      </details>
      <p id="auth-error" class="form-error" role="alert" hidden></p>
      <div class="auth-boundary">
        <span class="boundary-dot" aria-hidden="true"></span>
        <span id="deployment-origin">Same-origin connection</span>
      </div>
    </div>
    <p class="auth-foot">No Haya-managed message store · No analytics · No cloud credentials</p>
  </section>
);

const Topbar: FC = () => (
  <header class="topbar">
    <a class="brand-link" href="/console" aria-label="HayaSend Operator Console"><Brand compact /></a>
    <div class="deployment-state">
      <span id="health-dot" class="health-dot" aria-hidden="true"></span>
      <span id="deployment-label">Checking deployment</span>
    </div>
    <div class="topbar-actions">
      <button id="refresh-view" class="quiet-action" type="button">Refresh</button>
      <button id="open-send" class="primary-action compact" type="button">Send test</button>
      <button id="account-menu" class="account-button" type="button" aria-expanded="false" aria-controls="account-popover">
        <span id="account-initial">O</span>
        <span id="account-name">Operator</span>
      </button>
    </div>
    <div id="account-popover" class="account-popover" hidden>
      <p id="account-detail"></p>
      <button id="sign-out" type="button">Sign out</button>
    </div>
  </header>
);

const Navigation: FC = () => (
  <nav class="side-nav" aria-label="Console navigation">
    <div class="nav-primary">
      {OPERATOR_CONSOLE_NAVIGATION.map(([view, glyph, label], index) => (
        <button
          class={`nav-item${index === 0 ? " is-active" : ""}`}
          type="button"
          data-view={view}
          aria-label={view === "received" ? "Received emails" : label}
          aria-current={index === 0 ? "page" : undefined}
        >
          <span class="nav-glyph" aria-hidden="true">{glyph}</span><span>{label}</span>
          {view === "emails" ? <span id="nav-email-count" class="nav-count"></span> : null}
        </button>
      ))}
    </div>
    <div class="nav-secondary">
      <button class="nav-item" type="button" data-view="operations" aria-label="Operations">
        <span class="nav-glyph" aria-hidden="true">↺</span><span>Operations</span>
      </button>
      <a class="nav-item" href="https://hayasend.com/api-reference.html" rel="noreferrer">
        <span class="nav-glyph" aria-hidden="true">↗</span><span>API reference</span>
      </a>
    </div>
  </nav>
);

const Workspace: FC = () => (
  <main id="workspace-main" class="workspace-main" tabindex={-1}>
    <header class="view-heading">
      <div>
        <p id="view-eyebrow" class="eyebrow">Current deployment</p>
        <h1 id="view-title">Overview</h1>
        <p id="view-description" class="view-description">Delivery health and recovery signals from this HayaSend deployment.</p>
      </div>
      <time id="freshness" class="freshness"></time>
    </header>
    <div id="view-body" class="view-body" aria-live="polite"></div>
  </main>
);

const SendDialog: FC = () => (
  <dialog id="send-dialog" class="send-dialog" aria-labelledby="send-title">
    <form id="send-form" method="dialog">
      <header class="dialog-heading">
        <div><p class="eyebrow">Scoped test send</p><h2 id="send-title">Send one transactional email</h2></div>
        <button id="close-send" class="icon-action" type="button" aria-label="Close">×</button>
      </header>
      <div class="dialog-grid">
        <label>From <input name="from" type="text" autocomplete="off" placeholder="HayaSend <hello@example.com>" /></label>
        <label>To <input name="to" type="email" autocomplete="off" required placeholder="recipient@example.com" /></label>
        <label class="wide">Subject <input name="subject" type="text" required maxlength={998} placeholder="Delivery verification" /></label>
        <label class="wide">HTML <textarea name="html" rows={7} placeholder="<h1>Hello</h1>"></textarea></label>
        <label class="wide">Plain text <textarea name="text" rows={5} placeholder="Hello"></textarea></label>
      </div>
      <p class="dialog-note">A fresh idempotency key is attached. HayaSend still applies all recipient, budget, and provider policies.</p>
      <p id="send-error" class="form-error" role="alert" hidden></p>
      <footer class="dialog-actions">
        <button id="cancel-send" class="quiet-action" type="button">Cancel</button>
        <button id="submit-send" class="primary-action" type="submit">Send email</button>
      </footer>
    </form>
  </dialog>
);

const ResourceDialog: FC = () => (
  <dialog id="resource-dialog" class="send-dialog resource-dialog" aria-labelledby="resource-dialog-title">
    <form id="resource-form">
      <header class="dialog-heading">
        <div><p id="resource-dialog-eyebrow" class="eyebrow">Deployment resource</p><h2 id="resource-dialog-title">Configure resource</h2></div>
        <button id="close-resource-dialog" class="icon-action" type="button" aria-label="Close">×</button>
      </header>
      <div id="resource-dialog-body" class="resource-dialog-body"></div>
      <p id="resource-dialog-error" class="form-error" role="alert" hidden></p>
      <footer id="resource-dialog-actions" class="dialog-actions">
        <button id="cancel-resource-dialog" class="quiet-action" type="button">Cancel</button>
        <button id="submit-resource-dialog" class="primary-action" type="submit">Save</button>
      </footer>
    </form>
  </dialog>
);

const ConfirmationDialog: FC = () => (
  <dialog id="confirm-dialog" class="send-dialog confirm-dialog" aria-labelledby="confirm-dialog-title">
    <form id="confirm-form">
      <header class="dialog-heading">
        <div><p id="confirm-dialog-eyebrow" class="eyebrow">Explicit confirmation</p><h2 id="confirm-dialog-title">Confirm operation</h2></div>
        <button id="close-confirm-dialog" class="icon-action" type="button" aria-label="Close">×</button>
      </header>
      <div class="confirm-copy">
        <p id="confirm-dialog-copy"></p>
        <label id="confirm-input-label" for="confirm-input">Type the requested value to continue</label>
        <input id="confirm-input" name="confirmation" type="text" autocomplete="off" spellcheck={false} required />
      </div>
      <p id="confirm-dialog-error" class="form-error" role="alert" hidden></p>
      <footer class="dialog-actions">
        <button id="cancel-confirm-dialog" class="quiet-action" type="button">Cancel</button>
        <button id="submit-confirm-dialog" class="danger-action" type="submit">Confirm</button>
      </footer>
    </form>
  </dialog>
);

const OperatorConsoleDocument: FC<OperatorConsoleViewOptions> = ({ betterAuthEnabled }) => (
  <html lang="en" data-console-auth={betterAuthEnabled ? "better-auth" : "api-key"}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light" />
      <meta name="robots" content="noindex, nofollow" />
      <title>Operator Console · HayaSend</title>
      <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23171917'/%3E%3Ctext x='16' y='23' text-anchor='middle' font-family='Georgia' font-size='22' font-style='italic' fill='%23fffaf2'%3EH%3C/text%3E%3C/svg%3E" />
      <link rel="stylesheet" href="/console/app.css" />
      <script defer src="/console/app.js"></script>
    </head>
    <body>
      <a class="skip-link" href="#workspace-main">Skip to workspace</a>
      <AuthScreen betterAuthEnabled={betterAuthEnabled} />
      <div id="console-shell" class="console-shell" hidden>
        <Topbar />
        <div class="app-grid"><Navigation /><Workspace /></div>
      </div>
      <SendDialog />
      <ResourceDialog />
      <ConfirmationDialog />
      <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
    </body>
  </html>
);

export function renderOperatorConsole(options: OperatorConsoleViewOptions) {
  const rendered = (<OperatorConsoleDocument {...options} />).toString();
  if (typeof rendered !== "string") {
    throw new Error("The operator console must render synchronously.");
  }
  return `<!doctype html>${rendered}`;
}
