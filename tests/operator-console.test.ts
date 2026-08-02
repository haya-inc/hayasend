import { describe, expect, it } from "vitest";

import {
  OPERATOR_CONSOLE_CSS,
  OPERATOR_CONSOLE_JS,
  OPERATOR_CONSOLE_PREVIEW_HTML,
  OPERATOR_CONSOLE_PREVIEW_JS,
} from "../src/operator-console.js";
import { renderOperatorConsole } from "../src/operator-console-view.js";

describe("authenticated operator console", () => {
  it("ships a restrained, accessible operations workspace without remote runtime assets", () => {
    const html = renderOperatorConsole({ betterAuthEnabled: true });
    expect(html).toContain(
      "<title>Operator Console · HayaSend</title>",
    );
    expect(html).toContain('data-console-auth="better-auth"');
    expect(html).toContain('id="google-sign-in"');
    expect(html).toContain('id="api-key-fallback"');
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('<main id="workspace-main"');
    expect(html).toContain(
      'aria-label="Console navigation"',
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('href="/console/app.css"');
    expect(html).toContain('src="/console/app.js"');
    expect(html).not.toMatch(/src="https:\/\//);
    expect(html).not.toMatch(
      /<link\b[^>]*href="https:\/\//,
    );
    expect(OPERATOR_CONSOLE_CSS).toContain("prefers-reduced-motion");
    expect(OPERATOR_CONSOLE_CSS).toContain("grid-template-columns");
    expect(OPERATOR_CONSOLE_CSS).toContain(
      "font-size: clamp(28px,3vw,40px)",
    );
    expect(OPERATOR_CONSOLE_CSS).toContain(
      ".resource-table .column-state { width: 84px; min-width: 84px; white-space: nowrap; }",
    );
    expect(OPERATOR_CONSOLE_CSS).toContain(
      ".resource-table .column-actions { width: 88px; min-width: 88px; white-space: nowrap; }",
    );
    expect(OPERATOR_CONSOLE_CSS).not.toContain("box-shadow: inset 2px 0");
    expect(OPERATOR_CONSOLE_CSS).not.toContain(
      ".email-row.is-selected::before",
    );
    expect(OPERATOR_CONSOLE_JS).toContain("resource-table-scroll");
  });

  it("keeps credentials tab-scoped and every data request same-origin and authenticated", () => {
    expect(OPERATOR_CONSOLE_JS).toContain(
      'const SESSION_KEY = "hayasend.operator-console.api-key.v1"',
    );
    expect(OPERATOR_CONSOLE_JS).toContain("sessionStorage.setItem");
    expect(OPERATOR_CONSOLE_JS).toContain("sessionStorage.removeItem");
    expect(OPERATOR_CONSOLE_JS).not.toContain("localStorage");
    expect(OPERATOR_CONSOLE_JS).toContain(
      'headers.set("authorization", "Bearer " + state.token)',
    );
    expect(OPERATOR_CONSOLE_JS).toContain('credentials: "same-origin"');
    expect(OPERATOR_CONSOLE_JS).toContain('redirect: "error"');
    expect(OPERATOR_CONSOLE_JS).toContain('api("/auth/session")');
    expect(OPERATOR_CONSOLE_JS).not.toContain("XMLHttpRequest");
    expect(OPERATOR_CONSOLE_JS).not.toContain("WebSocket");
    expect(OPERATOR_CONSOLE_JS).not.toContain("eval(");
  });

  it("uses standard scoped APIs for complete daily operations", () => {
    for (const expected of [
      'api("/diagnostics/recovery")',
      'api("/emails?limit=100&view=summary")',
      'loadRows("received", "/emails/receiving?limit=100")',
      'loadRows("templates", "/templates?limit=100")',
      'loadRows("domains", "/domains?limit=100")',
      'loadRows("webhooks", "/webhooks?limit=100")',
      'loadRows("suppressions", "/suppressions?limit=100")',
      'loadRows("api-keys", "/api-keys?limit=100")',
      'api("/emails", { method: "POST"',
      '"idempotency-key": "console_" + crypto.randomUUID()',
      'method: "PATCH"',
      'method: "DELETE"',
      '"if-match": "\\\"" + template.current_version_id + "\\\""',
    ]) {
      expect(OPERATOR_CONSOLE_JS).toContain(expected);
    }
    const html = renderOperatorConsole({ betterAuthEnabled: false });
    expect(html).toContain('data-console-auth="api-key"');
    expect(html).toContain('data-view="received"');
    expect(html).toContain('data-view="templates"');
    expect(html).toContain('id="confirm-dialog"');
  });

  it("hardens previews and handles generated secrets as one-time values", () => {
    expect(OPERATOR_CONSOLE_JS).toContain("safePreviewDocument");
    expect(OPERATOR_CONSOLE_JS).toContain(
      'script, iframe, object, embed, form, base, link, meta[http-equiv]',
    );
    expect(OPERATOR_CONSOLE_JS).toContain("default-src 'none'");
    expect(OPERATOR_CONSOLE_JS).toContain("connect-src 'none'");
    expect(OPERATOR_CONSOLE_JS).toContain("form-action 'none'");
    expect(OPERATOR_CONSOLE_JS).toContain(
      'frame.setAttribute("sandbox", "allow-scripts")',
    );
    expect(OPERATOR_CONSOLE_JS).toContain('frame.src = "/console/preview"');
    expect(OPERATOR_CONSOLE_JS).toContain("frame.contentWindow?.postMessage");
    expect(OPERATOR_CONSOLE_JS).not.toContain("frame.srcdoc =");
    expect(OPERATOR_CONSOLE_PREVIEW_HTML).toContain(
      'src="/console/preview.js"',
    );
    expect(OPERATOR_CONSOLE_PREVIEW_JS).toContain(
      "event.source !== window.parent",
    );
    expect(OPERATOR_CONSOLE_PREVIEW_JS).toContain(
      'script, iframe, object, embed, form, base, link, meta[http-equiv]',
    );
    expect(OPERATOR_CONSOLE_PREVIEW_JS).toContain(
      "style.dataset.emailPreviewStyle",
    );
    expect(OPERATOR_CONSOLE_PREVIEW_JS).not.toContain("fetch(");
    expect(OPERATOR_CONSOLE_PREVIEW_JS).not.toContain("sessionStorage");
    expect(OPERATOR_CONSOLE_PREVIEW_JS).not.toContain("localStorage");
    expect(OPERATOR_CONSOLE_JS).toContain("showOneTimeSecret");
    expect(OPERATOR_CONSOLE_JS).toContain(
      "Only its prefix will remain after this dialog closes.",
    );
    expect(OPERATOR_CONSOLE_JS).not.toContain(
      "sessionStorage.setItem(\"webhook",
    );
    expect(OPERATOR_CONSOLE_JS).not.toContain(
      "sessionStorage.setItem(\"api-key",
    );
    expect(OPERATOR_CONSOLE_JS).toContain(
      "The confirmation value does not match.",
    );
  });
});
