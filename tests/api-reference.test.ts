import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hardenApiReference,
  markupWithoutScripts,
  REDOC_BUNDLE_URL,
} from "../scripts/api-reference.mjs";

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

describe("static API reference", () => {
  it("embeds the pinned renderer and permits only hashed scripts", () => {
    const renderer = Buffer.from("window.Redoc = Object.freeze({});");
    const generated = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf8" />
  <title>HayaSend API Reference</title>
  <script src="${REDOC_BUNDLE_URL}" integrity="sha384-${"A".repeat(64)}" crossorigin="anonymous"></script>
</head>
<body>
  <div id="redoc"></div>
  <script>
    const __redoc_state = {"spec":{"data":{"openapi":"3.1.0","info":{"title":"HayaSend API","version":"0.1.0"}}},"options":{}};
    var container = document.getElementById('redoc');
    Redoc.hydrate(__redoc_state, container);
  </script>
</body>
</html>`;

    const hardened = hardenApiReference(generated, renderer, sha256(renderer));

    expect(hardened).toContain('<html lang="en">');
    expect(hardened).toContain('<meta charset="utf-8" />');
    expect(hardened).toContain(`connect-src 'none'`);
    expect(hardened).toContain(`form-action 'none'`);
    expect(hardened.match(/'sha256-[A-Za-z0-9+/=]+'/g)).toHaveLength(2);
    expect(hardened).toContain(renderer.toString("utf8"));
    expect(hardened).toContain("Redoc.init(spec, options");
    expect(hardened).toContain('placeholder="Search API operations"');
    expect(hardened).toContain("operation.terms.includes(query)");
    expect(hardened).not.toContain("Redoc.hydrate");
    expect(hardened).not.toContain(REDOC_BUNDLE_URL);
    expect(markupWithoutScripts(hardened)).not.toMatch(
      /<script\b[^>]*\bsrc\s*=/i,
    );
  });

  it("fails closed for changed or unsafe renderer bytes", () => {
    const renderer = Buffer.from("window.Redoc = {};");
    const generated = `<html><head>
  <title>HayaSend API Reference</title>
  <script src="${REDOC_BUNDLE_URL}"></script>
</head><body><script>
  const __redoc_state = {"spec":{"data":{"openapi":"3.1.0","info":{"title":"HayaSend API"}}},"options":{}};
  var container = document.getElementById('redoc');
</script></body></html>`;

    expect(() =>
      hardenApiReference(generated, renderer, "0".repeat(64)),
    ).toThrow("SHA-256");
    expect(() =>
      hardenApiReference(
        generated,
        Buffer.from("</script><script>alert(1)</script>"),
        sha256(Buffer.from("</script><script>alert(1)</script>")),
      ),
    ).toThrow("cannot be embedded safely");
  });
});
