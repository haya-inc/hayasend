export const PREVIEW_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Local inbox · HayaSend</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23151713'/%3E%3Ctext x='16' y='23' text-anchor='middle' font-family='Georgia' font-size='22' font-style='italic' fill='%23fffaf2'%3EH%3C/text%3E%3C/svg%3E">
    <link rel="stylesheet" href="/preview/app.css">
    <script defer src="/preview/app.js"></script>
  </head>
  <body>
    <header class="topbar">
      <a class="brand" href="/preview" aria-label="HayaSend local inbox">
        <span class="brand-mark" aria-hidden="true">H</span>
        <span>HayaSend</span>
      </a>
      <div class="local-state">
        <span class="live-dot" aria-hidden="true"></span>
        Local inbox
      </div>
    </header>

    <main class="workspace">
      <aside class="inbox" aria-label="Sent messages">
        <div class="inbox-heading">
          <div>
            <p class="eyebrow">Development</p>
            <h1>Messages</h1>
          </div>
          <span id="message-count" class="count" aria-live="polite">0</span>
        </div>
        <label class="search">
          <span class="sr-only">Search messages</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5"></circle>
            <path d="m12.5 12.5 4 4"></path>
          </svg>
          <input id="search" type="search" placeholder="Search subject or recipient" autocomplete="off">
        </label>
        <div id="inbox-list" class="inbox-list" role="listbox" aria-label="Messages"></div>
        <div class="inbox-foot">
          <span id="connection-state">Connecting</span>
          <button id="refresh" class="text-button" type="button">Refresh</button>
        </div>
      </aside>

      <section class="message" aria-label="Message preview">
        <div id="empty-state" class="empty-state">
          <div class="empty-glyph" aria-hidden="true">
            <span></span>
          </div>
          <p class="eyebrow">Waiting for a send</p>
          <h2>Your local messages will appear here.</h2>
          <p>Send through the API or official Resend SDK. Nothing leaves this machine.</p>
          <code>POST /emails</code>
        </div>

        <div id="message-detail" class="message-detail" hidden>
          <header class="message-heading">
            <div class="message-title">
              <div class="title-line">
                <span id="message-status" class="status"></span>
                <time id="message-time"></time>
              </div>
              <h2 id="message-subject"></h2>
              <p id="message-route"></p>
            </div>
            <button id="copy-id" class="copy-button" type="button">Copy ID</button>
          </header>

          <div class="view-bar" role="tablist" aria-label="Message representation">
            <button class="view-tab is-active" type="button" role="tab" data-view="html" aria-selected="true">HTML</button>
            <button class="view-tab" type="button" role="tab" data-view="text" aria-selected="false">Text</button>
            <button class="view-tab" type="button" role="tab" data-view="source" aria-selected="false">Source</button>
            <span class="safety-note">Remote content and interactions blocked</span>
          </div>

          <div class="viewer">
            <iframe id="html-view" title="Sandboxed email HTML preview" sandbox tabindex="-1"></iframe>
            <pre id="text-view" class="code-view" hidden></pre>
            <pre id="source-view" class="code-view" hidden></pre>
          </div>
        </div>
      </section>

      <aside id="inspector" class="inspector" aria-label="Message details">
        <div class="inspector-heading">
          <p class="eyebrow">Inspect</p>
          <h2>Delivery details</h2>
        </div>
        <dl class="facts">
          <div>
            <dt>From</dt>
            <dd id="detail-from">—</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd id="detail-to">—</dd>
          </div>
          <div id="cc-row" hidden>
            <dt>CC</dt>
            <dd id="detail-cc">—</dd>
          </div>
          <div id="bcc-row" hidden>
            <dt>BCC</dt>
            <dd id="detail-bcc">—</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd id="detail-created">—</dd>
          </div>
          <div>
            <dt>Last event</dt>
            <dd id="detail-event">—</dd>
          </div>
        </dl>
        <section class="inspector-section">
          <h3>Tags</h3>
          <div id="detail-tags" class="tag-list"><span class="muted">None</span></div>
        </section>
        <section class="inspector-section">
          <h3>Attachments</h3>
          <div id="detail-attachments" class="attachment-list"><span class="muted">None</span></div>
        </section>
        <section class="inspector-section">
          <h3>Headers</h3>
          <dl id="detail-headers" class="header-list"><div><dd class="muted">None</dd></div></dl>
        </section>
      </aside>
    </main>
  </body>
