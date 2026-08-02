export const OPERATOR_CONSOLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="robots" content="noindex, nofollow">
    <title>Operator Console · HayaSend</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23171917'/%3E%3Ctext x='16' y='23' text-anchor='middle' font-family='Georgia' font-size='22' font-style='italic' fill='%23fffaf2'%3EH%3C/text%3E%3C/svg%3E">
    <link rel="stylesheet" href="/console/app.css">
    <script defer src="/console/app.js"></script>
  </head>
  <body>
    <a class="skip-link" href="#workspace-main">Skip to workspace</a>

    <section id="auth-screen" class="auth-screen" aria-labelledby="auth-title">
      <div class="auth-brand" aria-label="HayaSend">
        <span class="brand-mark" aria-hidden="true">H</span>
        <span>HayaSend</span>
      </div>
      <div class="auth-panel">
        <p class="eyebrow">Deployment-local console</p>
        <h1 id="auth-title">Operate the mail you own.</h1>
        <p class="auth-copy">Connect with a scoped HayaSend API key. The key stays in this browser tab and is sent only to this deployment.</p>
        <form id="auth-form" class="auth-form">
          <label for="api-key">API key</label>
          <div class="secret-field">
            <input id="api-key" name="api-key" type="password" autocomplete="current-password" spellcheck="false" required placeholder="re_hs_key_…">
            <button id="toggle-secret" class="field-action" type="button" aria-label="Show API key">Show</button>
          </div>
          <button id="connect" class="primary-action" type="submit">Connect to this deployment</button>
          <p id="auth-error" class="form-error" role="alert" hidden></p>
        </form>
        <div class="auth-boundary">
          <span class="boundary-dot" aria-hidden="true"></span>
          <span id="deployment-origin">Same-origin connection</span>
        </div>
      </div>
      <p class="auth-foot">No Haya-managed message store · No analytics · No cloud credentials</p>
    </section>

    <div id="console-shell" class="console-shell" hidden>
      <header class="topbar">
        <a class="brand" href="/console" aria-label="HayaSend Operator Console">
          <span class="brand-mark" aria-hidden="true">H</span>
          <span>HayaSend</span>
        </a>
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
          <button id="sign-out" type="button">Disconnect</button>
        </div>
      </header>

      <div class="app-grid">
        <nav class="side-nav" aria-label="Console navigation">
          <div class="nav-primary">
            <button class="nav-item is-active" type="button" data-view="overview" aria-label="Overview" aria-current="page">
              <span class="nav-glyph" aria-hidden="true">⌁</span><span>Overview</span>
            </button>
            <button class="nav-item" type="button" data-view="emails" aria-label="Emails">
              <span class="nav-glyph" aria-hidden="true">↗</span><span>Emails</span>
              <span id="nav-email-count" class="nav-count"></span>
            </button>
            <button class="nav-item" type="button" data-view="received" aria-label="Received emails">
              <span class="nav-glyph" aria-hidden="true">↙</span><span>Received</span>
            </button>
            <button class="nav-item" type="button" data-view="templates" aria-label="Templates">
              <span class="nav-glyph" aria-hidden="true">◇</span><span>Templates</span>
            </button>
            <button class="nav-item" type="button" data-view="domains" aria-label="Domains">
              <span class="nav-glyph" aria-hidden="true">◎</span><span>Domains</span>
            </button>
            <button class="nav-item" type="button" data-view="webhooks" aria-label="Webhooks">
              <span class="nav-glyph" aria-hidden="true">⌘</span><span>Webhooks</span>
            </button>
            <button class="nav-item" type="button" data-view="suppressions" aria-label="Suppressions">
              <span class="nav-glyph" aria-hidden="true">⊘</span><span>Suppressions</span>
            </button>
            <button class="nav-item" type="button" data-view="api-keys" aria-label="API keys">
              <span class="nav-glyph" aria-hidden="true">⌁</span><span>API keys</span>
            </button>
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

        <main id="workspace-main" class="workspace-main" tabindex="-1">
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
      </div>
    </div>

    <dialog id="send-dialog" class="send-dialog" aria-labelledby="send-title">
      <form id="send-form" method="dialog">
        <header class="dialog-heading">
          <div>
            <p class="eyebrow">Scoped test send</p>
            <h2 id="send-title">Send one transactional email</h2>
          </div>
          <button id="close-send" class="icon-action" type="button" aria-label="Close">×</button>
        </header>
        <div class="dialog-grid">
          <label>From <input name="from" type="text" autocomplete="off" placeholder="HayaSend &lt;hello@example.com&gt;"></label>
          <label>To <input name="to" type="email" autocomplete="off" required placeholder="recipient@example.com"></label>
          <label class="wide">Subject <input name="subject" type="text" required maxlength="998" placeholder="Delivery verification"></label>
          <label class="wide">HTML <textarea name="html" rows="7" placeholder="&lt;h1&gt;Hello&lt;/h1&gt;"></textarea></label>
          <label class="wide">Plain text <textarea name="text" rows="5" placeholder="Hello"></textarea></label>
        </div>
        <p class="dialog-note">A fresh idempotency key is attached. HayaSend still applies all recipient, budget, and provider policies.</p>
        <p id="send-error" class="form-error" role="alert" hidden></p>
        <footer class="dialog-actions">
          <button id="cancel-send" class="quiet-action" type="button">Cancel</button>
          <button id="submit-send" class="primary-action" type="submit">Send email</button>
        </footer>
      </form>
    </dialog>

    <dialog id="resource-dialog" class="send-dialog resource-dialog" aria-labelledby="resource-dialog-title">
      <form id="resource-form">
        <header class="dialog-heading">
          <div>
            <p id="resource-dialog-eyebrow" class="eyebrow">Deployment resource</p>
            <h2 id="resource-dialog-title">Configure resource</h2>
          </div>
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

    <dialog id="confirm-dialog" class="send-dialog confirm-dialog" aria-labelledby="confirm-dialog-title">
      <form id="confirm-form">
        <header class="dialog-heading">
          <div>
            <p id="confirm-dialog-eyebrow" class="eyebrow">Explicit confirmation</p>
            <h2 id="confirm-dialog-title">Confirm operation</h2>
          </div>
          <button id="close-confirm-dialog" class="icon-action" type="button" aria-label="Close">×</button>
        </header>
        <div class="confirm-copy">
          <p id="confirm-dialog-copy"></p>
          <label id="confirm-input-label" for="confirm-input">Type the requested value to continue</label>
          <input id="confirm-input" name="confirmation" type="text" autocomplete="off" spellcheck="false" required>
        </div>
        <p id="confirm-dialog-error" class="form-error" role="alert" hidden></p>
        <footer class="dialog-actions">
          <button id="cancel-confirm-dialog" class="quiet-action" type="button">Cancel</button>
          <button id="submit-confirm-dialog" class="danger-action" type="submit">Confirm</button>
        </footer>
      </form>
    </dialog>

    <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  </body>
</html>`;

export const OPERATOR_CONSOLE_PREVIEW_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>HayaSend email preview</title>
    <script defer src="/console/preview.js"></script>
  </head>
  <body></body>
</html>`;

export const OPERATOR_CONSOLE_PREVIEW_JS = String.raw`
(() => {
  "use strict";

  const MESSAGE_TYPE = "hayasend.operator-console.preview.v1";
  const MAX_MARKUP_BYTES = 2_000_000;

  function sanitize(markup) {
    const parsed = new DOMParser().parseFromString(String(markup || ""), "text/html");
    parsed.querySelectorAll("script, iframe, object, embed, form, base, link, meta[http-equiv]").forEach((element) => element.remove());
    parsed.querySelectorAll("*").forEach((element) => {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith("on") || name === "srcset" || name === "ping" || name === "target") element.removeAttribute(attribute.name);
        if ((name === "src" || name === "href") && !(value.startsWith("data:") || value.startsWith("cid:") || value.startsWith("#"))) element.removeAttribute(attribute.name);
      }
    });
    return parsed;
  }

  function render(markup) {
    const parsed = sanitize(markup);
    document.head.querySelectorAll("style[data-email-preview-style]").forEach((element) => element.remove());
    parsed.head.querySelectorAll("style").forEach((source) => {
      const style = document.createElement("style");
      style.dataset.emailPreviewStyle = "";
      style.textContent = source.textContent;
      document.head.append(style);
    });
    document.body.replaceChildren(...[...parsed.body.childNodes].map((node) => document.importNode(node, true)));
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== MESSAGE_TYPE || typeof data.markup !== "string" || data.markup.length > MAX_MARKUP_BYTES) return;
    render(data.markup);
  });
})();
`;

