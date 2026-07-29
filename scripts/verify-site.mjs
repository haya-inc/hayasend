import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  markupWithoutScripts,
  SITE_OUTPUT_DIRECTORY,
} from "./api-reference.mjs";

function requireText(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label} is missing ${JSON.stringify(expected)}.`);
  }
}

async function verifySite() {
  const [index, reference, contract, sourceContract, sitemap, customDomain] =
    await Promise.all([
      readFile(join(SITE_OUTPUT_DIRECTORY, "index.html"), "utf8"),
      readFile(join(SITE_OUTPUT_DIRECTORY, "api-reference.html"), "utf8"),
      readFile(join(SITE_OUTPUT_DIRECTORY, "openapi.yaml"), "utf8"),
      readFile(new URL("../openapi.yaml", import.meta.url), "utf8"),
      readFile(join(SITE_OUTPUT_DIRECTORY, "sitemap.xml"), "utf8"),
      readFile(join(SITE_OUTPUT_DIRECTORY, "CNAME"), "utf8"),
    ]);
  if (contract !== sourceContract) {
    throw new Error("The published OpenAPI contract differs from its source.");
  }
  for (const link of ["./api-reference.html", "./openapi.yaml"]) {
    requireText(index, `href="${link}"`, "Project site");
  }
  requireText(
    sitemap,
    "<loc>https://hayasend.com/api-reference.html</loc>",
    "Sitemap",
  );
  if (customDomain !== "hayasend.com\n") {
    throw new Error("The Pages artifact has an unexpected custom domain.");
  }
  for (const expected of [
    "<title>HayaSend API Reference</title>",
    "HayaSend API",
    "0.3.3",
    '"operationId":"sendEmail"',
    '"operationId":"createDomain"',
    '"operationId":"replayWebhookDelivery"',
    'placeholder="Search API operations"',
    `connect-src 'none'`,
    `form-action 'none'`,
    "script-src 'sha256-",
  ]) {
    requireText(reference, expected, "API reference");
  }
  const markup = markupWithoutScripts(reference);
  if (/<script\b[^>]*\bsrc\s*=/i.test(markup)) {
    throw new Error("The API reference loads an external script.");
  }
  if (
    /<link\b(?=[^>]*rel=["'](?:stylesheet|preload|modulepreload))[^>]*href=["']https?:/i.test(
      markup,
    )
  ) {
    throw new Error("The API reference contains an external page dependency.");
  }
  const referenceBytes = (
    await stat(join(SITE_OUTPUT_DIRECTORY, "api-reference.html"))
  ).size;
  if (referenceBytes < 900_000 || referenceBytes > 1_500_000) {
    throw new Error("The generated API reference has an unexpected size.");
  }
  return { referenceBytes };
}

verifySite()
  .then(({ referenceBytes }) => {
    process.stdout.write(
      `${JSON.stringify({ ok: true, reference_bytes: referenceBytes })}\n`,
    );
  })
  .catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