</html>`;

export const PREVIEW_CSS = String.raw`
:root {
  --paper: #f2eee5;
  --paper-deep: #e9e3d7;
  --canvas: #fbfaf6;
  --ink: #151713;
  --muted: #74766e;
  --line: rgba(21, 23, 19, 0.12);
  --line-strong: rgba(21, 23, 19, 0.22);
  --accent: #d9652b;
  --accent-soft: #f3d7c8;
  --success: #287658;
  --danger: #a23b2b;
  --topbar: 62px;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--paper);
  font-synthesis: none;
}

* {
  box-sizing: border-box;
}

[hidden] {
  display: none !important;
}

html,
body {
  min-width: 320px;
  min-height: 100%;
  margin: 0;
}

body {
  overflow: hidden;
  background: var(--paper);
}

button,
input {
  font: inherit;
}

button,
a {
  -webkit-tap-highlight-color: transparent;
}

button:focus-visible,
a:focus-visible,
input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.topbar {
  height: var(--topbar);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 22px;
  border-bottom: 1px solid var(--line-strong);
  background: var(--paper);
}

.brand {
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
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 7px;
  color: #fffaf2;
  background: var(--ink);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 17px;
  font-style: italic;
}

.local-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 0 rgba(40, 118, 88, 0.35);
  animation: live-pulse 2.4s ease-out infinite;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(250px, 310px) minmax(420px, 1fr) minmax(240px, 286px);
  height: calc(100svh - var(--topbar));
}

.inbox,
.inspector,
.message {
  min-width: 0;
  min-height: 0;
}

.inbox {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line-strong);
}

.inbox-heading,
.inspector-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  min-height: 94px;
  padding: 20px 20px 17px;
}

.eyebrow {
  margin: 0 0 6px;
  color: var(--accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1,
.inspector-heading h2 {
  margin-bottom: 0;
  font-size: 20px;
  line-height: 1;
  letter-spacing: -0.035em;
}

.count {
  display: grid;
  min-width: 27px;
  height: 27px;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  color: var(--muted);
  font-size: 11px;
}

.search {
  position: relative;
  display: block;
  margin: 0 14px 13px;
}

.search svg {
  position: absolute;
  top: 50%;
  left: 12px;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: var(--muted);
  stroke-width: 1.5;
  transform: translateY(-50%);
  pointer-events: none;
}

.search input {
  width: 100%;
  height: 39px;
  padding: 0 12px 0 38px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--ink);
  background: rgba(255, 255, 255, 0.34);
  font-size: 12px;
}

.search input::placeholder {
  color: #95978f;
}

.inbox-list {
  flex: 1;
  overflow: auto;
  border-top: 1px solid var(--line);
}

.email-row {
  position: relative;
  width: 100%;
  display: grid;
  gap: 7px;
  padding: 16px 19px 15px;
  border: 0;
  border-bottom: 1px solid var(--line);
  color: var(--ink);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 150ms ease, padding-left 150ms ease;
}

.email-row:hover {
  background: rgba(255, 255, 255, 0.34);
}

.email-row.is-selected {
  padding-left: 23px;
  background: var(--canvas);
}

.email-row.is-selected::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--accent);
  content: "";
}