export const OPERATOR_CONSOLE_CSS = String.raw`
:root {
  --paper: #f2eee6;
  --paper-deep: #e8e1d6;
  --canvas: #fbfaf6;
  --ink: #171917;
  --muted: #72756d;
  --faint: #989b93;
  --line: rgba(23, 25, 23, 0.12);
  --line-strong: rgba(23, 25, 23, 0.23);
  --accent: #d65f2b;
  --accent-dark: #a9411c;
  --accent-soft: #f2d7c8;
  --success: #257455;
  --warning: #9a651d;
  --danger: #a13c30;
  --topbar: 62px;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--paper);
  font-synthesis: none;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { min-width: 320px; min-height: 100%; margin: 0; }
body { background: var(--paper); }
button, input, textarea, select { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.skip-link {
  position: fixed;
  z-index: 100;
  top: 8px;
  left: 8px;
  padding: 10px 14px;
  color: white;
  background: var(--ink);
  transform: translateY(-150%);
}
.skip-link:focus { transform: none; }

.brand, .auth-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--ink);
  text-decoration: none;
  font-size: 15px;
  font-weight: 720;
  letter-spacing: -0.02em;
}
.brand-mark {
  display: grid;
  width: 29px;
  height: 29px;
  place-items: center;
  border-radius: 7px;
  color: #fffaf2;
  background: var(--ink);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 18px;
  font-style: italic;
}
.eyebrow {
  margin: 0 0 8px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.auth-screen {
  min-height: 100svh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  padding: 28px 34px 24px;
  background:
    linear-gradient(90deg, transparent 0 68%, rgba(23, 25, 23, 0.05) 68% 68.08%, transparent 68.08%),
    linear-gradient(var(--paper), var(--paper-deep));
}
.auth-brand { align-self: start; }
.auth-panel {
  width: min(100%, 520px);
  align-self: center;
  margin-left: clamp(0px, 11vw, 180px);
  padding: 34px 0 30px;
  border-top: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-strong);
  animation: rise-in 480ms cubic-bezier(.22, 1, .36, 1) both;
}
.auth-panel h1 {
  max-width: 480px;
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(42px, 6vw, 72px);
  font-weight: 400;
  line-height: .97;
  letter-spacing: -.055em;
}
.auth-copy {
  max-width: 440px;
  margin: 23px 0 30px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.65;
}
.auth-form { display: grid; gap: 12px; }
.auth-form > label, .dialog-grid label {
  color: var(--ink);
  font-size: 11px;
  font-weight: 680;
  letter-spacing: .025em;
}
.secret-field { position: relative; }
.secret-field input { padding-right: 70px; }
input, textarea, select {
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--ink);
  background: rgba(255,255,255,.56);
  transition: border-color 140ms ease, background 140ms ease;
}
input { min-height: 44px; padding: 0 12px; }
select { min-height: 44px; padding: 0 12px; }
textarea { padding: 11px 12px; resize: vertical; line-height: 1.5; }
input:focus, textarea:focus { border-color: var(--accent); background: var(--canvas); }
.field-action {
  position: absolute;
  top: 50%;
  right: 8px;
  border: 0;
  color: var(--muted);
  background: transparent;
  transform: translateY(-50%);
  cursor: pointer;
  font-size: 11px;
}
.primary-action, .quiet-action, .danger-action, .icon-action {
  min-height: 42px;
  border-radius: 8px;
  padding: 0 16px;
  cursor: pointer;
  transition: transform 140ms ease, background 140ms ease, opacity 140ms ease;
}
.primary-action {
  border: 1px solid var(--ink);
  color: #fffaf2;
  background: var(--ink);
  font-size: 12px;
  font-weight: 680;
}
.primary-action:hover { background: #2a2d29; transform: translateY(-1px); }
.primary-action:disabled { opacity: .45; cursor: wait; transform: none; }
.primary-action.compact { min-height: 34px; padding: 0 13px; }
.quiet-action {
  border: 1px solid var(--line-strong);
  color: var(--ink);
  background: transparent;
  font-size: 12px;
}
.quiet-action:hover { background: rgba(255,255,255,.45); }
.danger-action {
  min-height: 42px;
  padding: 0 16px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  color: white;
  background: var(--danger);
  cursor: pointer;
  font-size: 12px;
  font-weight: 680;
}
.danger-action:hover { background: #812f27; }
.danger-action:disabled { opacity: .42; cursor: not-allowed; }
.icon-action { width: 36px; min-height: 36px; padding: 0; border: 0; background: transparent; font-size: 24px; }
.form-error { margin: 0; color: var(--danger); font-size: 12px; line-height: 1.45; }
.auth-boundary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 17px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
}
.boundary-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.auth-foot { align-self: end; margin: 0; color: var(--faint); font-size: 10px; letter-spacing: .04em; }

.console-shell { min-height: 100svh; }
.topbar {
  position: sticky;
  z-index: 20;
  top: 0;
  height: var(--topbar);
  display: grid;
  grid-template-columns: 220px 1fr auto;
  align-items: center;
  padding: 0 18px 0 21px;
  border-bottom: 1px solid var(--line-strong);
  background: color-mix(in srgb, var(--paper) 93%, transparent);
  backdrop-filter: blur(14px);
}
.deployment-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  justify-self: start;
}
.health-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.health-dot.is-ok { background: var(--success); box-shadow: 0 0 0 0 rgba(37,116,85,.32); animation: health-pulse 2.5s ease-out infinite; }
.health-dot.is-error { background: var(--danger); }
.topbar-actions { display: flex; align-items: center; gap: 8px; }
.account-button {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 9px 3px 4px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--ink);
  background: transparent;
  cursor: pointer;
  font-size: 11px;
}
.account-button:hover { border-color: var(--line); background: rgba(255,255,255,.4); }
#account-initial { display: grid; width: 27px; height: 27px; place-items: center; border-radius: 7px; color: white; background: var(--accent); font-weight: 700; }
.account-popover {
  position: fixed;
  z-index: 30;
  top: 55px;
  right: 18px;
  width: 240px;
  padding: 14px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--canvas);
  box-shadow: 0 18px 60px rgba(23,25,23,.16);
}
.account-popover p { margin: 0 0 12px; color: var(--muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.account-popover button { width: 100%; min-height: 34px; border: 1px solid var(--line); border-radius: 7px; background: transparent; cursor: pointer; }

.app-grid { min-height: calc(100svh - var(--topbar)); display: grid; grid-template-columns: 220px minmax(0,1fr); }
.side-nav {
  position: sticky;
  top: var(--topbar);
  height: calc(100svh - var(--topbar));
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 20px 12px 14px;
  border-right: 1px solid var(--line);
}
.nav-primary, .nav-secondary { display: grid; gap: 3px; }
.nav-item {
  min-height: 38px;
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  color: var(--muted);
  background: transparent;
  text-decoration: none;
  text-align: left;
  cursor: pointer;
  font-size: 12px;
}
.nav-item:hover { color: var(--ink); background: rgba(255,255,255,.36); }
.nav-item.is-active { color: var(--ink); background: var(--canvas); font-weight: 680; }
.nav-glyph { color: var(--faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; text-align: center; }
.nav-count { color: var(--faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; }

.workspace-main { min-width: 0; padding: 34px clamp(24px,4vw,64px) 70px; }
.view-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--line-strong);
}
.view-heading h1 { margin: 0; font-family: Georgia,"Times New Roman",serif; font-size: clamp(28px,3vw,40px); font-weight: 400; letter-spacing: -.04em; }
.view-description { max-width: 620px; margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
.freshness { color: var(--faint); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 9px; white-space: nowrap; }
.view-body { min-height: 500px; animation: view-in 240ms ease both; }

.metrics-strip { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border-bottom: 1px solid var(--line-strong); }
.metric { min-height: 132px; padding: 25px 20px 20px 0; border-right: 1px solid var(--line); }
.metric:not(:first-child) { padding-left: 20px; }
.metric:last-child { border-right: 0; }
.metric-label { margin: 0; color: var(--muted); font-size: 11px; }
.metric-value { margin: 18px 0 4px; font-family: Georgia,"Times New Roman",serif; font-size: 36px; line-height: 1; letter-spacing: -.04em; }
.metric-note { margin: 0; color: var(--faint); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 9px; }
.status-layout { display: grid; grid-template-columns: minmax(0,1.25fr) minmax(280px,.75fr); gap: 42px; padding-top: 34px; }
.section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 16px; }
.section-heading h2 { margin: 0; font-size: 14px; letter-spacing: -.015em; }
.section-heading p { margin: 0; color: var(--faint); font-size: 10px; }
.signal-list { border-top: 1px solid var(--line-strong); }
.signal-row { display: grid; grid-template-columns: minmax(120px,1fr) auto; align-items: center; gap: 18px; min-height: 54px; border-bottom: 1px solid var(--line); }
.signal-main { min-width: 0; }
.signal-title { margin: 0; font-size: 12px; font-weight: 650; }
.signal-detail { margin: 4px 0 0; color: var(--faint); font-size: 10px; overflow-wrap: anywhere; }
.signal-value { color: var(--muted); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 10px; text-align: right; }
.status-pill { display: inline-flex; align-items: center; min-height: 23px; padding: 0 8px; border-radius: 999px; color: var(--muted); background: rgba(23,25,23,.06); font-size: 9px; font-weight: 690; text-transform: uppercase; letter-spacing: .055em; }
.status-pill[data-tone="success"] { color: var(--success); background: rgba(37,116,85,.10); }
.status-pill[data-tone="warning"] { color: var(--warning); background: rgba(154,101,29,.11); }
.status-pill[data-tone="danger"] { color: var(--danger); background: rgba(161,60,48,.10); }

.toolbar { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--line); }
.search-field { position: relative; width: min(100%,380px); }
.search-field input { min-height: 37px; padding-left: 34px; border-color: var(--line); background: rgba(255,255,255,.36); }
.search-field span { position: absolute; top: 50%; left: 12px; color: var(--faint); transform: translateY(-50%); }
.toolbar-meta { color: var(--faint); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 9px; }
.email-workspace { min-height: 610px; display: grid; grid-template-columns: minmax(270px,36%) minmax(0,64%); border-bottom: 1px solid var(--line-strong); }
.email-list { max-height: 720px; overflow: auto; border-right: 1px solid var(--line-strong); }
.email-row { position: relative; width: 100%; display: grid; gap: 7px; padding: 16px 17px; border: 0; border-bottom: 1px solid var(--line); color: var(--ink); background: transparent; text-align: left; cursor: pointer; transition: background 150ms ease; }
.email-row:hover { background: rgba(255,255,255,.34); }
.email-row.is-selected { background: var(--canvas); }
.email-row-head, .email-row-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.email-subject { overflow: hidden; font-size: 12px; font-weight: 670; text-overflow: ellipsis; white-space: nowrap; }
.email-time { flex: 0 0 auto; color: var(--faint); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 8px; }
.email-route { overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.email-detail { min-width: 0; background: var(--canvas); }
.detail-empty { min-height: 610px; display: grid; place-content: center; justify-items: start; padding: 48px; }
.detail-empty h2 { max-width: 390px; margin: 0 0 10px; font-family: Georgia,"Times New Roman",serif; font-size: 31px; font-weight: 400; letter-spacing: -.035em; }
.detail-empty p { max-width: 390px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.message-head { padding: 26px 28px 20px; border-bottom: 1px solid var(--line); }
.message-head-line { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.message-head h2 { margin: 13px 0 7px; font-family: Georgia,"Times New Roman",serif; font-size: 27px; font-weight: 400; letter-spacing: -.035em; }
.message-route-detail { margin: 0; color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.copy-link { border: 0; color: var(--muted); background: transparent; cursor: pointer; font-size: 10px; }
.detail-tabs { min-height: 44px; display: flex; align-items: center; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--line); }
.detail-tab { min-height: 30px; padding: 0 10px; border: 0; border-radius: 6px; color: var(--muted); background: transparent; cursor: pointer; font-size: 10px; }
.detail-tab.is-active { color: var(--ink); background: var(--paper); font-weight: 680; }
.preview-frame { width: 100%; height: 330px; border: 0; background: white; }
.text-preview { height: 330px; margin: 0; padding: 22px; overflow: auto; color: var(--ink); background: white; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 10px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.detail-lower { display: grid; grid-template-columns: minmax(0,1fr) minmax(220px,.8fr); border-top: 1px solid var(--line); }
.detail-panel { padding: 22px 26px 28px; }
.detail-panel + .detail-panel { border-left: 1px solid var(--line); }
.detail-panel h3 { margin: 0 0 14px; font-size: 11px; }
.fact-list { margin: 0; }
.fact-list div { display: grid; grid-template-columns: 92px minmax(0,1fr); gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); }
.fact-list dt { color: var(--faint); font-size: 9px; }
.fact-list dd { margin: 0; color: var(--muted); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 9px; overflow-wrap: anywhere; }
.recipient-list { border-top: 1px solid var(--line); }
.recipient-row { display: grid; grid-template-columns: 42px 1fr auto; align-items: center; gap: 9px; min-height: 45px; border-bottom: 1px solid var(--line); }
.recipient-index { color: var(--faint); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 9px; }
.recipient-state { font-size: 10px; }
.recipient-attempt { color: var(--faint); font-size: 8px; text-align: right; }

.resource-table-scroll { width: 100%; overflow-x: auto; overscroll-behavior-inline: contain; }
.resource-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.resource-table th { padding: 13px 10px; border-bottom: 1px solid var(--line-strong); color: var(--faint); font-size: 9px; font-weight: 600; letter-spacing: .06em; text-align: left; text-transform: uppercase; }
.resource-table td { padding: 16px 10px; border-bottom: 1px solid var(--line); color: var(--muted); vertical-align: top; overflow-wrap: anywhere; }
.resource-table td:first-child { color: var(--ink); font-weight: 640; }
.resource-table code { font-size: 9px; }
.resource-table tr.is-actionable { cursor: pointer; }
.resource-table tr.is-actionable:hover td { background: rgba(255,255,255,.35); }
.resource-table .column-state { width: 84px; min-width: 84px; white-space: nowrap; }
.resource-table .column-actions { width: 88px; min-width: 88px; white-space: nowrap; }
.resource-table .row-actions { display: flex; flex-wrap: nowrap; gap: 6px; }
.table-action { min-height: 29px; padding: 0 9px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: transparent; cursor: pointer; font-size: 9px; }
.table-action:hover { border-color: var(--line-strong); background: var(--canvas); }
.table-action.danger { color: var(--danger); }
.resource-toolbar { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); }
.resource-toolbar-copy { margin: 0; color: var(--muted); font-size: 10px; line-height: 1.5; }
.resource-toolbar-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.resource-detail-layout { display: grid; grid-template-columns: minmax(250px,.72fr) minmax(0,1.28fr); min-height: 600px; border-bottom: 1px solid var(--line-strong); }
.resource-list-panel { border-right: 1px solid var(--line-strong); overflow: auto; }
.resource-list-button { width: 100%; display: grid; gap: 7px; padding: 16px 17px; border: 0; border-bottom: 1px solid var(--line); color: var(--ink); background: transparent; text-align: left; cursor: pointer; }
.resource-list-button:hover, .resource-list-button.is-selected { background: var(--canvas); }
.resource-list-title { display: flex; justify-content: space-between; gap: 12px; align-items: center; font-size: 11px; font-weight: 680; }
.resource-list-meta { color: var(--faint); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 9px; overflow-wrap: anywhere; }
.resource-detail { min-width: 0; }
.resource-detail-head { display: flex; justify-content: space-between; gap: 18px; padding: 24px 26px 20px; border-bottom: 1px solid var(--line); }
.resource-detail-head h2 { margin: 7px 0 5px; font-family: Georgia,"Times New Roman",serif; font-size: 27px; font-weight: 400; letter-spacing: -.035em; }
.resource-detail-actions { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: flex-end; gap: 7px; }
.resource-detail-section { padding: 22px 26px; border-bottom: 1px solid var(--line); }
.resource-detail-section h3 { margin: 0 0 14px; font-size: 11px; }
.resource-detail-section > p { color: var(--muted); font-size: 10px; line-height: 1.55; }
.dns-records, .delivery-list, .attachment-list { display: grid; gap: 8px; }
.record-card, .delivery-card, .attachment-card { display: grid; grid-template-columns: minmax(100px,.45fr) minmax(0,1.55fr) auto; align-items: center; gap: 12px; padding: 11px 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 9px; }
.record-card code, .delivery-card code { overflow-wrap: anywhere; white-space: pre-wrap; }
.code-editor { min-height: 260px; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 11px; tab-size: 2; }
.template-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 12px; }
.template-editor-grid label, .resource-field { display: grid; gap: 7px; color: var(--ink); font-size: 11px; font-weight: 680; }
.template-editor-grid .wide, .resource-field.wide { grid-column: 1 / -1; }
.template-preview { height: 390px; border-top: 1px solid var(--line); }
.variables-editor { min-height: 110px; }
.checkbox-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px 12px; padding: 5px 0; }
.checkbox-item { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 10px; font-weight: 500; }
.checkbox-item input { width: 16px; min-height: 16px; margin: 0; accent-color: var(--accent); }
.secret-output { display: grid; gap: 11px; padding: 18px; border: 1px solid var(--line-strong); border-radius: 9px; background: var(--paper); }
.secret-output code { padding: 12px; overflow-wrap: anywhere; color: var(--ink); background: white; font-size: 10px; line-height: 1.5; user-select: all; }
.secret-warning { margin: 0; color: var(--danger); font-size: 10px; line-height: 1.5; }
.empty-resource, .permission-state, .loading-state, .error-state { min-height: 390px; display: grid; place-content: center; justify-items: start; padding: 54px 0; }
.empty-resource h2, .permission-state h2, .error-state h2 { margin: 0 0 8px; font-family: Georgia,"Times New Roman",serif; font-size: 29px; font-weight: 400; letter-spacing: -.035em; }
.empty-resource p, .permission-state p, .error-state p { max-width: 520px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.loading-line { width: min(520px,70vw); height: 1px; overflow: hidden; background: var(--line); }
.loading-line::after { display: block; width: 34%; height: 100%; background: var(--accent); animation: loading 1.1s ease-in-out infinite; content: ""; }

.operations-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(260px,.72fr); gap: 42px; padding-top: 32px; }
.operation-step { display: grid; grid-template-columns: 34px minmax(0,1fr) auto; gap: 14px; align-items: start; padding: 18px 0; border-top: 1px solid var(--line); }
.step-number { color: var(--faint); font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 9px; }
.operation-step h3 { margin: 0 0 5px; font-size: 12px; }
.operation-step p { margin: 0; color: var(--muted); font-size: 10px; line-height: 1.5; }
.text-link { color: var(--accent-dark); font-size: 10px; text-decoration: none; }
.text-link:hover { text-decoration: underline; }

.send-dialog { width: min(760px,calc(100vw - 30px)); max-height: calc(100svh - 30px); padding: 0; border: 1px solid var(--line-strong); border-radius: 12px; color: var(--ink); background: var(--canvas); box-shadow: 0 28px 100px rgba(23,25,23,.26); }
.send-dialog::backdrop { background: rgba(23,25,23,.38); backdrop-filter: blur(4px); }
.send-dialog form { padding: 25px 27px 22px; }
.resource-dialog-body { max-height: calc(100svh - 220px); padding: 20px 0 15px; overflow: auto; }
.resource-dialog .resource-field + .resource-field { margin-top: 14px; }
.resource-dialog .resource-field textarea { min-height: 100px; }
.confirm-dialog { width: min(560px,calc(100vw - 30px)); }
.confirm-copy { display: grid; gap: 13px; padding: 20px 0; }
.confirm-copy p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.confirm-copy label { color: var(--ink); font-size: 11px; font-weight: 680; }
.dialog-heading { display: flex; align-items: start; justify-content: space-between; gap: 20px; padding-bottom: 19px; border-bottom: 1px solid var(--line); }
.dialog-heading h2 { margin: 0; font-family: Georgia,"Times New Roman",serif; font-size: 30px; font-weight: 400; letter-spacing: -.035em; }
.dialog-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px 12px; padding: 20px 0 14px; }
.dialog-grid label { display: grid; gap: 7px; }
.dialog-grid .wide { grid-column: 1 / -1; }
.dialog-note { margin: 0 0 12px; color: var(--faint); font-size: 10px; line-height: 1.5; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 18px; border-top: 1px solid var(--line); }
.toast { position: fixed; z-index: 60; right: 20px; bottom: 20px; max-width: min(380px,calc(100vw - 40px)); padding: 13px 16px; border-radius: 8px; color: #fffaf2; background: var(--ink); box-shadow: 0 16px 50px rgba(23,25,23,.2); font-size: 11px; animation: toast-in 220ms ease both; }

@keyframes rise-in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
@keyframes view-in { from { opacity: .4; transform: translateY(5px); } to { opacity: 1; transform: none; } }
@keyframes loading { 0% { transform: translateX(-110%); } 55%,100% { transform: translateX(320%); } }
@keyframes health-pulse { 0% { box-shadow: 0 0 0 0 rgba(37,116,85,.3); } 65%,100% { box-shadow: 0 0 0 8px rgba(37,116,85,0); } }
@keyframes toast-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: none; } }

@media (max-width: 980px) {
  .topbar { grid-template-columns: auto 1fr auto; }
  .deployment-state { justify-self: center; }
  #account-name, .topbar .quiet-action { display: none; }
  .app-grid { grid-template-columns: 72px minmax(0,1fr); }
  .side-nav { padding-inline: 8px; }
  .nav-item { grid-template-columns: 1fr; justify-items: center; padding: 0; }
  .nav-item span:not(.nav-glyph) { display: none; }
  .status-layout, .operations-grid { grid-template-columns: 1fr; }
  .resource-detail-layout { grid-template-columns: minmax(220px,.75fr) minmax(0,1.25fr); }
  .email-workspace { grid-template-columns: minmax(235px,35%) minmax(0,65%); }
  .detail-lower { grid-template-columns: 1fr; }
  .detail-panel + .detail-panel { border-top: 1px solid var(--line); border-left: 0; }
}

@media (max-width: 720px) {
  :root { --topbar: 56px; }
  .auth-screen { padding: 20px; background: linear-gradient(var(--paper),var(--paper-deep)); }
  .auth-panel { margin-left: 0; }
  .auth-panel h1 { font-size: 44px; }
  .auth-foot { line-height: 1.45; }
  .topbar { grid-template-columns: auto 1fr auto; padding-inline: 13px; }
  .topbar .brand > span:last-child, .deployment-state { display: none; }
  .app-grid { display: block; }
  .side-nav { position: fixed; z-index: 18; inset: auto 0 0 0; top: auto; width: 100%; height: 68px; flex-direction: row; align-items: center; padding: 5px 8px; border-top: 1px solid var(--line-strong); border-right: 0; background: var(--paper); }
  .nav-primary { width: 100%; grid-template-columns: repeat(5,1fr); }
  .nav-primary .nav-item:nth-child(n+6), .nav-secondary { display: none; }
  .nav-primary .nav-item { min-height: 54px; grid-template-columns: 1fr; grid-template-rows: auto auto; gap: 2px; padding: 5px 2px; font-size: 8px; text-align: center; }
  .nav-primary .nav-item span:nth-child(2) { display: block; }
  .nav-primary .nav-glyph { font-size: 12px; }
  .workspace-main { padding: 25px 17px 96px; }
  .view-heading { align-items: start; }
  .freshness { display: none; }
  .metrics-strip { grid-template-columns: 1fr 1fr; }
  .metric:nth-child(2) { border-right: 0; }
  .metric:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
  .email-workspace { display: block; }
  .email-list { max-height: 330px; border-right: 0; border-bottom: 1px solid var(--line-strong); }
  .detail-empty { min-height: 350px; padding: 32px 22px; }
  .resource-table { min-width: 720px; }
  .resource-detail-layout { display: block; }
  .resource-list-panel { max-height: 280px; border-right: 0; border-bottom: 1px solid var(--line-strong); }
  .resource-detail-head { display: block; padding-inline: 18px; }
  .resource-detail-actions { justify-content: flex-start; margin-top: 14px; }
  .resource-detail-section { padding-inline: 18px; }
  .template-editor-grid, .checkbox-grid { grid-template-columns: 1fr; }
  .template-editor-grid .wide, .resource-field.wide { grid-column: auto; }
  .record-card, .delivery-card, .attachment-card { grid-template-columns: 1fr; }
  .dialog-grid { grid-template-columns: 1fr; }
  .dialog-grid .wide { grid-column: auto; }
  .send-dialog form { padding: 20px 18px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`;

