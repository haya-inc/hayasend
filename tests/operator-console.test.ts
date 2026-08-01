import { describe, expect, it } from "vitest";

import {
  OPERATOR_CONSOLE_CSS,
  OPERATOR_CONSOLE_HTML,
  OPERATOR_CONSOLE_JS,
} from "../src/operator-console.js";

describe("authenticated operator console", () => {
  it("ships a restrained, accessible operations workspace without remote runtime assets", () => {
    expect(OPERATOR_CONSOLE_HTML).toContain(
      "<title>Operator Console · HayaSend</title>",
    );
    expect(OPERATOR_CONSOLE_HTML).toContain('class="skip-link"');
    expect(OPERATOR_CONSOLE_HTML).toContain('<main id="workspace-main"');
    expect(OPERATOR_CONSOLE_HTML).toContain(
      'aria-label="Console navigation"',
    );
    expect(OPERATOR_CONSOLE_HTML).toContain('role="status"');
    expect(OPERATOR_CONSOLE_HTML).toContain('autocomplete="current-password"');
    expect(OPERATOR_CONSOLE_HTML).toContain('href="/console/app.css"');
    expect(OPERATOR_CONSOLE_HTML).toContain('src="/console/app.js"');
    expect(OPERATOR_CONSOLE_HTML).not.toMatch(/src="https:\/\//);
    expect(OPERATOR_CONSOLE_HTML).not.toMatch(
      /<link\b[^>]*href="https:\/\//,
    );
    expect(OPERATOR_CONSOLE_CSS).toContain("prefers-reduced-motion");
    expect(OPERATOR_CONSOLE_CSS).toContain("grid-template-columns");
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
    expect(OPERATOR_CONSOLE_HTML).toContain('data-view="received"');
    expect(OPERATOR_CONSOLE_HTML).toContain('data-view="templates"');
    expect(OPERATOR_CONSOLE_HTML).toContain('id="confirm-dialog"');
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
      'frame.setAttribute("sandbox", "")',
    );
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