.email-row.is-new {
  animation: row-arrive 480ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.row-top,
.row-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.row-from {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-time {
  flex: 0 0 auto;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
}

.row-subject {
  overflow: hidden;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 16px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-recipient {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-status {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--success);
}

.row-status[data-status="failed"],
.row-status[data-status="bounced"],
.row-status[data-status="complained"],
.row-status[data-status="suppressed"] {
  background: var(--danger);
}

.row-status[data-status="queued"],
.row-status[data-status="scheduled"],
.row-status[data-status="sending"] {
  background: var(--accent);
}

.inbox-empty {
  padding: 34px 20px;
  color: var(--muted);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 15px;
  line-height: 1.5;
  text-align: center;
}

.inbox-foot {
  min-height: 45px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  border-top: 1px solid var(--line-strong);
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.text-button {
  padding: 6px 0;
  border: 0;
  color: var(--ink);
  background: transparent;
  font-family: inherit;
  font-size: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  cursor: pointer;
}

.message {
  position: relative;
  overflow: hidden;
  background: var(--canvas);
}

.empty-state {
  height: 100%;
  display: grid;
  align-content: center;
  justify-items: center;
  padding: 36px;
  text-align: center;
}

.empty-glyph {
  position: relative;
  width: 94px;
  height: 68px;
  margin-bottom: 28px;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  transform: rotate(-3deg);
}

.empty-glyph::before,
.empty-glyph::after {
  position: absolute;
  inset: 0;
  content: "";
}

.empty-glyph::before {
  background:
    linear-gradient(33deg, transparent 49.3%, var(--line-strong) 50%, transparent 50.7%),
    linear-gradient(-33deg, transparent 49.3%, var(--line-strong) 50%, transparent 50.7%);
  clip-path: polygon(0 0, 100% 0, 50% 63%);
}

.empty-glyph::after {
  inset: 10px -10px -10px 10px;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  z-index: -1;
}

.empty-glyph span {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
}

.empty-state h2 {
  max-width: 470px;
  margin-bottom: 12px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(30px, 4vw, 50px);
  font-weight: 500;
  line-height: 1.04;
  letter-spacing: -0.045em;
}

.empty-state > p:not(.eyebrow) {
  max-width: 390px;
  margin-bottom: 20px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.empty-state code {
  padding-bottom: 4px;
  border-bottom: 1px solid var(--accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.message-detail {
  height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto 48px minmax(0, 1fr);
  animation: detail-in 230ms ease-out both;
}

.message-detail[hidden] {
  display: none;
}

.message-heading {
  min-height: 118px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 26px;
  padding: 25px 28px 21px;
}

.message-title {
  flex: 1;
  min-width: 0;
}

.title-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
}

.title-line time {
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.status {
  padding: 4px 7px;
  border-radius: 4px;
  color: var(--success);
  background: rgba(40, 118, 88, 0.1);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.status[data-status="queued"],
.status[data-status="scheduled"],
.status[data-status="sending"] {
  color: #9b441e;
  background: var(--accent-soft);
}

.status[data-status="failed"],
.status[data-status="bounced"],
.status[data-status="complained"],
.status[data-status="suppressed"] {
  color: var(--danger);
  background: rgba(162, 59, 43, 0.1);
}

.message-heading h2 {
  overflow: hidden;
  margin-bottom: 7px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(25px, 3vw, 38px);
  font-weight: 500;
  line-height: 1.05;
  letter-spacing: -0.04em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-heading p {
  overflow: hidden;
  margin-bottom: 0;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-button {
  min-width: 72px;
  flex: 0 0 auto;
  padding: 8px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--ink);
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  cursor: pointer;
}

.copy-button:hover {
  background: var(--paper);
}

.view-bar {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  padding: 0 28px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line-strong);
}

.view-tab {
  align-self: stretch;
  padding: 0 13px;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  background: transparent;
  font-size: 11px;
  cursor: pointer;
}

.view-tab:hover {
  color: var(--ink);
}

.view-tab.is-active {
  border-bottom-color: var(--accent);
  color: var(--ink);
  font-weight: 650;
}

.safety-note {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 8px;
  letter-spacing: 0.03em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.viewer {
  min-height: 0;
  padding: 18px;
  background: var(--paper-deep);
}

.viewer iframe,
.code-view {
  width: 100%;
  height: 100%;
  margin: 0;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  background: #fff;
}

.viewer iframe {
  display: block;
  pointer-events: none;
}

.viewer iframe[hidden],
.code-view[hidden] {
  display: none;
}

.code-view {
  overflow: auto;
  padding: 22px;
  color: #35382f;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.inspector {
  overflow: auto;
  border-left: 1px solid var(--line-strong);
}

.inspector-heading {
  display: block;
  border-bottom: 1px solid var(--line);
}

.facts {
  margin: 0;
}

.facts > div,
.inspector-section {
  padding: 15px 19px;
  border-bottom: 1px solid var(--line);
}

.facts dt,
.inspector-section h3 {
  margin: 0 0 7px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.facts dd {
  overflow-wrap: anywhere;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag {
  padding: 4px 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 8px;
}

.attachment-list,
.header-list {
  display: grid;
  gap: 9px;
  margin: 0;
}

.attachment {
  display: grid;
  gap: 2px;
}

.attachment strong,
.header-list dt {
  overflow-wrap: anywhere;
  font-size: 10px;
  font-weight: 650;
}

.attachment span,
.header-list dd {
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 8px;
  line-height: 1.45;
}

.muted {
  color: var(--muted);
  font-size: 10px;
}

@keyframes live-pulse {
  70% {
    box-shadow: 0 0 0 7px rgba(40, 118, 88, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(40, 118, 88, 0);
  }
}

@keyframes row-arrive {
  from {
    opacity: 0;
    transform: translateY(-9px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes detail-in {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 1080px) {
  .workspace {
    grid-template-columns: 280px minmax(420px, 1fr);
  }

  .inspector {
    display: none;
  }
}

@media (max-width: 720px) {
  body {
    overflow: auto;
  }

  .topbar {
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .workspace {
    height: auto;
    min-height: calc(100svh - var(--topbar));
    grid-template-columns: 1fr;
    grid-template-rows: 42svh minmax(58svh, 1fr);
  }

  .inbox {
    border-right: 0;
    border-bottom: 1px solid var(--line-strong);
  }

  .inbox-heading {
    min-height: 70px;
    padding-top: 14px;
    padding-bottom: 12px;
  }

  .message {
    min-height: 58svh;
  }

  .message-heading {
    min-height: 106px;
    padding: 20px 18px 17px;
  }

  .message-heading h2 {
    font-size: 27px;
  }

  .view-bar {
    padding: 0 12px;
  }

  .safety-note {
    display: block;
    font-size: 0;
  }

  .safety-note::after {
    content: "Isolated";
    font-size: 8px;
  }

  .viewer {
    padding: 10px;
  }

  .empty-state {
    padding: 34px 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;

export const PREVIEW_JS = String.raw`
(function () {
  "use strict";

  var state = {
    emails: [],
    detail: null,
    selectedId: null,
    view: "html",
    knownIds: new Set(),
    freshIds: new Set(),
    loading: false
  };

  var dateTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    byId(id).textContent = value || "—";
  }

  async function fetchJson(path) {
    var response = await fetch(path, {
      credentials: "omit",
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    return response.json();
  }

  function shortAddress(address) {
    var match = /^([^<]+)</.exec(address || "");
    return match ? match[1].trim() : (address || "Unknown sender");
  }

  function relativeTime(value) {
    var elapsed = Date.now() - Date.parse(value);
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      return "now";
    }
    var minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) {
      return "now";
    }
    if (minutes < 60) {
      return minutes + "m";
    }
    var hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return hours + "h";
    }
    return Math.floor(hours / 24) + "d";
  }

  function filteredEmails() {
    var query = byId("search").value.trim().toLowerCase();
    if (!query) {
      return state.emails;
    }
    return state.emails.filter(function (email) {
      return [
        email.subject,
        email.from,
        (email.to || []).join(" ")
      ].join(" ").toLowerCase().includes(query);
    });
  }

  function renderList() {
    var list = byId("inbox-list");
    var emails = filteredEmails();
    list.replaceChildren();
    byId("message-count").textContent = String(state.emails.length);

    if (emails.length === 0) {
      var empty = document.createElement("p");
      empty.className = "inbox-empty";
      empty.textContent = state.emails.length === 0
        ? "No messages yet. Send one to the local API."
        : "No messages match this search.";
      list.append(empty);
      return;
    }

    emails.forEach(function (email) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "email-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(email.id === state.selectedId));
      if (email.id === state.selectedId) {
        row.classList.add("is-selected");
      }
      if (state.freshIds.has(email.id)) {
        row.classList.add("is-new");
      }

      var top = document.createElement("span");
      top.className = "row-top";
      var from = document.createElement("span");
      from.className = "row-from";
      from.textContent = shortAddress(email.from);
      var time = document.createElement("time");
      time.className = "row-time";
      time.dateTime = email.created_at;
      time.textContent = relativeTime(email.created_at);
      top.append(from, time);

      var subject = document.createElement("span");
      subject.className = "row-subject";
      subject.textContent = email.subject || "(No subject)";

      var bottom = document.createElement("span");
      bottom.className = "row-bottom";
      var recipient = document.createElement("span");
      recipient.className = "row-recipient";
      recipient.textContent = "to " + (email.to || []).join(", ");
      var status = document.createElement("span");
      status.className = "row-status";
      status.dataset.status = email.status;
      status.title = email.status;
      bottom.append(recipient, status);

      row.append(top, subject, bottom);
      row.addEventListener("click", function () {
        selectEmail(email.id);
      });
      list.append(row);
    });

    state.freshIds.clear();
  }

  function showListValue(rowId, valueId, values) {
    var hasValues = Array.isArray(values) && values.length > 0;
    byId(rowId).hidden = !hasValues;
    if (hasValues) {
      setText(valueId, values.join(", "));
    }
  }

  function renderTags(tags) {
    var container = byId("detail-tags");
    container.replaceChildren();
    if (!tags || tags.length === 0) {
      var none = document.createElement("span");
      none.className = "muted";
      none.textContent = "None";
      container.append(none);
      return;
    }
    tags.forEach(function (tag) {
      var item = document.createElement("span");
      item.className = "tag";
      item.textContent = tag.name + ":" + tag.value;
      container.append(item);
    });
  }

  function renderAttachments(attachments) {
    var container = byId("detail-attachments");
    container.replaceChildren();
    if (!attachments || attachments.length === 0) {
      var none = document.createElement("span");
      none.className = "muted";
      none.textContent = "None";
      container.append(none);
      return;
    }
    attachments.forEach(function (attachment) {
      var item = document.createElement("div");
      item.className = "attachment";
      var name = document.createElement("strong");
      name.textContent = attachment.filename;
      var type = document.createElement("span");
      type.textContent = attachment.content_type || "application/octet-stream";
      item.append(name, type);
      container.append(item);
    });
  }

  function renderHeaders(headers) {
    var container = byId("detail-headers");
    container.replaceChildren();
    var entries = Object.entries(headers || {});
    if (entries.length === 0) {
      var row = document.createElement("div");
      var none = document.createElement("dd");
      none.className = "muted";
      none.textContent = "None";
      row.append(none);
      container.append(row);
      return;
    }
    entries.forEach(function (entry) {
      var row = document.createElement("div");
      var key = document.createElement("dt");
      var value = document.createElement("dd");
      key.textContent = entry[0];
      value.textContent = entry[1];
      row.append(key, value);
      container.append(row);
    });
  }

  function isolatedHtml(html) {
    var policy = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none';";
    var baseStyle = "html{color-scheme:light}body{margin:24px;color:#171814;background:#fff;font-family:Arial,sans-serif;line-height:1.5}img{max-width:100%;height:auto}";
    return "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"" +
      policy + "\"><style>" + baseStyle + "</style></head><body>" +
      (html || "<p>No HTML part.</p>") + "</body></html>";
  }

  function renderView() {
    var email = state.detail;
    if (!email) {
      return;
    }
    var htmlView = byId("html-view");
    var textView = byId("text-view");
    var sourceView = byId("source-view");
    htmlView.hidden = state.view !== "html";
    textView.hidden = state.view !== "text";
    sourceView.hidden = state.view !== "source";
    if (state.view === "html") {
      htmlView.srcdoc = isolatedHtml(email.html);
    } else if (state.view === "text") {
      textView.textContent = email.text || "No plain-text part.";
    } else {
      sourceView.textContent = JSON.stringify(email, null, 2);
    }

    document.querySelectorAll(".view-tab").forEach(function (tab) {
      var active = tab.dataset.view === state.view;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
  }

  function renderDetail() {
    var email = state.detail;
    if (!email) {
      byId("empty-state").hidden = false;
      byId("message-detail").hidden = true;
      return;
    }
    byId("empty-state").hidden = true;
    byId("message-detail").hidden = false;

    setText("message-subject", email.subject || "(No subject)");
    setText("message-route", email.from + " → " + (email.to || []).join(", "));
    setText("message-status", email.status);
    byId("message-status").dataset.status = email.status;
    byId("message-time").dateTime = email.created_at;
    setText("message-time", dateTime.format(new Date(email.created_at)));

    setText("detail-from", email.from);
    setText("detail-to", (email.to || []).join(", "));
    showListValue("cc-row", "detail-cc", email.cc);
    showListValue("bcc-row", "detail-bcc", email.bcc);
    setText("detail-created", dateTime.format(new Date(email.created_at)));
    setText("detail-event", email.last_event);
    renderTags(email.tags);
    renderAttachments(email.attachments);
    renderHeaders(email.headers);
    renderView();
  }

  async function selectEmail(id) {
    if (!id) {
      state.selectedId = null;
      state.detail = null;
      renderList();
      renderDetail();
      return;
    }
    state.selectedId = id;
    renderList();
    history.replaceState(null, "", "/preview?email=" + encodeURIComponent(id));
    try {
      state.detail = await fetchJson("/preview/api/emails/" + encodeURIComponent(id));
      renderDetail();
    } catch (error) {
      byId("connection-state").textContent = "Detail unavailable";
    }
  }

  async function loadEmails(forceDetail) {
    if (state.loading) {
      return;
    }
    state.loading = true;
    try {
      var result = await fetchJson("/preview/api/emails?limit=100");
      var nextEmails = result.data || [];
      if (state.knownIds.size > 0) {
        nextEmails.forEach(function (email) {
          if (!state.knownIds.has(email.id)) {
            state.freshIds.add(email.id);
          }
        });
      }
      state.knownIds = new Set(nextEmails.map(function (email) {
        return email.id;
      }));
      state.emails = nextEmails;
      renderList();

      var requestedId = new URL(location.href).searchParams.get("email");
      var selectedSummary = state.emails.find(function (email) {
        return email.id === state.selectedId;
      });
      var nextId = selectedSummary
        ? selectedSummary.id
        : (requestedId && state.knownIds.has(requestedId)
          ? requestedId
          : (state.emails[0] && state.emails[0].id));

      if (!nextId) {
        await selectEmail(null);
      } else if (
        forceDetail ||
        nextId !== state.selectedId ||
        !state.detail ||
        state.detail.updated_at !== selectedSummary?.updated_at
      ) {
        await selectEmail(nextId);
      }
      byId("connection-state").textContent = "Local · Auto-refresh";
    } catch (error) {
      byId("connection-state").textContent = "Connection lost";
    } finally {
      state.loading = false;
    }
  }

  document.querySelectorAll(".view-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      state.view = tab.dataset.view;
      renderView();
    });
  });

  byId("search").addEventListener("input", renderList);
  byId("refresh").addEventListener("click", function () {
    loadEmails(true);
  });
  byId("copy-id").addEventListener("click", async function () {
    if (!state.selectedId) {
      return;
    }
    try {
      await navigator.clipboard.writeText(state.selectedId);
      byId("copy-id").textContent = "Copied";
      setTimeout(function () {
        byId("copy-id").textContent = "Copy ID";
      }, 1200);
    } catch (error) {
      byId("copy-id").textContent = "Copy failed";
    }
  });

  document.addEventListener("keydown", function (event) {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLButtonElement
    ) {
      return;
    }
    if (event.key !== "j" && event.key !== "k") {
      return;
    }
    var index = state.emails.findIndex(function (email) {
      return email.id === state.selectedId;
    });
    var delta = event.key === "j" ? 1 : -1;
    var next = state.emails[index + delta];
    if (next) {
      selectEmail(next.id);
    }
  });

  loadEmails(true);
  setInterval(function () {
    if (document.visibilityState === "visible") {
      loadEmails(false);
    }
  }, 2000);
})();
`;