export const OPERATOR_CONSOLE_JS = String.raw`
(() => {
  "use strict";

  const SESSION_KEY = "hayasend.operator-console.api-key.v1";
  const viewMeta = {
    overview: ["Current deployment", "Overview", "Delivery health and recovery signals from this HayaSend deployment."],
    emails: ["Recipient-level truth", "Emails", "Search sent mail, inspect content safely, and follow each recipient to a terminal state."],
    received: ["Inbound mail", "Received", "Inspect mail accepted by this deployment, including bounded content and time-limited attachments."],
    templates: ["Reusable content", "Templates", "Author, render, publish, duplicate, and restore transactional templates with immutable history."],
    domains: ["Sending identity", "Domains", "Domain verification and DNS posture reported by the active transport."],
    webhooks: ["Event delivery", "Webhooks", "Configured endpoints and the events leaving this customer-owned data plane."],
    suppressions: ["Delivery protection", "Suppressions", "Recipients blocked after a complaint, bounce, or explicit operator action."],
    "api-keys": ["Access control", "API keys", "Scoped credentials known to this deployment. Secret tokens are never returned."],
    operations: ["Lifecycle", "Operations", "Move from inspection to the reviewed CLI for plan-first infrastructure changes."],
  };
  const state = {
    token: "",
    principal: null,
    view: "overview",
    health: null,
    diagnostics: null,
    emails: [],
    selectedEmailId: null,
    selectedEmail: null,
    recipients: null,
    resources: new Map(),
    selectedResource: new Map(),
    resourceSubmit: null,
    confirmSubmit: null,
    toastTimer: null,
  };

  const WEBHOOK_EVENTS = ["email.sent", "email.delivered", "email.delivery_delayed", "email.opened", "email.clicked", "email.bounced", "email.complained", "email.failed", "email.scheduled", "email.suppressed", "email.received"];
  const API_SCOPES = ["emails:send", "emails:read", "diagnostics:read", "templates:read", "templates:write", "domains:read", "domains:write", "webhooks:read", "webhooks:write", "suppressions:read", "suppressions:write", "api_keys:read", "api_keys:write"];
  const RESERVED_TEMPLATE_VARIABLES = new Set(["FIRST_NAME", "LAST_NAME", "EMAIL", "UNSUBSCRIBE_URL", "RESEND_UNSUBSCRIBE_URL", "contact", "this"]);

  const byId = (id) => document.getElementById(id);
  const body = byId("view-body");

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  function setText(id, value) {
    const target = byId(id);
    if (target) target.textContent = value == null ? "" : String(value);
  }

  function formatDate(value, includeSeconds) {
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

  function relativeTime(value) {
    const delta = Date.now() - Date.parse(value || "");
    if (!Number.isFinite(delta)) return "—";
    const seconds = Math.max(0, Math.floor(delta / 1000));
    if (seconds < 60) return seconds + "s ago";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  }

  function hasScope(scope) {
    const scopes = state.principal && Array.isArray(state.principal.scopes) ? state.principal.scopes : [];
    return scopes.includes("*") || scopes.includes(scope);
  }

  function statusTone(status) {
    if (["delivered", "opened", "clicked", "verified", "enabled", "production", "succeeded", "ok"].includes(status)) return "success";
    if (["failed", "bounced", "complained", "rejected", "disabled"].includes(status)) return "danger";
    if (["delivery_delayed", "suppressed", "pending", "beta", "experimental", "scheduled"].includes(status)) return "warning";
    return "neutral";
  }

  function pill(value) {
    const span = document.createElement("span");
    span.className = "status-pill";
    span.dataset.tone = statusTone(String(value));
    span.textContent = String(value || "unknown").replaceAll("_", " ");
    return span;
  }

  async function api(path, init = {}) {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Console requests must stay on the deployment origin.");
    const headers = new Headers(init.headers || {});
    headers.set("authorization", "Bearer " + state.token);
    headers.set("accept", "application/json");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...init, headers, credentials: "same-origin", redirect: "error" });
    let payload = null;
    const text = await response.text();
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }
    if (!response.ok) {
      const message = payload && typeof payload.message === "string" ? payload.message : "Request failed with HTTP " + response.status + ".";
      throw new ApiError(response.status, message);
    }
    return payload;
  }

  function showToast(message) {
    const toast = byId("toast");
    toast.textContent = message;
    toast.hidden = false;
    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4200);
  }

  function showLoading() {
    body.replaceChildren();
    const section = document.createElement("section");
    section.className = "loading-state";
    const line = document.createElement("div");
    line.className = "loading-line";
    section.append(line);
    body.append(section);
  }

  function showError(error, retry) {
    body.replaceChildren();
    const section = document.createElement("section");
    section.className = "error-state";
    const title = document.createElement("h2");
    title.textContent = error instanceof ApiError && error.status === 401 ? "This session is no longer valid." : "The console could not load this view.";
    const copy = document.createElement("p");
    copy.textContent = error instanceof Error ? error.message : "An unexpected error occurred.";
    section.append(title, copy);
    if (error instanceof ApiError && error.status === 401) {
      disconnect(false);
      return;
    }
    const button = document.createElement("button");
    button.className = "quiet-action";
    button.type = "button";
    button.textContent = "Try again";
    button.style.marginTop = "18px";
    button.addEventListener("click", retry);
    section.append(button);
    body.append(section);
  }

  function showPermission(scope) {
    body.replaceChildren();
    const section = document.createElement("section");
    section.className = "permission-state";
    const title = document.createElement("h2");
    title.textContent = "This key cannot open this view.";
    const copy = document.createElement("p");
    copy.textContent = "Reconnect with a key containing the " + scope + " scope. HayaSend enforces the same boundary for the API, CLI, and console.";
    section.append(title, copy);
    body.append(section);
  }

  async function connect(token) {
    state.token = token;
    const session = await api("/auth/session");
    if (!session || session.object !== "authenticated_session" || !session.principal) throw new Error("HayaSend returned an invalid console session.");
    state.principal = session.principal;
    sessionStorage.setItem(SESSION_KEY, token);
    byId("auth-screen").hidden = true;
    byId("console-shell").hidden = false;
    const name = state.principal.name || "Operator";
    setText("account-name", name);
    setText("account-initial", name.slice(0, 1).toUpperCase());
    setText("account-detail", name + " · " + state.principal.scopes.join(", "));
    byId("open-send").hidden = !hasScope("emails:send");
    await checkHealth();
    await selectView("overview");
  }

  function disconnect(showMessage = true) {
    sessionStorage.removeItem(SESSION_KEY);
    state.token = "";
    state.principal = null;
    state.resources.clear();
    state.emails = [];
    byId("console-shell").hidden = true;
    byId("auth-screen").hidden = false;
    byId("api-key").value = "";
    byId("account-popover").hidden = true;
    if (showMessage) setText("auth-error", "Disconnected from the deployment.");
    byId("api-key").focus();
  }

  async function checkHealth() {
    try {
      const health = await api("/healthz");
      state.health = health;
      setText("deployment-label", health.service + " " + health.version + " · ready");
      byId("health-dot").className = "health-dot is-ok";
    } catch {
      setText("deployment-label", "Deployment unavailable");
      byId("health-dot").className = "health-dot is-error";
    }
  }

  function setViewHeading(view) {
    const meta = viewMeta[view] || viewMeta.overview;
    setText("view-eyebrow", meta[0]);
    setText("view-title", meta[1]);
    setText("view-description", meta[2]);
    document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
      const selected = item.dataset.view === view;
      item.classList.toggle("is-active", selected);
      if (selected) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
    });
  }

  async function selectView(view) {
    if (!viewMeta[view]) view = "overview";
    state.view = view;
    setViewHeading(view);
    showLoading();
    try {
      if (view === "overview") await renderOverview();
      else if (view === "emails") await renderEmails();
      else if (view === "received") await renderReceived();
      else if (view === "templates") await renderTemplates();
      else if (view === "domains") await renderDomains();
      else if (view === "webhooks") await renderWebhooks();
      else if (view === "suppressions") await renderSuppressions();
      else if (view === "api-keys") await renderApiKeys();
      else if (view === "operations") await renderOperations();
      setText("freshness", "Updated " + new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()));
    } catch (error) {
      showError(error, () => selectView(view));
    }
  }

  function metric(label, value, note) {
    const item = document.createElement("div");
    item.className = "metric";
    const labelNode = document.createElement("p"); labelNode.className = "metric-label"; labelNode.textContent = label;
    const valueNode = document.createElement("p"); valueNode.className = "metric-value"; valueNode.textContent = String(value);
    const noteNode = document.createElement("p"); noteNode.className = "metric-note"; noteNode.textContent = note;
    item.append(labelNode, valueNode, noteNode);
    return item;
  }

  function signal(title, detail, value, status) {
    const row = document.createElement("div"); row.className = "signal-row";
    const main = document.createElement("div"); main.className = "signal-main";
    const heading = document.createElement("p"); heading.className = "signal-title"; heading.textContent = title;
    const copy = document.createElement("p"); copy.className = "signal-detail"; copy.textContent = detail;
    main.append(heading, copy);
    const rendered = status ? pill(value) : document.createElement("span");
    if (!status) { rendered.className = "signal-value"; rendered.textContent = String(value); }
    row.append(main, rendered);
    return row;
  }

  function deadLetterTotal(diagnostics) {
    if (!diagnostics || !diagnostics.queues || !diagnostics.queues.dead_letters) return 0;
    return Object.values(diagnostics.queues.dead_letters).reduce((sum, queue) => sum + (queue && Number(queue.total) || 0), 0);
  }

  async function renderOverview() {
    const tasks = [];
    tasks.push(hasScope("emails:read") ? api("/emails?limit=100&view=summary") : Promise.resolve(null));
    tasks.push(hasScope("diagnostics:read") ? api("/diagnostics/recovery") : Promise.resolve(null));
    const [emailPage, diagnostics] = await Promise.all(tasks);
    state.emails = emailPage && Array.isArray(emailPage.data) ? emailPage.data : [];
    state.diagnostics = diagnostics;
    setText("nav-email-count", state.emails.length || "");
    const delivered = state.emails.filter((email) => ["delivered", "opened", "clicked"].includes(email.status)).length;
    const attention = state.emails.filter((email) => ["failed", "bounced", "complained", "delivery_delayed"].includes(email.status)).length;
    const queues = diagnostics && diagnostics.queues;
    const primaryDepth = queues && queues.primary ? queues.primary.total : "—";
    const dlqDepth = diagnostics ? deadLetterTotal(diagnostics) : "—";

    body.replaceChildren();
    const metrics = document.createElement("section"); metrics.className = "metrics-strip"; metrics.setAttribute("aria-label", "Delivery summary");
    metrics.append(metric("Recent messages", hasScope("emails:read") ? state.emails.length : "—", hasScope("emails:read") ? "latest 100" : "scope unavailable"));
    metrics.append(metric("Delivered", hasScope("emails:read") ? delivered : "—", "terminal or engaged"));
    metrics.append(metric("Needs attention", hasScope("emails:read") ? attention : "—", "recent messages"));
    metrics.append(metric("Queue / DLQ", String(primaryDepth) + " / " + String(dlqDepth), "current depth"));
    body.append(metrics);

    const layout = document.createElement("section"); layout.className = "status-layout";
    const left = document.createElement("div");
    const leftHead = document.createElement("div"); leftHead.className = "section-heading"; leftHead.innerHTML = "<h2>Recovery signals</h2><p>privacy-safe aggregates</p>";
    const signals = document.createElement("div"); signals.className = "signal-list";
    if (diagnostics) {
      signals.append(signal("Primary queue", diagnostics.queues.provider + " wake-up path", diagnostics.queues.primary.total === 0 ? "clear" : diagnostics.queues.primary.total + " pending", true));
      signals.append(signal("Dead letters", "delivery, scheduler, and inbound", deadLetterTotal(diagnostics) === 0 ? "clear" : deadLetterTotal(diagnostics) + " queued", true));
      signals.append(signal("Transactional outbox", diagnostics.outbox.undispatched + " undispatched · " + diagnostics.outbox.stuck_leases + " stuck leases", diagnostics.outbox.due === 0 ? "settled" : diagnostics.outbox.due + " due", true));
      signals.append(signal("Provider events", diagnostics.provider_events.latest_received_at ? "latest " + formatDate(diagnostics.provider_events.latest_received_at, true) : "no terminal event recorded", diagnostics.provider_events.lag_seconds == null ? "—" : diagnostics.provider_events.lag_seconds + "s lag", false));
    } else {
      signals.append(signal("Recovery diagnostics", "Reconnect with diagnostics:read to inspect queues, the outbox, and event lag.", "scope required", true));
    }
    left.append(leftHead, signals);

    const right = document.createElement("div");
    const rightHead = document.createElement("div"); rightHead.className = "section-heading"; rightHead.innerHTML = "<h2>Capability</h2><p>running composition</p>";
    const capabilities = document.createElement("div"); capabilities.className = "signal-list";
    if (diagnostics) {
      const deployment = diagnostics.deployment_capability;
      capabilities.append(signal("Transport", "adapter " + diagnostics.capability.adapter_version, diagnostics.capability.provider, false));
      capabilities.append(signal("Runtime", deployment ? deployment.runtime : (diagnostics.runtime_capability && diagnostics.runtime_capability.runtime) || "not reported", deployment ? deployment.deployment : "current adapter", false));
      capabilities.append(signal("Readiness", deployment ? "combined runtime + transport evidence" : "deployment capability unavailable", deployment ? deployment.maturity : "unknown", true));
    } else {
      capabilities.append(signal("Capability evidence", "Diagnostics access is deliberately separate from message access.", "scope required", true));
    }
    right.append(rightHead, capabilities);
    layout.append(left, right);
    body.append(layout);
  }

  async function loadEmailList(force) {
    if (!force && state.emails.length) return;
    const page = await api("/emails?limit=100&view=summary");
    state.emails = Array.isArray(page.data) ? page.data : [];
    setText("nav-email-count", state.emails.length || "");
  }

  function renderEmailRows(container, query) {
    container.replaceChildren();
    const normalized = query.trim().toLowerCase();
    const records = state.emails.filter((email) => {
      if (!normalized) return true;
      return [email.subject, email.from, ...(email.to || []), email.id, email.status].some((value) => String(value || "").toLowerCase().includes(normalized));
    });
    for (const email of records) {
      const button = document.createElement("button"); button.className = "email-row"; button.type = "button"; button.dataset.emailId = email.id;
      button.setAttribute("role", "option");
      if (state.selectedEmailId === email.id) { button.classList.add("is-selected"); button.setAttribute("aria-selected", "true"); }
      const head = document.createElement("span"); head.className = "email-row-head";
      const subject = document.createElement("span"); subject.className = "email-subject"; subject.textContent = email.subject || "(no subject)";
      const time = document.createElement("time"); time.className = "email-time"; time.textContent = relativeTime(email.created_at);
      head.append(subject, time);
      const foot = document.createElement("span"); foot.className = "email-row-foot";
      const route = document.createElement("span"); route.className = "email-route"; route.textContent = (email.to || []).join(", ") || "No recipient";
      foot.append(route, pill(email.status));
      button.append(head, foot);
      button.addEventListener("click", () => selectEmail(email.id, container, normalized));
      container.append(button);
    }
    if (!records.length) {
      const empty = document.createElement("div"); empty.className = "empty-resource"; empty.style.padding = "32px 18px";
      const title = document.createElement("h2"); title.textContent = normalized ? "No matching email." : "No emails yet.";
      const copy = document.createElement("p"); copy.textContent = normalized ? "Try a recipient, subject, status, or HayaSend message ID." : "Send through the API, an official Resend SDK, or the scoped test-send action.";
      empty.append(title, copy); container.append(empty);
    }
    setText("email-visible-count", records.length + " shown");
  }

  async function renderEmails() {
    if (!hasScope("emails:read")) { showPermission("emails:read"); return; }
    await loadEmailList(false);
    body.replaceChildren();
    const toolbar = document.createElement("div"); toolbar.className = "toolbar";
    const search = document.createElement("label"); search.className = "search-field"; search.innerHTML = "<span aria-hidden=\"true\">⌕</span><input type=\"search\" autocomplete=\"off\" placeholder=\"Search subject, recipient, status, or ID\" aria-label=\"Search emails\">";
    const meta = document.createElement("span"); meta.id = "email-visible-count"; meta.className = "toolbar-meta";
    toolbar.append(search, meta);
    const workspace = document.createElement("section"); workspace.className = "email-workspace";
    const list = document.createElement("div"); list.className = "email-list"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Sent emails");
    const detail = document.createElement("article"); detail.id = "email-detail"; detail.className = "email-detail";
    workspace.append(list, detail); body.append(toolbar, workspace);
    search.querySelector("input").addEventListener("input", (event) => renderEmailRows(list, event.target.value));
    renderEmailRows(list, "");
    if (state.selectedEmailId && state.emails.some((email) => email.id === state.selectedEmailId)) await selectEmail(state.selectedEmailId, list, "");
    else renderEmailEmpty(detail);
  }

  function renderEmailEmpty(container) {
    container.replaceChildren();
    const empty = document.createElement("div"); empty.className = "detail-empty";
    const eye = document.createElement("p"); eye.className = "eyebrow"; eye.textContent = "Message inspector";
    const title = document.createElement("h2"); title.textContent = "Select an email to inspect its delivery truth.";
    const copy = document.createElement("p"); copy.textContent = "Content stays in this deployment. Recipient summaries expose terminal state and recovery attention without duplicating addresses.";
    empty.append(eye, title, copy); container.append(empty);
  }

  async function selectEmail(id, list, query) {
    state.selectedEmailId = id;
    renderEmailRows(list, query);
    const detail = byId("email-detail");
    detail.replaceChildren();
    const loading = document.createElement("div"); loading.className = "loading-state"; loading.innerHTML = "<div class=\"loading-line\"></div>"; detail.append(loading);
    try {
      const [email, recipients] = await Promise.all([api("/emails/" + encodeURIComponent(id)), api("/emails/" + encodeURIComponent(id) + "/recipients?limit=100")]);
      state.selectedEmail = email; state.recipients = recipients;
      renderEmailDetail(detail, email, recipients);
    } catch (error) {
      detail.replaceChildren();
      const failure = document.createElement("div"); failure.className = "error-state";
      const title = document.createElement("h2"); title.textContent = "This email could not be loaded.";
      const copy = document.createElement("p"); copy.textContent = error instanceof Error ? error.message : "Unexpected error.";
      failure.append(title, copy); detail.append(failure);
    }
  }

  function safePreviewDocument(markup) {
    const parsed = new DOMParser().parseFromString(String(markup || ""), "text/html");
    parsed.querySelectorAll("script, iframe, object, embed, form, base, link, meta[http-equiv]").forEach((element) => element.remove());
    parsed.querySelectorAll("*").forEach((element) => {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith("on") || name === "srcset" || name === "ping" || name === "target") element.removeAttribute(attribute.name);
        if ((name === "src" || name === "href") && !(value.startsWith("data:") || value.startsWith("cid:") || value.startsWith("#"))) element.removeAttribute(attribute.name);
      }
    });
    const csp = parsed.createElement("meta");
    csp.setAttribute("http-equiv", "Content-Security-Policy");
    csp.setAttribute("content", "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
    parsed.head.prepend(csp);
    return "<!doctype html>" + parsed.documentElement.outerHTML;
  }

  function createPreviewFrame(markup, title, className = "preview-frame") {
    const frame = document.createElement("iframe");
    frame.className = className;
    frame.title = title;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = "/console/preview";
    const safeMarkup = safePreviewDocument(markup);
    frame.addEventListener("load", () => {
      frame.contentWindow?.postMessage({ type: "hayasend.operator-console.preview.v1", markup: safeMarkup }, "*");
    }, { once: true });
    return frame;
  }

  function fact(label, value) {
    const row = document.createElement("div");
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value == null || value === "" ? "—" : String(value);
    row.append(dt, dd); return row;
  }

  function renderEmailDetail(container, email, recipients) {
    container.replaceChildren();
    const head = document.createElement("header"); head.className = "message-head";
    const line = document.createElement("div"); line.className = "message-head-line"; line.append(pill(recipients.aggregate_status || email.status));
    const copyId = document.createElement("button"); copyId.className = "copy-link"; copyId.type = "button"; copyId.textContent = "Copy message ID";
    copyId.addEventListener("click", async () => { await navigator.clipboard.writeText(email.id); showToast("Message ID copied."); });
    line.append(copyId);
    const title = document.createElement("h2"); title.textContent = email.subject || "(no subject)";
    const route = document.createElement("p"); route.className = "message-route-detail"; route.textContent = email.from + " → " + (email.to || []).join(", ");
    head.append(line, title, route);

    const tabs = document.createElement("div"); tabs.className = "detail-tabs"; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Message representation");
    const views = ["HTML", "Text", "Source"];
    const viewer = document.createElement("div");
    const frame = createPreviewFrame(email.html || "<p>No HTML body.</p>", "Sandboxed email HTML preview");
    const text = document.createElement("pre"); text.className = "text-preview"; text.hidden = true; text.textContent = email.text || "No plain-text body.";
    const source = document.createElement("pre"); source.className = "text-preview"; source.hidden = true; source.textContent = JSON.stringify(email, null, 2);
    viewer.append(frame, text, source);
    views.forEach((name, index) => {
      const button = document.createElement("button"); button.className = "detail-tab" + (index === 0 ? " is-active" : ""); button.type = "button"; button.setAttribute("role", "tab"); button.setAttribute("aria-selected", index === 0 ? "true" : "false"); button.textContent = name;
      button.addEventListener("click", () => {
        tabs.querySelectorAll("button").forEach((candidate) => { candidate.classList.toggle("is-active", candidate === button); candidate.setAttribute("aria-selected", candidate === button ? "true" : "false"); });
        frame.hidden = index !== 0; text.hidden = index !== 1; source.hidden = index !== 2;
      });
      tabs.append(button);
    });

    const lower = document.createElement("div"); lower.className = "detail-lower";
    const factsPanel = document.createElement("section"); factsPanel.className = "detail-panel";
    const factsTitle = document.createElement("h3"); factsTitle.textContent = "Message facts";
    const facts = document.createElement("dl"); facts.className = "fact-list";
    facts.append(fact("Created", formatDate(email.created_at, true)), fact("Last event", email.last_event), fact("Provider ID", email.message_id || email.provider_id), fact("Recipients", recipients.recipient_count), fact("Attachments", (email.attachments || []).length), fact("Message ID", email.id));
    factsPanel.append(factsTitle, facts);
    const recipientPanel = document.createElement("section"); recipientPanel.className = "detail-panel";
    const recipientTitle = document.createElement("h3"); recipientTitle.textContent = "Recipient ledger";
    const recipientList = document.createElement("div"); recipientList.className = "recipient-list";
    for (const recipient of recipients.data || []) {
      const row = document.createElement("div"); row.className = "recipient-row";
      const index = document.createElement("span"); index.className = "recipient-index"; index.textContent = recipient.role + " " + (recipient.ordinal + 1);
      const status = document.createElement("span"); status.className = "recipient-state"; status.append(pill(recipient.status));
      const attempt = document.createElement("span"); attempt.className = "recipient-attempt"; attempt.textContent = recipient.latest_attempt ? "attempt " + recipient.latest_attempt.sequence + " · " + recipient.recovery_state : recipient.recovery_state;
      row.append(index, status, attempt); recipientList.append(row);
    }
    if (!(recipients.data || []).length) { const none = document.createElement("p"); none.className = "signal-detail"; none.textContent = "No recipient summaries available."; recipientList.append(none); }
    recipientPanel.append(recipientTitle, recipientList);
    lower.append(factsPanel, recipientPanel);
    container.append(head, tabs, viewer, lower);
  }

  function actionButton(label, handler, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = options.primary ? "primary-action compact" : "table-action" + (options.danger ? " danger" : "");
    button.textContent = label;
    button.disabled = options.disabled === true;
    button.addEventListener("click", async (event) => { try { await handler(event); } catch (error) { showToast(error instanceof Error ? error.message : "Operation failed."); } });
    return button;
  }

  function resourceToolbar(copy, action) {
    const toolbar = document.createElement("div"); toolbar.className = "resource-toolbar";
    const description = document.createElement("p"); description.className = "resource-toolbar-copy"; description.textContent = copy;
    const actions = document.createElement("div"); actions.className = "resource-toolbar-actions";
    if (action) actions.append(action);
    toolbar.append(description, actions);
    return toolbar;
  }

  function emptyResource(titleText, copyText, action) {
    const empty = document.createElement("section"); empty.className = "empty-resource";
    const title = document.createElement("h2"); title.textContent = titleText;
    const copy = document.createElement("p"); copy.textContent = copyText;
    empty.append(title, copy);
    if (action) { action.style.marginTop = "18px"; empty.append(action); }
    return empty;
  }

  async function loadRows(cache, endpoint, force = false) {
    if (!force && state.resources.has(cache)) return state.resources.get(cache);
    const page = await api(endpoint);
    const rows = Array.isArray(page.data) ? page.data : [];
    state.resources.set(cache, rows);
    return rows;
  }

  function invalidate(cache) {
    state.resources.delete(cache);
  }

  function field(labelText, name, options = {}) {
    const label = document.createElement("label"); label.className = "resource-field" + (options.wide ? " wide" : "");
    label.append(document.createTextNode(labelText));
    const input = options.multiline ? document.createElement("textarea") : document.createElement("input");
    input.name = name;
    if (!options.multiline) input.type = options.type || "text";
    if (options.value != null) input.value = String(options.value);
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.required) input.required = true;
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.rows) input.rows = options.rows;
    if (options.className) input.className = options.className;
    if (options.autocomplete) input.autocomplete = options.autocomplete;
    else input.autocomplete = "off";
    label.append(input);
    return label;
  }

  function checkboxGroup(name, values, selected) {
    const group = document.createElement("div"); group.className = "checkbox-grid";
    values.forEach((value) => {
      const label = document.createElement("label"); label.className = "checkbox-item";
      const input = document.createElement("input"); input.type = "checkbox"; input.name = name; input.value = value; input.checked = selected.includes(value);
      const text = document.createElement("span"); text.textContent = value;
      label.append(input, text); group.append(label);
    });
    return group;
  }

  function openResourceDialog(config) {
    const dialog = byId("resource-dialog");
    setText("resource-dialog-eyebrow", config.eyebrow || "Deployment resource");
    setText("resource-dialog-title", config.title);
    setText("submit-resource-dialog", config.submitLabel || "Save");
    const submit = byId("submit-resource-dialog"); submit.hidden = config.readOnly === true;
    const cancel = byId("cancel-resource-dialog"); cancel.textContent = config.readOnly === true ? "Done" : "Cancel";
    const error = byId("resource-dialog-error"); error.hidden = true;
    const content = byId("resource-dialog-body"); content.replaceChildren();
    config.render(content);
    state.resourceSubmit = config.onSubmit || null;
    if (!dialog.open) dialog.showModal();
  }

  function closeResourceDialog() {
    state.resourceSubmit = null;
    byId("resource-dialog-body").replaceChildren();
    byId("resource-dialog").close();
  }

  function showOneTimeSecret(title, label, secret, note) {
    openResourceDialog({
      eyebrow: "Shown once",
      title,
      readOnly: true,
      render: (content) => {
        const output = document.createElement("div"); output.className = "secret-output";
        const heading = document.createElement("strong"); heading.textContent = label;
        const code = document.createElement("code"); code.textContent = secret;
        const warning = document.createElement("p"); warning.className = "secret-warning"; warning.textContent = note;
        const copy = actionButton("Copy secret", async () => { await navigator.clipboard.writeText(secret); showToast("Secret copied to the clipboard."); });
        output.append(heading, code, warning, copy); content.append(output);
      },
    });
  }

  function confirmOperation(config) {
    setText("confirm-dialog-eyebrow", config.eyebrow || "Explicit confirmation");
    setText("confirm-dialog-title", config.title);
    setText("confirm-dialog-copy", config.copy);
    setText("confirm-input-label", "Type “" + config.expected + "” to continue");
    setText("submit-confirm-dialog", config.submitLabel || "Confirm");
    const input = byId("confirm-input"); input.value = ""; input.placeholder = config.expected;
    byId("confirm-dialog-error").hidden = true;
    state.confirmSubmit = { expected: config.expected, run: config.run };
    byId("confirm-dialog").showModal();
    input.focus();
  }

  function resourceTable(columns, rows) {
    const scroll = document.createElement("div"); scroll.className = "resource-table-scroll"; scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", "Scrollable data table");
    const table = document.createElement("table"); table.className = "resource-table";
    const head = document.createElement("thead"); const headRow = document.createElement("tr");
    columns.forEach((column) => { const th = document.createElement("th"); th.scope = "col"; th.className = "column-" + column.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); th.textContent = column.label; headRow.append(th); });
    head.append(headRow); table.append(head);
    const tableBody = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      columns.forEach((column) => {
        const td = document.createElement("td"); td.className = "column-" + column.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); td.dataset.label = column.label;
        const value = typeof column.value === "function" ? column.value(row) : row[column.value];
        if (column.render) column.render(td, row);
        else if (column.status) td.append(pill(value));
        else td.textContent = value == null || value === "" ? "—" : String(value);
        tr.append(td);
      });
      tableBody.append(tr);
    });
    table.append(tableBody); scroll.append(table); return scroll;
  }

  function parseTemplateVariables(value) {
    let variables;
    try { variables = JSON.parse(String(value || "[]")); }
    catch { throw new Error("Variables must be valid JSON."); }
    if (!Array.isArray(variables) || variables.length > 50) throw new Error("Variables must be a JSON array with at most 50 entries.");
    const keys = new Set();
    variables.forEach((variable) => {
      if (!variable || typeof variable !== "object" || !/^[A-Za-z0-9_]{1,50}$/.test(String(variable.key || "")) || !["string", "number"].includes(variable.type)) throw new Error("Each variable needs a valid key and a string or number type.");
      if (keys.has(variable.key)) throw new Error("Variable keys must be unique.");
      if (RESERVED_TEMPLATE_VARIABLES.has(variable.key)) throw new Error("Template variable " + variable.key + " is reserved.");
      keys.add(variable.key);
      if (variable.fallback_value === "") variable.fallback_value = null;
    });
    return variables.map((variable) => ({ key: variable.key, type: variable.type, fallback_value: variable.fallback_value == null ? null : variable.fallback_value }));
  }

  function templatePayload(form) {
    const data = new FormData(form);
    const reply = String(data.get("reply_to") || "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    return {
      name: String(data.get("name") || "").trim(),
      alias: String(data.get("alias") || "").trim() || null,
      from: String(data.get("from") || "").trim() || null,
      subject: String(data.get("subject") || "").trim() || null,
      reply_to: reply.length ? reply : null,
      html: String(data.get("html") || ""),
      text: String(data.get("text") || "") || null,
      variables: parseTemplateVariables(data.get("variables")),
    };
  }

  function appendTemplateFields(container, template) {
    container.className = "template-editor-grid";
    container.append(field("Name", "name", { required: true, maxLength: 256, value: template && template.name, placeholder: "Welcome email" }));
    container.append(field("Alias", "alias", { value: template && template.alias, placeholder: "welcome" }));
    container.append(field("From", "from", { value: template && template.from, placeholder: "Haya <hello@example.com>" }));
    container.append(field("Subject", "subject", { value: template && template.subject, placeholder: "Welcome, {{{FIRST_NAME}}}" }));
    container.append(field("Reply-to (comma or line separated)", "reply_to", { wide: true, value: template && (template.reply_to || []).join(", "), placeholder: "support@example.com" }));
    container.append(field("HTML", "html", { wide: true, multiline: true, required: true, rows: 16, className: "code-editor", value: template && template.html, placeholder: "<h1>Hello {{{FIRST_NAME}}}</h1>" }));
    container.append(field("Plain text", "text", { wide: true, multiline: true, rows: 7, className: "code-editor", value: template && template.text, placeholder: "Hello {{{FIRST_NAME}}}" }));
    const variables = (template && template.variables || []).map((variable) => ({ key: variable.key, type: variable.type, fallback_value: variable.fallback_value }));
    container.append(field("Variables (JSON)", "variables", { wide: true, multiline: true, rows: 7, className: "code-editor variables-editor", value: JSON.stringify(variables, null, 2), placeholder: "[]" }));
  }

  function openCreateTemplate() {
    openResourceDialog({
      eyebrow: "Reusable content", title: "Create a template draft", submitLabel: "Create template",
      render: (content) => appendTemplateFields(content, null),
      onSubmit: async (form) => { const result = await api("/templates", { method: "POST", body: JSON.stringify(templatePayload(form)) }); invalidate("templates"); state.selectedResource.set("templates", result.id); closeResourceDialog(); showToast("Template draft created."); await renderTemplates(); },
    });
  }

  function defaultRenderVariables(template) {
    const values = {};
    (template.variables || []).forEach((variable) => { values[variable.key] = variable.fallback_value != null ? variable.fallback_value : variable.type === "number" ? 0 : "preview"; });
    return values;
  }

  async function openTemplatePreview(template, version) {
    const previewTemplate = version ? await api("/templates/" + encodeURIComponent(template.id) + "/versions/" + encodeURIComponent(version.id)) : template;
    openResourceDialog({
      eyebrow: version ? "Immutable publication" : "Draft render", title: "Render template", submitLabel: "Render preview",
      render: (content) => content.append(field("Variable values (JSON object)", "variables", { multiline: true, rows: 10, className: "code-editor", value: JSON.stringify(defaultRenderVariables(previewTemplate), null, 2) })),
      onSubmit: async (form) => {
        let variables; try { variables = JSON.parse(String(new FormData(form).get("variables") || "{}")); } catch { throw new Error("Variable values must be valid JSON."); }
        if (!variables || Array.isArray(variables) || typeof variables !== "object") throw new Error("Variable values must be a JSON object.");
        const base = "/templates/" + encodeURIComponent(template.id);
        const endpoint = version ? base + "/versions/" + encodeURIComponent(version.id) + "/render" : base + "/render";
        const rendered = await api(endpoint, { method: "POST", body: JSON.stringify({ variables }) });
        closeResourceDialog();
        openResourceDialog({
          eyebrow: version ? "Rendered publication" : "Rendered draft", title: rendered.subject || template.name, readOnly: true,
          render: (content) => {
            const frame = createPreviewFrame(rendered.html || "<p>No HTML body.</p>", "Sandboxed template preview", "preview-frame template-preview");
            const text = document.createElement("pre"); text.className = "text-preview"; text.textContent = rendered.text || "No plain-text body.";
            content.append(frame, text);
          },
        });
      },
    });
  }

  async function renderTemplateDetail(container, templateSummary) {
    container.replaceChildren();
    const template = await api("/templates/" + encodeURIComponent(templateSummary.id));
    const versionPage = await api("/templates/" + encodeURIComponent(template.id) + "/versions?limit=100");
    const versions = Array.isArray(versionPage.data) ? versionPage.data : [];
    const head = document.createElement("header"); head.className = "resource-detail-head";
    const titleBlock = document.createElement("div"); const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = template.alias || template.id; const title = document.createElement("h2"); title.textContent = template.name; const meta = document.createElement("p"); meta.className = "message-route-detail"; meta.append(pill(template.status)); titleBlock.append(eyebrow, title, meta);
    const actions = document.createElement("div"); actions.className = "resource-detail-actions";
    actions.append(actionButton("Preview", () => openTemplatePreview(template)));
    if (hasScope("templates:write")) {
      actions.append(actionButton("Save draft", () => byId("template-editor-form").requestSubmit(), { primary: true }));
      actions.append(actionButton("Publish", () => confirmOperation({ title: "Publish " + template.name + "?", copy: "The current draft becomes the active immutable sending version. Existing sends that reference this template will use the new publication.", expected: template.name, submitLabel: "Publish template", run: async () => { await api("/templates/" + encodeURIComponent(template.id) + "/publish", { method: "POST", headers: { "if-match": "\"" + template.current_version_id + "\"" } }); invalidate("templates"); showToast("Template published · " + template.name); await renderTemplates(); } })));
      actions.append(actionButton("Duplicate", async () => { const result = await api("/templates/" + encodeURIComponent(template.id) + "/duplicate", { method: "POST" }); invalidate("templates"); state.selectedResource.set("templates", result.id); showToast("Template duplicated."); await renderTemplates(); }));
      actions.append(actionButton("Delete", () => confirmOperation({ title: "Delete " + template.name + "?", copy: "The draft and retained publication history are removed. Sends already accepted by HayaSend are not changed.", expected: template.name, submitLabel: "Delete template", run: async () => { await api("/templates/" + encodeURIComponent(template.id), { method: "DELETE" }); invalidate("templates"); state.selectedResource.delete("templates"); showToast("Template deleted · " + template.name); await renderTemplates(); } }), { danger: true }));
    }
    head.append(titleBlock, actions); container.append(head);

    const section = document.createElement("section"); section.className = "resource-detail-section";
    const form = document.createElement("form"); form.id = "template-editor-form"; appendTemplateFields(form, template);
    form.addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/templates/" + encodeURIComponent(template.id), { method: "PATCH", body: JSON.stringify(templatePayload(form)) }); invalidate("templates"); showToast("Template draft saved."); await renderTemplates(); } catch (error) { showToast(error instanceof Error ? error.message : "Template save failed."); } });
    section.append(form); container.append(section);

    const history = document.createElement("section"); history.className = "resource-detail-section"; const historyTitle = document.createElement("h3"); historyTitle.textContent = "Published history"; history.append(historyTitle);
    const list = document.createElement("div"); list.className = "delivery-list";
    versions.forEach((version) => {
      const row = document.createElement("div"); row.className = "delivery-card";
      const id = document.createElement("code"); id.textContent = version.id;
      const provenance = document.createElement("code"); provenance.textContent = formatDate(version.published_at, true) + " · " + version.actor.name + " · " + version.source;
      const versionActions = document.createElement("div"); versionActions.className = "row-actions"; versionActions.append(actionButton("Preview", () => openTemplatePreview(template, version)));
      if (hasScope("templates:write")) versionActions.append(actionButton("Restore to draft", () => confirmOperation({ title: "Restore this publication to a new draft?", copy: "The active published version will not change. Current unsaved draft fields in this browser are discarded, and a new server draft is created from " + version.id + ".", expected: "RESTORE", submitLabel: "Create restored draft", run: async () => { await api("/templates/" + encodeURIComponent(template.id) + "/versions/" + encodeURIComponent(version.id) + "/restore", { method: "POST", headers: { "if-match": "\"" + template.current_version_id + "\"" } }); invalidate("templates"); showToast("Published version restored to a new draft."); await renderTemplates(); } })));
      row.append(id, provenance, versionActions); list.append(row);
    });
    if (!versions.length) { const copy = document.createElement("p"); copy.textContent = "No immutable publication exists yet."; list.append(copy); }
    history.append(list); container.append(history);
  }

  async function renderTemplates() {
    if (!hasScope("templates:read")) { showPermission("templates:read"); return; }
    const rows = await loadRows("templates", "/templates?limit=100"); body.replaceChildren();
    const create = hasScope("templates:write") ? actionButton("Create template", openCreateTemplate, { primary: true }) : null;
    body.append(resourceToolbar("Draft changes are explicit; publish creates immutable, restorable history.", create));
    if (!rows.length) { body.append(emptyResource("No hosted templates.", "Create a reusable transactional template or keep using inline email bodies.", create ? actionButton("Create first template", openCreateTemplate, { primary: true }) : null)); return; }
    let selected = state.selectedResource.get("templates"); if (!rows.some((row) => row.id === selected)) selected = rows[0].id; state.selectedResource.set("templates", selected);
    const layout = document.createElement("section"); layout.className = "resource-detail-layout"; const list = document.createElement("div"); list.className = "resource-list-panel"; const detail = document.createElement("article"); detail.className = "resource-detail";
    rows.forEach((template) => { const button = document.createElement("button"); button.type = "button"; button.className = "resource-list-button" + (template.id === selected ? " is-selected" : ""); const title = document.createElement("span"); title.className = "resource-list-title"; const name = document.createElement("span"); name.textContent = template.name; title.append(name, pill(template.status)); const meta = document.createElement("span"); meta.className = "resource-list-meta"; meta.textContent = (template.alias || template.id) + " · " + relativeTime(template.updated_at); button.append(title, meta); button.addEventListener("click", async () => { state.selectedResource.set("templates", template.id); await renderTemplates(); }); list.append(button); });
    layout.append(list, detail); body.append(layout); await renderTemplateDetail(detail, rows.find((row) => row.id === selected));
  }

  function renderReceivedDetail(container, email, attachments) {
    container.replaceChildren();
    const head = document.createElement("header"); head.className = "message-head"; const line = document.createElement("div"); line.className = "message-head-line"; line.append(pill("received")); const copy = actionButton("Copy inbound ID", async () => { await navigator.clipboard.writeText(email.id); showToast("Inbound ID copied."); }); line.append(copy); const title = document.createElement("h2"); title.textContent = email.subject || "(no subject)"; const route = document.createElement("p"); route.className = "message-route-detail"; route.textContent = email.from + " → " + (email.received_for || email.to || []).join(", "); head.append(line, title, route);
    const tabs = document.createElement("div"); tabs.className = "detail-tabs"; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Received message representation"); const viewer = document.createElement("div");
    const frame = createPreviewFrame(email.html || "<p>No HTML body.</p>", "Sandboxed received email HTML preview");
    const text = document.createElement("pre"); text.className = "text-preview"; text.hidden = true; text.textContent = email.text || "No plain-text body.";
    const headers = document.createElement("pre"); headers.className = "text-preview"; headers.hidden = true; headers.textContent = JSON.stringify(email.headers || {}, null, 2); viewer.append(frame, text, headers);
    ["HTML", "Text", "Headers"].forEach((name, index) => { const button = document.createElement("button"); button.className = "detail-tab" + (index === 0 ? " is-active" : ""); button.type = "button"; button.setAttribute("role", "tab"); button.setAttribute("aria-selected", index === 0 ? "true" : "false"); button.textContent = name; button.addEventListener("click", () => { tabs.querySelectorAll("button").forEach((candidate) => { candidate.classList.toggle("is-active", candidate === button); candidate.setAttribute("aria-selected", candidate === button ? "true" : "false"); }); frame.hidden = index !== 0; text.hidden = index !== 1; headers.hidden = index !== 2; }); tabs.append(button); });
    const lower = document.createElement("div"); lower.className = "detail-lower"; const factsPanel = document.createElement("section"); factsPanel.className = "detail-panel"; const factsTitle = document.createElement("h3"); factsTitle.textContent = "Inbound facts"; const facts = document.createElement("dl"); facts.className = "fact-list"; facts.append(fact("Received", formatDate(email.created_at, true)), fact("Envelope", (email.received_for || []).join(", ")), fact("Message-ID", email.message_id), fact("Attachments", attachments.length), fact("Content bounded", email.content_truncated ? "yes" : "no"), fact("Inbound ID", email.id)); factsPanel.append(factsTitle, facts);
    const attachmentPanel = document.createElement("section"); attachmentPanel.className = "detail-panel"; const attachmentTitle = document.createElement("h3"); attachmentTitle.textContent = "Private downloads"; const list = document.createElement("div"); list.className = "attachment-list";
    attachments.forEach((attachment) => { const row = document.createElement("div"); row.className = "attachment-card"; const name = document.createElement("span"); name.textContent = attachment.filename; const meta = document.createElement("span"); meta.textContent = attachment.content_type + " · " + attachment.size + " bytes"; const link = document.createElement("a"); link.className = "text-link"; link.href = attachment.download_url; link.target = "_blank"; link.rel = "noreferrer noopener"; link.textContent = "Download ↗"; row.append(name, meta, link); list.append(row); });
    if (email.raw && email.raw.download_url) { const row = document.createElement("div"); row.className = "attachment-card"; const name = document.createElement("span"); name.textContent = "Original raw MIME"; const meta = document.createElement("span"); meta.textContent = "link expires " + formatDate(email.raw.expires_at, true); const link = document.createElement("a"); link.className = "text-link"; link.href = email.raw.download_url; link.target = "_blank"; link.rel = "noreferrer noopener"; link.textContent = "Download ↗"; row.append(name, meta, link); list.append(row); }
    if (!attachments.length && !(email.raw && email.raw.download_url)) { const none = document.createElement("p"); none.className = "signal-detail"; none.textContent = "No downloadable content."; list.append(none); }
    attachmentPanel.append(attachmentTitle, list); lower.append(factsPanel, attachmentPanel); container.append(head, tabs, viewer, lower);
  }

  async function selectReceived(id, list) {
    state.selectedResource.set("received", id); list.querySelectorAll("button").forEach((button) => button.classList.toggle("is-selected", button.dataset.id === id)); const detail = byId("received-detail"); detail.replaceChildren(); const loading = document.createElement("div"); loading.className = "loading-state"; loading.innerHTML = "<div class=\"loading-line\"></div>"; detail.append(loading);
    try { const [email, attachmentPage] = await Promise.all([api("/emails/receiving/" + encodeURIComponent(id) + "?html_format=data_uri"), api("/emails/receiving/" + encodeURIComponent(id) + "/attachments")]); renderReceivedDetail(detail, email, Array.isArray(attachmentPage.data) ? attachmentPage.data : []); }
    catch (error) { detail.replaceChildren(emptyResource("This received email could not be loaded.", error instanceof Error ? error.message : "Unexpected error.")); }
  }

  async function renderReceived() {
    if (!hasScope("emails:read")) { showPermission("emails:read"); return; }
    const rows = await loadRows("received", "/emails/receiving?limit=100"); body.replaceChildren(); body.append(resourceToolbar("Inbound content remains in this deployment; signed downloads expire after 15 minutes."));
    if (!rows.length) { body.append(emptyResource("No received email.", "Messages accepted by a configured inbound route will appear here.")); return; }
    let selected = state.selectedResource.get("received"); if (!rows.some((row) => row.id === selected)) selected = rows[0].id; state.selectedResource.set("received", selected);
    const layout = document.createElement("section"); layout.className = "email-workspace"; const list = document.createElement("div"); list.className = "email-list"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Received emails"); const detail = document.createElement("article"); detail.id = "received-detail"; detail.className = "email-detail";
    rows.forEach((email) => { const button = document.createElement("button"); button.type = "button"; button.className = "email-row" + (email.id === selected ? " is-selected" : ""); button.dataset.id = email.id; const head = document.createElement("span"); head.className = "email-row-head"; const subject = document.createElement("span"); subject.className = "email-subject"; subject.textContent = email.subject || "(no subject)"; const time = document.createElement("time"); time.className = "email-time"; time.textContent = relativeTime(email.created_at); head.append(subject, time); const foot = document.createElement("span"); foot.className = "email-row-foot"; const route = document.createElement("span"); route.className = "email-route"; route.textContent = email.from; const count = document.createElement("span"); count.className = "toolbar-meta"; count.textContent = (email.attachments || []).length + " file(s)"; foot.append(route, count); button.append(head, foot); button.addEventListener("click", () => selectReceived(email.id, list)); list.append(button); });
    layout.append(list, detail); body.append(layout); await selectReceived(selected, list);
  }

  function openDomainRecords(domain) {
    openResourceDialog({
      eyebrow: "DNS evidence",
      title: domain.name,
      readOnly: true,
      render: (content) => {
        const records = document.createElement("div"); records.className = "dns-records";
        (domain.records || []).forEach((record) => {
          const row = document.createElement("div"); row.className = "record-card";
          const name = document.createElement("code"); name.textContent = (record.type || "DNS") + " · " + (record.name || "—");
          const value = document.createElement("code"); value.textContent = record.value || record.content || "—";
          row.append(name, value, pill(record.status || "pending")); records.append(row);
        });
        if (!(domain.records || []).length) records.append(emptyResource("No DNS records reported.", "The active transport has not returned verification records yet."));
        content.append(records);
      },
    });
  }

  function openCreateDomain() {
    openResourceDialog({
      eyebrow: "Sending identity",
      title: "Add a domain",
      submitLabel: "Add domain",
      render: (content) => content.append(field("Domain name", "name", { required: true, placeholder: "example.com" })),
      onSubmit: async (form) => {
        const name = String(new FormData(form).get("name") || "").trim().toLowerCase();
        await api("/domains", { method: "POST", body: JSON.stringify({ name }) });
        invalidate("domains"); closeResourceDialog(); showToast("Domain added · " + name); await renderDomains();
      },
    });
  }

  async function renderDomains() {
    if (!hasScope("domains:read")) { showPermission("domains:read"); return; }
    const rows = await loadRows("domains", "/domains?limit=100");
    body.replaceChildren();
    const create = hasScope("domains:write") ? actionButton("Add domain", openCreateDomain, { primary: true }) : null;
    body.append(resourceToolbar("DNS records and verification state come from the active transport.", create));
    if (!rows.length) { body.append(emptyResource("No sending domains yet.", "Add a domain to receive the exact DNS records required by this deployment.", create ? actionButton("Add first domain", openCreateDomain, { primary: true }) : null)); return; }
    body.append(resourceTable([
      { label: "Domain", value: "name" },
      { label: "Status", value: "status", status: true },
      { label: "Region", value: "region" },
      { label: "DNS", value: (row) => (row.records || []).filter((record) => record.status === "verified").length + "/" + (row.records || []).length + " verified" },
      { label: "Updated", value: (row) => formatDate(row.updated_at) },
      { label: "Actions", render: (cell, row) => {
        cell.className = "row-actions";
        cell.append(actionButton("DNS records", () => openDomainRecords(row)));
        if (hasScope("domains:write")) {
          cell.append(actionButton("Verify", async () => { await api("/domains/" + encodeURIComponent(row.id) + "/verify", { method: "POST" }); invalidate("domains"); showToast("Verification refreshed · " + row.name); await renderDomains(); }));
          cell.append(actionButton("Delete", () => confirmOperation({ title: "Delete " + row.name + "?", copy: "This removes the domain configuration from this HayaSend deployment. DNS records at the provider are not removed automatically.", expected: row.name, submitLabel: "Delete domain", run: async () => { await api("/domains/" + encodeURIComponent(row.id), { method: "DELETE" }); invalidate("domains"); showToast("Domain deleted · " + row.name); await renderDomains(); } }), { danger: true }));
        }
      } },
    ], rows));
  }

  function openWebhookForm(webhook) {
    const existing = webhook || null;
    openResourceDialog({
      eyebrow: "Signed event delivery",
      title: existing ? "Edit webhook" : "Create webhook",
      submitLabel: existing ? "Save webhook" : "Create webhook",
      render: (content) => {
        content.append(field("HTTPS endpoint", "endpoint", { type: "url", required: true, value: existing && existing.endpoint, placeholder: "https://example.com/webhooks/hayasend" }));
        const eventLabel = document.createElement("p"); eventLabel.className = "resource-field"; eventLabel.textContent = "Events";
        content.append(eventLabel, checkboxGroup("events", WEBHOOK_EVENTS, existing ? existing.events || [] : ["email.delivered", "email.bounced", "email.complained", "email.failed"]));
        if (existing) {
          const statusLabel = field("Status", "status"); const input = statusLabel.querySelector("input"); input.remove();
          const select = document.createElement("select"); select.name = "status"; ["enabled", "disabled"].forEach((value) => { const option = document.createElement("option"); option.value = value; option.textContent = value; option.selected = existing.status === value; select.append(option); }); statusLabel.append(select); content.append(statusLabel);
        }
      },
      onSubmit: async (form) => {
        const data = new FormData(form); const events = data.getAll("events").map(String);
        if (!events.length) throw new Error("Select at least one webhook event.");
        const payload = { endpoint: String(data.get("endpoint") || "").trim(), events, ...(existing ? { status: String(data.get("status")) } : {}) };
        const result = await api(existing ? "/webhooks/" + encodeURIComponent(existing.id) : "/webhooks", { method: existing ? "PATCH" : "POST", body: JSON.stringify(payload) });
        invalidate("webhooks");
        if (!existing && result.signing_secret) {
          showOneTimeSecret("Webhook created", "Signing secret", result.signing_secret, "Store this secret now. HayaSend will not return it again.");
          await renderWebhooks();
        } else {
          closeResourceDialog(); showToast("Webhook updated."); await renderWebhooks();
        }
      },
    });
  }

  async function openWebhookDeliveries(webhook) {
    const page = await api("/webhooks/" + encodeURIComponent(webhook.id) + "/deliveries?limit=100");
    const deliveries = Array.isArray(page.data) ? page.data : [];
    openResourceDialog({
      eyebrow: "Delivery evidence",
      title: "Webhook deliveries",
      readOnly: true,
      render: (content) => {
        const list = document.createElement("div"); list.className = "delivery-list";
        deliveries.forEach((delivery) => {
          const row = document.createElement("div"); row.className = "delivery-card";
          const meta = document.createElement("code"); meta.textContent = delivery.event_type + " · " + formatDate(delivery.created_at, true);
          const detail = document.createElement("code"); detail.textContent = delivery.response_status ? "HTTP " + delivery.response_status + " · " + delivery.attempts + " attempt(s)" : (delivery.last_error || delivery.attempts + " attempt(s)");
          const actions = document.createElement("div"); actions.className = "row-actions"; actions.append(pill(delivery.status));
          if (hasScope("webhooks:write")) actions.append(actionButton("Replay", () => confirmOperation({ title: "Replay this webhook event?", copy: "A new signed delivery will be queued. The receiving endpoint must handle duplicate business events idempotently.", expected: "REPLAY", submitLabel: "Queue replay", run: async () => { await api("/webhooks/" + encodeURIComponent(webhook.id) + "/deliveries/" + encodeURIComponent(delivery.id) + "/replay", { method: "POST" }); showToast("Webhook replay queued."); } })));
          row.append(meta, detail, actions); list.append(row);
        });
        if (!deliveries.length) list.append(emptyResource("No retained deliveries.", "Deliveries appear after this endpoint receives a subscribed event."));
        content.append(list);
      },
    });
  }

  async function renderWebhooks() {
    if (!hasScope("webhooks:read")) { showPermission("webhooks:read"); return; }
    const rows = await loadRows("webhooks", "/webhooks?limit=100");
    body.replaceChildren();
    const create = hasScope("webhooks:write") ? actionButton("Create webhook", () => openWebhookForm(), { primary: true }) : null;
    body.append(resourceToolbar("Endpoints receive signed recipient and ingress events; secrets are shown once.", create));
    if (!rows.length) { body.append(emptyResource("No webhooks configured.", "Create an endpoint and subscribe only to the event types your integration consumes.", create ? actionButton("Create first webhook", () => openWebhookForm(), { primary: true }) : null)); return; }
    body.append(resourceTable([
      { label: "Endpoint", value: "endpoint" }, { label: "Status", value: "status", status: true },
      { label: "Events", value: (row) => (row.events || []).join(", ") }, { label: "Created", value: (row) => formatDate(row.created_at) },
      { label: "Actions", render: (cell, row) => { cell.className = "row-actions"; cell.append(actionButton("Deliveries", () => openWebhookDeliveries(row))); if (hasScope("webhooks:write")) { cell.append(actionButton("Edit", () => openWebhookForm(row))); cell.append(actionButton("Delete", () => confirmOperation({ title: "Delete this webhook?", copy: "Future events will no longer be delivered to " + row.endpoint + ". Retained delivery evidence is also removed with the webhook.", expected: "DELETE", submitLabel: "Delete webhook", run: async () => { await api("/webhooks/" + encodeURIComponent(row.id), { method: "DELETE" }); invalidate("webhooks"); showToast("Webhook deleted."); await renderWebhooks(); } }), { danger: true })); } } },
    ], rows));
  }

  function openSuppressionForm() {
    openResourceDialog({
      eyebrow: "Delivery protection", title: "Suppress a recipient", submitLabel: "Add suppression",
      render: (content) => { content.append(field("Email address", "email", { type: "email", required: true, placeholder: "recipient@example.com" })); content.append(field("Operator note", "detail", { multiline: true, maxLength: 500, placeholder: "Why this address should not receive mail" })); },
      onSubmit: async (form) => { const data = new FormData(form); const payload = { email: String(data.get("email") || "").trim().toLowerCase(), reason: "manual", ...(String(data.get("detail") || "").trim() ? { detail: String(data.get("detail")).trim() } : {}) }; await api("/suppressions", { method: "POST", body: JSON.stringify(payload) }); invalidate("suppressions"); closeResourceDialog(); showToast("Recipient suppressed · " + payload.email); await renderSuppressions(); },
    });
  }

  async function renderSuppressions() {
    if (!hasScope("suppressions:read")) { showPermission("suppressions:read"); return; }
    const rows = await loadRows("suppressions", "/suppressions?limit=100"); body.replaceChildren();
    const create = hasScope("suppressions:write") ? actionButton("Add suppression", openSuppressionForm, { primary: true }) : null;
    body.append(resourceToolbar("Suppressed recipients are rejected before provider handoff.", create));
    if (!rows.length) { body.append(emptyResource("No suppressed recipients.", "Manual suppressions and provider-originated protections will appear here.", create ? actionButton("Suppress a recipient", openSuppressionForm, { primary: true }) : null)); return; }
    body.append(resourceTable([
      { label: "Recipient", value: "email" }, { label: "Reason", value: "reason", status: true }, { label: "Detail", value: (row) => row.detail || "—" }, { label: "Source", value: (row) => row.source_email_id || "Manual" }, { label: "Updated", value: (row) => formatDate(row.updated_at || row.created_at) },
      { label: "Actions", render: (cell, row) => { cell.className = "row-actions"; if (hasScope("suppressions:write")) cell.append(actionButton("Remove", () => confirmOperation({ title: "Allow delivery to this recipient?", copy: "Removing the suppression permits future sends to " + row.email + ". It does not retry previously suppressed messages.", expected: row.email, submitLabel: "Remove suppression", run: async () => { await api("/suppressions/" + encodeURIComponent(row.email), { method: "DELETE" }); invalidate("suppressions"); showToast("Suppression removed · " + row.email); await renderSuppressions(); } }), { danger: true })); } },
    ], rows));
  }

  function openApiKeyForm() {
    const allowed = API_SCOPES.filter((scope) => hasScope(scope));
    openResourceDialog({
      eyebrow: "Least-privilege access", title: "Create an API key", submitLabel: "Create key",
      render: (content) => {
        content.append(field("Key name", "name", { required: true, maxLength: 100, placeholder: "production-app" }));
        const scopeLabel = document.createElement("p"); scopeLabel.className = "resource-field"; scopeLabel.textContent = "Scopes"; content.append(scopeLabel, checkboxGroup("scopes", allowed, []));
        content.append(field("Expires at (optional)", "expires_at", { type: "datetime-local" }));
      },
      onSubmit: async (form) => {
        const data = new FormData(form); const scopes = data.getAll("scopes").map(String); if (!scopes.length) throw new Error("Select at least one scope.");
        const localExpiry = String(data.get("expires_at") || ""); const payload = { name: String(data.get("name") || "").trim(), scopes, ...(localExpiry ? { expires_at: new Date(localExpiry).toISOString() } : {}) };
        const result = await api("/api-keys", { method: "POST", body: JSON.stringify(payload) }); invalidate("api-keys");
        showOneTimeSecret("API key created", "Secret token", result.token, "Copy this token into your password manager now. Only its prefix will remain after this dialog closes.");
        await renderApiKeys();
      },
    });
  }

  async function renderApiKeys() {
    if (!hasScope("api_keys:read")) { showPermission("api_keys:read"); return; }
    const rows = await loadRows("api-keys", "/api-keys?limit=100"); body.replaceChildren();
    const create = hasScope("api_keys:write") ? actionButton("Create API key", openApiKeyForm, { primary: true }) : null;
    body.append(resourceToolbar("Tokens are never stored in plaintext and are shown only once at creation.", create));
    if (!rows.length) { body.append(emptyResource("No scoped API keys.", "The bootstrap administrator may create a least-privilege key for this console or an application.", create ? actionButton("Create first key", openApiKeyForm, { primary: true }) : null)); return; }
    body.append(resourceTable([
      { label: "Name", value: "name" }, { label: "Prefix", value: "prefix" }, { label: "Scopes", value: (row) => (row.scopes || []).join(", ") }, { label: "Expires", value: (row) => formatDate(row.expires_at) }, { label: "State", value: (row) => row.revoked_at ? "revoked" : "active", status: true },
      { label: "Actions", render: (cell, row) => { cell.className = "row-actions"; if (hasScope("api_keys:write") && !row.revoked_at) cell.append(actionButton("Revoke", () => confirmOperation({ title: "Revoke " + row.name + "?", copy: "Clients using prefix " + row.prefix + " will lose access immediately. This cannot be undone.", expected: row.name, submitLabel: "Revoke key", run: async () => { await api("/api-keys/" + encodeURIComponent(row.id), { method: "DELETE" }); invalidate("api-keys"); showToast("API key revoked · " + row.name); await renderApiKeys(); } }), { danger: true })); } },
    ], rows));
  }

  async function renderOperations() {
    body.replaceChildren();
    const layout = document.createElement("section"); layout.className = "operations-grid";
    const steps = document.createElement("div");
    const heading = document.createElement("div"); heading.className = "section-heading"; heading.innerHTML = "<h2>Reviewed lifecycle</h2><p>CLI remains the mutation boundary</p>"; steps.append(heading);
    const items = [
      ["01", "Inspect", "Use this console and status aws for health, version, queue, drift, and capability evidence.", "Open setup workspace", "https://hayasend.com/setup.html"],
      ["02", "Plan", "Generate an exact-version deploy or upgrade plan before any cloud mutation.", "AWS quickstart", "https://github.com/haya-inc/hayasend/blob/main/docs/aws-quickstart.md"],
      ["03", "Apply and verify", "Apply only the reviewed plan, then re-run doctor and inspect recipient-level delivery here.", "Operations runbook", "https://github.com/haya-inc/hayasend/blob/main/docs/operations.md"],
      ["04", "Recover or clean up", "Rollback and cleanup stay guarded by stack identity, retention, protection, and explicit acknowledgement.", "Recovery guidance", "https://github.com/haya-inc/hayasend/blob/main/docs/aws-dogfood.md"],
    ];
    items.forEach((item) => {
      const row = document.createElement("div"); row.className = "operation-step";
      const number = document.createElement("span"); number.className = "step-number"; number.textContent = item[0];
      const copy = document.createElement("div"); const title = document.createElement("h3"); title.textContent = item[1]; const paragraph = document.createElement("p"); paragraph.textContent = item[2]; copy.append(title, paragraph);
      const link = document.createElement("a"); link.className = "text-link"; link.href = item[4]; link.rel = "noreferrer"; link.textContent = item[3] + " ↗";
      row.append(number, copy, link); steps.append(row);
    });
    const evidence = document.createElement("div");
    const evidenceHead = document.createElement("div"); evidenceHead.className = "section-heading"; evidenceHead.innerHTML = "<h2>Session boundary</h2><p>current key</p>";
    const list = document.createElement("div"); list.className = "signal-list";
    list.append(signal("Principal", state.principal.bootstrap ? "bootstrap administrator" : "scoped API key", state.principal.name, false));
    list.append(signal("Credential storage", "removed when this browser tab closes", "session only", true));
    list.append(signal("Cloud access", "no AWS credentials or SDK calls in the browser", "none", true));
    list.append(signal("Content boundary", "served by and read from this deployment", "customer owned", true));
    evidence.append(evidenceHead, list);
    layout.append(steps, evidence); body.append(layout);
  }

  async function submitTestSend(form) {
    const data = new FormData(form);
    const html = String(data.get("html") || "").trim();
    const text = String(data.get("text") || "").trim();
    if (!html && !text) throw new Error("Provide an HTML or plain-text body.");
    const payload = {
      to: String(data.get("to") || "").trim(),
      subject: String(data.get("subject") || "").trim(),
      ...(String(data.get("from") || "").trim() ? { from: String(data.get("from")).trim() } : {}),
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      tags: [{ name: "source", value: "operator-console" }],
    };
    return api("/emails", { method: "POST", headers: { "idempotency-key": "console_" + crypto.randomUUID() }, body: JSON.stringify(payload) });
  }

  byId("deployment-origin").textContent = "Same-origin only · " + location.origin;
  byId("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("connect"); const error = byId("auth-error"); error.hidden = true; button.disabled = true; button.textContent = "Connecting…";
    try { await connect(byId("api-key").value.trim()); }
    catch (reason) { state.token = ""; sessionStorage.removeItem(SESSION_KEY); error.textContent = reason instanceof Error ? reason.message : "Connection failed."; error.hidden = false; }
    finally { button.disabled = false; button.textContent = "Connect to this deployment"; }
  });
  byId("toggle-secret").addEventListener("click", () => {
    const input = byId("api-key"); const visible = input.type === "text"; input.type = visible ? "password" : "text"; byId("toggle-secret").textContent = visible ? "Show" : "Hide"; byId("toggle-secret").setAttribute("aria-label", visible ? "Show API key" : "Hide API key");
  });
  document.querySelectorAll(".nav-item[data-view]").forEach((button) => button.addEventListener("click", () => selectView(button.dataset.view)));
  byId("refresh-view").addEventListener("click", async () => { state.resources.delete(state.view); if (state.view === "emails" || state.view === "overview") state.emails = []; await checkHealth(); await selectView(state.view); });
  byId("account-menu").addEventListener("click", () => { const popover = byId("account-popover"); popover.hidden = !popover.hidden; byId("account-menu").setAttribute("aria-expanded", popover.hidden ? "false" : "true"); });
  byId("sign-out").addEventListener("click", () => disconnect());
  byId("open-send").addEventListener("click", () => { byId("send-error").hidden = true; byId("send-dialog").showModal(); });
  byId("close-send").addEventListener("click", () => byId("send-dialog").close());
  byId("cancel-send").addEventListener("click", () => byId("send-dialog").close());
  byId("send-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget; const button = byId("submit-send"); const error = byId("send-error"); error.hidden = true; button.disabled = true; button.textContent = "Sending…";
    try { const created = await submitTestSend(form); byId("send-dialog").close(); form.reset(); state.emails = []; state.selectedEmailId = created.id; showToast("Email accepted · " + created.id); await selectView("emails"); }
    catch (reason) { error.textContent = reason instanceof Error ? reason.message : "Send failed."; error.hidden = false; }
    finally { button.disabled = false; button.textContent = "Send email"; }
  });
  byId("close-resource-dialog").addEventListener("click", closeResourceDialog);
  byId("cancel-resource-dialog").addEventListener("click", closeResourceDialog);
  byId("resource-dialog").addEventListener("close", () => { state.resourceSubmit = null; byId("resource-dialog-body").replaceChildren(); });
  byId("resource-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.resourceSubmit) return;
    const button = byId("submit-resource-dialog"); const error = byId("resource-dialog-error"); const original = button.textContent; error.hidden = true; button.disabled = true; button.textContent = "Working…";
    try { await state.resourceSubmit(event.currentTarget); }
    catch (reason) { error.textContent = reason instanceof Error ? reason.message : "Operation failed."; error.hidden = false; }
    finally { button.disabled = false; button.textContent = original; }
  });
  const closeConfirmation = () => { state.confirmSubmit = null; byId("confirm-dialog").close(); };
  byId("close-confirm-dialog").addEventListener("click", closeConfirmation);
  byId("cancel-confirm-dialog").addEventListener("click", closeConfirmation);
  byId("confirm-dialog").addEventListener("close", () => { state.confirmSubmit = null; byId("confirm-input").value = ""; });
  byId("confirm-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const operation = state.confirmSubmit; if (!operation) return;
    const error = byId("confirm-dialog-error"); const button = byId("submit-confirm-dialog"); const original = button.textContent; error.hidden = true;
    if (byId("confirm-input").value !== operation.expected) { error.textContent = "The confirmation value does not match."; error.hidden = false; return; }
    button.disabled = true; button.textContent = "Working…";
    try { await operation.run(); closeConfirmation(); }
    catch (reason) { error.textContent = reason instanceof Error ? reason.message : "Operation failed."; error.hidden = false; }
    finally { button.disabled = false; button.textContent = original; }
  });

  const storedToken = sessionStorage.getItem(SESSION_KEY);
  if (storedToken) {
    connect(storedToken).catch(() => disconnect(false));
  } else {
    byId("api-key").focus();
  }
})();
`;
