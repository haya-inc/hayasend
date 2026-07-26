import {
  access,
  readdir,
  readFile,
} from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return markdownFiles(path);
      }
      return extname(path) === ".md" ? [path] : [];
    }),
  );
  return files.flat();
}

function localLinkTarget(markdownFile: string, rawTarget: string) {
  const target = rawTarget.startsWith("<") && rawTarget.endsWith(">")
    ? rawTarget.slice(1, -1)
    : rawTarget;
  if (
    target.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    return undefined;
  }
  const withoutFragment = target.split("#", 1)[0]?.split("?", 1)[0];
  if (!withoutFragment) {
    return undefined;
  }
  const decoded = decodeURIComponent(withoutFragment);
  return isAbsolute(decoded)
    ? resolve(decoded)
    : resolve(dirname(markdownFile), decoded);
}

describe("project documentation", () => {
  it("keeps every repository-local Markdown link resolvable", async () => {
    const rootFiles = (await readdir(repositoryRoot))
      .filter((name) => extname(name) === ".md")
      .map((name) => join(repositoryRoot, name));
    const files = [
      ...rootFiles,
      ...(await markdownFiles(join(repositoryRoot, "docs"))),
    ];
    const failures: string[] = [];

    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      for (const match of markdown.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const rawTarget = match[1];
        if (!rawTarget) {
          continue;
        }
        let target: string | undefined;
        try {
          target = localLinkTarget(file, rawTarget);
        } catch {
          failures.push(
            `${relative(repositoryRoot, file)} -> invalid URL encoding: ${rawTarget}`,
          );
          continue;
        }
        if (!target) {
          continue;
        }
        const pathWithinRepository = relative(repositoryRoot, target);
        if (
          pathWithinRepository === ".." ||
          pathWithinRepository.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        ) {
          failures.push(
            `${relative(repositoryRoot, file)} -> outside repository: ${rawTarget}`,
          );
          continue;
        }
        try {
          await access(target);
        } catch {
          failures.push(
            `${relative(repositoryRoot, file)} -> missing: ${rawTarget}`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps automatic routing behind its documented approval boundary", async () => {
    const [design, receiving, roadmap] = await Promise.all([
      readFile(join(repositoryRoot, "docs/inbound-routing-design.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/inbound-receiving.md"), "utf8"),
      readFile(join(repositoryRoot, "ROADMAP.md"), "utf8"),
    ]);

    expect(design).toContain(
      "Status: **Proposed — no runtime routing may ship before maintainer approval**",
    );
    for (const section of [
      "## Authorization and ownership",
      "## Routing identity readiness",
      "## Matching and dry-run evaluation",
      "## Authentication policy",
      "## ARC policy",
      "## Loop and duplicate controls",
      "## Suppression, failure, and recovery",
      "## Privacy and retention",
      "## Adversarial test matrix",
      "## Delivery stages and approval gates",
      "## Rollback and operator recovery",
    ]) {
      expect(design).toContain(section);
    }
    expect(receiving).toContain(
      "[inbound alias routing design](inbound-routing-design.md)",
    );
    expect(receiving).toContain("It is documentation only");
    expect(roadmap).toContain(
      "[alias routing and catch-all rules](docs/inbound-routing-design.md)",
    );
  });
});
