import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteOutputDirectory = join(repositoryRoot, "dist", "site");
const apiReferencePath = join(siteOutputDirectory, "api-reference.html");
const websiteAssets = Object.freeze([
  "404.html",
  "app.js",
  "CNAME",
  "favicon.svg",
  "index.html",
  "robots.txt",
  "sitemap.xml",
  "styles.css",
]);

export const REDOCLY_CLI_VERSION = "2.41.0";
export const REDOC_VERSION = "2.5.3";
export const REDOC_BUNDLE_URL = `https://cdn.redocly.com/redoc/v${REDOC_VERSION}/bundles/redoc.standalone.js`;
export const REDOC_BUNDLE_SHA256 =
  "1320f442151c57c447d3b70c7ffc6c4f86d08464020fe34c8cc5d3164e9944f0";
export const SITE_OUTPUT_DIRECTORY = siteOutputDirectory;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cspHash(value) {
  return createHash("sha256").update(value).digest("base64");
}

function inlineJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function markupWithoutScripts(html) {
  const firstOpen = html.indexOf("<script>");
  const firstClose = html.indexOf("</script>", firstOpen + 8);
  const secondOpen = html.indexOf("<script>", firstClose + 9);
  const secondClose = html.indexOf("</script>", secondOpen + 8);
  if (
    firstOpen < 0 ||
    firstClose < 0 ||
    secondOpen < 0 ||
    secondClose < 0 ||
    html.indexOf("<script", secondClose + 9) >= 0
  ) {
    throw new Error("The API reference has an unexpected script structure.");
  }
  return [
    html.slice(0, firstOpen),
    "<script></script>",
    html.slice(firstClose + 9, secondOpen),
    "<script></script>",
    html.slice(secondClose + 9),
  ].join("");
}

