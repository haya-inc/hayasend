import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { HAYASEND_VERSION } from "../src/version.js";

const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("project site", () => {
  it("ships only local runtime assets and a restrictive policy", async () => {
    const html = await read("website/index.html");

    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('href="./styles.css"');
    expect(html).toContain('src="./app.js"');
    expect(html).not.toMatch(/src="https:\/\//);
    expect(html).not.toContain('target="_blank"');
  });

  it("provides essential metadata, navigation, and copy feedback", async () => {
    const html = await read("website/index.html");

    expect(html).toContain("<title>HayaSend");
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('<main id="main">');
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('href="./api-reference.html"');
    expect(html).toContain('href="./openapi.yaml"');
    expect(html).toContain(
      "https://github.com/haya-inc/hayasend/blob/main/docs/aws-costs.md",
    );
  });

  it("keeps public URLs and the Pages artifact aligned", async () => {
    const [index, notFound, robots, sitemap, workflow] = await Promise.all([
      read("website/index.html"),
      read("website/404.html"),
      read("website/robots.txt"),
      read("website/sitemap.xml"),
      read(".github/workflows/pages.yml"),
    ]);
    const siteUrl = "https://hayasend.com/";

    expect(index).toContain(siteUrl);
    expect(index).toContain(
      "This site tracks <code>main</code> and may describe unreleased changes.",
    );
    expect(index).toContain(
      `href="https://github.com/haya-inc/hayasend/releases/tag/v${HAYASEND_VERSION}"`,
    );
    expect(index).toContain(
      `npx --yes @haya-inc/hayasend@${HAYASEND_VERSION} init`,
    );
    expect(notFound).toContain('href="/styles.css"');
    expect(notFound).toContain('href="/"');
    expect(robots).toContain(`${siteUrl}sitemap.xml`);
    expect(sitemap).toContain(`<loc>${siteUrl}</loc>`);
    expect(sitemap).toContain(`<loc>${siteUrl}api-reference.html</loc>`);
    expect(workflow).toContain("npm run site:build");
    expect(workflow).toContain("npm run site:verify");
    expect(workflow).toContain("path: dist/site");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/configure-pages@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/upload-pages-artifact@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/deploy-pages@[0-9a-f]{40}/);
    expect(await read("website/CNAME")).toBe("hayasend.com\n");
  });
});