export function hardenApiReference(
  generatedHtml,
  redocBundle,
  expectedBundleSha256 = REDOC_BUNDLE_SHA256,
) {
  const bundle = Buffer.isBuffer(redocBundle)
    ? redocBundle
    : Buffer.from(redocBundle);
  if (sha256(bundle) !== expectedBundleSha256) {
    throw new Error("The pinned Redoc bundle failed its SHA-256 check.");
  }
  const bundleText = bundle.toString("utf8");
  if (/<\/script/i.test(bundleText)) {
    throw new Error("The Redoc bundle cannot be embedded safely.");
  }

  const externalScript = new RegExp(
    `<script src="${escapeRegExp(REDOC_BUNDLE_URL)}"(?: integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous")?></script>`,
    "g",
  );
  if ([...generatedHtml.matchAll(externalScript)].length !== 1) {
    throw new Error(
      "Redocly output did not contain exactly one pinned Redoc script.",
    );
  }
  const stateMatch = generatedHtml.match(
    /const __redoc_state = (\{[\s\S]*\});\s+var container = document\.getElementById\('redoc'\);/,
  );
  if (!stateMatch?.[1]) {
    throw new Error("Redocly output did not contain a serialized API state.");
  }
  const state = JSON.parse(stateMatch[1]);
  if (
    typeof state !== "object" ||
    state === null ||
    typeof state.spec?.data?.openapi !== "string" ||
    typeof state.spec.data.info?.title !== "string" ||
    typeof state.options !== "object" ||
    state.options === null ||
    Array.isArray(state.options)
  ) {
    throw new Error("Redocly output contained an invalid API state.");
  }
  const runtime = [
    `const spec = ${inlineJson(state.spec.data)};`,
    `const options = Object.assign({}, ${inlineJson(state.options)}, { disableSearch: true, scrollYOffset: 64 });`,
    'const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);',
    "const operations = Object.entries(spec.paths || {}).flatMap(([path, pathItem]) =>",
    "  Object.entries(pathItem || {})",
    '    .filter(([method, operation]) => methods.has(method) && operation && typeof operation === "object" && typeof operation.operationId === "string")',
    "    .map(([method, operation]) => ({",
    "      href: `#operation/${encodeURIComponent(operation.operationId)}`,",
    "      method: method.toUpperCase(),",
    "      path,",
    "      summary: operation.summary || operation.operationId,",
    '      terms: `${operation.operationId} ${operation.summary || ""} ${method} ${path}`.toLowerCase(),',
    "    })),",
    ");",
    'const searchForm = document.getElementById("api-search-form");',
    'const searchInput = document.getElementById("api-search-input");',
    'const searchResults = document.getElementById("api-search-results");',
    "function closeSearch() {",
    "  searchResults.hidden = true;",
    '  searchInput.setAttribute("aria-expanded", "false");',
    "}",
    "function renderSearch() {",
    "  const query = searchInput.value.trim().toLowerCase();",
    "  searchResults.replaceChildren();",
    "  if (query.length < 2) {",
    "    closeSearch();",
    "    return;",
    "  }",
    "  const matches = operations.filter((operation) => operation.terms.includes(query)).slice(0, 8);",
    "  if (matches.length === 0) {",
    '    const empty = document.createElement("p");',
    '    empty.className = "api-search-empty";',
    '    empty.setAttribute("role", "status");',
    '    empty.textContent = "No operations found.";',
    "    searchResults.append(empty);",
    "  } else {",
    "    for (const operation of matches) {",
    '      const link = document.createElement("a");',
    '      link.className = "api-search-result";',
    "      link.href = operation.href;",
    '      const summary = document.createElement("strong");',
    "      summary.textContent = operation.summary;",
    '      const detail = document.createElement("small");',
    "      detail.textContent = `${operation.method} ${operation.path}`;",
    "      link.append(summary, detail);",
    '      link.addEventListener("click", () => { searchInput.value = ""; closeSearch(); });',
    "      searchResults.append(link);",
    "    }",
    "  }",
    "  searchResults.hidden = false;",
    '  searchInput.setAttribute("aria-expanded", "true");',
    "}",
    'searchInput.addEventListener("input", renderSearch);',
    'searchInput.addEventListener("keydown", (event) => {',
    '  if (event.key === "Escape") { searchInput.value = ""; closeSearch(); }',
    "});",
    'searchForm.addEventListener("submit", (event) => {',
    "  event.preventDefault();",
    '  const firstResult = searchResults.querySelector("a");',
    "  if (firstResult) firstResult.click();",
    "});",
    'Redoc.init(spec, options, document.getElementById("redoc"));',
  ].join("\n");
  if (/<\/script/i.test(runtime)) {
    throw new Error("The serialized API state cannot be embedded safely.");
  }
  const embeddedBundle = `\n${bundleText}\n`;
  const hashes = [embeddedBundle, runtime].map(
    (content) => `'sha256-${cspHash(content)}'`,
  );
  const contentSecurityPolicy = [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "form-action 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src ${hashes.join(" ")}`,
    "style-src 'unsafe-inline'",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="HayaSend API reference generated from the versioned OpenAPI contract." />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />
  <link rel="canonical" href="https://hayasend.com/api-reference.html" />
  <link rel="icon" href="./favicon.svg" type="image/svg+xml" />
  <title>HayaSend API Reference</title>
  <style>
    :root { --paper: #f4f0e6; --ink: #171916; --soft: #50544d; --line: rgba(23, 25, 22, 0.18); --orange: #b73516; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    .api-tools { position: sticky; z-index: 100; top: 0; display: grid; min-height: 4rem; padding: 0.55rem 1rem; border-bottom: 1px solid var(--line); background: var(--paper); color: var(--ink); align-items: center; gap: 0.75rem; grid-template-columns: auto minmax(12rem, 34rem) auto; font-family: Inter, "Helvetica Neue", Arial, sans-serif; }
    .api-tools > a { color: inherit; font-size: 0.8rem; font-weight: 700; text-decoration: none; }
    .api-tools > a:last-child { color: var(--soft); text-align: right; }
    .api-search { position: relative; }
    .api-search input { width: 100%; min-height: 2.65rem; padding: 0 0.9rem; border: 1px solid var(--ink); border-radius: 0; background: #fffdf8; color: var(--ink); font: inherit; }
    .api-search input:focus { outline: 3px solid #ff5a2f; outline-offset: 2px; }
    .api-search-results { position: absolute; top: calc(100% + 0.45rem); right: 0; left: 0; max-height: min(28rem, 70vh); margin: 0; padding: 0.35rem; border: 1px solid var(--ink); background: #fffdf8; box-shadow: 0.6rem 0.6rem 0 rgba(23, 25, 22, 0.18); overflow-y: auto; }
    .api-search-results[hidden] { display: none; }
    .api-search-result { display: grid; padding: 0.75rem; color: var(--ink); gap: 0.1rem; text-decoration: none; }
    .api-search-result:hover, .api-search-result:focus { background: #e8e1d2; outline: none; }
    .api-search-result strong { font-size: 0.82rem; }
    .api-search-result small { color: var(--soft); font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.64rem; }
    .api-search-empty { margin: 0; padding: 0.8rem; color: var(--soft); font-size: 0.8rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; border: 0; margin: -1px; clip: rect(0 0 0 0); overflow: hidden; white-space: nowrap; }
    @media (max-width: 42rem) { .api-tools { grid-template-columns: auto 1fr; } .api-tools > a:last-child { display: none; } }
  </style>
</head>
<body>
  <header class="api-tools">
    <a href="./">HayaSend</a>
    <form class="api-search" id="api-search-form" role="search">
      <label class="visually-hidden" for="api-search-input">Search API operations</label>
      <input id="api-search-input" type="search" placeholder="Search API operations" autocomplete="off" aria-controls="api-search-results" aria-expanded="false" />
      <div class="api-search-results" id="api-search-results" aria-live="polite" hidden></div>
    </form>
    <a href="./openapi.yaml">OpenAPI ↓</a>
  </header>
  <div id="redoc"></div>
  <script>${embeddedBundle}</script>
  <script>${runtime}</script>
</body>
</html>
`;
}

async function ensureEmptySiteDirectory() {
  if (
    siteOutputDirectory === parse(siteOutputDirectory).root ||
    siteOutputDirectory === repositoryRoot
  ) {
    throw new Error("Refusing to build the site into a broad directory.");
  }
  try {
    if (!(await stat(siteOutputDirectory)).isDirectory()) {
      throw new Error("The site output path must be a directory.");
    }
    if ((await readdir(siteOutputDirectory)).length > 0) {
      throw new Error("The site output directory must be empty.");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(siteOutputDirectory, { recursive: true });
      return;
    }
    throw error;
  }
}

async function copyWebsite() {
  const sourceDirectory = join(repositoryRoot, "website");
  for (const asset of websiteAssets) {
    await cp(join(sourceDirectory, asset), join(siteOutputDirectory, asset));
  }
  await cp(
    join(repositoryRoot, "openapi.yaml"),
    join(siteOutputDirectory, "openapi.yaml"),
  );
}

async function generateReference() {
  const packageManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  if (
    packageManifest.devDependencies?.["@redocly/cli"] !== REDOCLY_CLI_VERSION
  ) {
    throw new Error(
      `package.json must pin @redocly/cli ${REDOCLY_CLI_VERSION}.`,
    );
  }
  const redocly = join(
    repositoryRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "redocly.cmd" : "redocly",
  );
  const { stdout, stderr } = await execFileAsync(
    redocly,
    [
      "build-docs",
      "openapi.yaml",
      "--output",
      apiReferencePath,
      "--title",
      "HayaSend API Reference",
      "--disableGoogleFont",
      "--config",
      "redocly.yaml",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        REDOCLY_TELEMETRY: "off",
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (stdout.trim()) {
    process.stdout.write(stdout);
  }
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }
}

async function fetchPinnedRedocBundle() {
  const { stdout } = await execFileAsync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-redirs",
      "0",
      "--max-time",
      "30",
      "--max-filesize",
      "2000000",
      "--url",
      REDOC_BUNDLE_URL,
    ],
    {
      encoding: "buffer",
      maxBuffer: 2_000_001,
      timeout: 30_000,
    },
  );
  const bundle = Buffer.from(stdout);
  if (bundle.length < 500_000 || bundle.length > 2_000_000) {
    throw new Error("The pinned Redoc bundle has an unexpected size.");
  }
  return bundle;
}

export async function buildSite() {
  await ensureEmptySiteDirectory();
  await copyWebsite();
  await generateReference();
  const [generatedHtml, bundle] = await Promise.all([
    readFile(apiReferencePath, "utf8"),
    fetchPinnedRedocBundle(),
  ]);
  await writeFile(
    apiReferencePath,
    hardenApiReference(generatedHtml, bundle),
    "utf8",
  );
  return siteOutputDirectory;
}
