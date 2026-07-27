import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const portableRoots = [
  "src/core",
  "src/ports",
  "src/services",
  "src/workers",
];
const portableFiles = ["src/app.ts", "src/schemas.ts", "src/version.ts"];
const forbiddenModulePrefixes = [
  "node:",
  "@aws-sdk/",
  "@hono/node-server",
];
const forbiddenModuleSegments = [
  "/adapters/",
  "../adapters/",
  "/aws/",
  "../aws/",
  "/config",
  "../config",
  "/runtime",
  "../runtime",
];

async function sourceFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(candidate)));
    } else if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name)) {
      files.push(candidate);
    }
  }
  return files;
}

function importedModules(source) {
  const modules = [];
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) {
      modules.push(match[1]);
    }
  }
  return modules;
}

export async function collectWorkersBoundaryViolations(projectRoot) {
  const files = [];
  for (const root of portableRoots) {
    files.push(...(await sourceFiles(resolve(projectRoot, root))));
  }
  files.push(...portableFiles.map((file) => resolve(projectRoot, file)));

  const violations = [];
  for (const file of files.sort()) {
    const source = await readFile(file, "utf8");
    for (const moduleName of importedModules(source)) {
      if (
        forbiddenModulePrefixes.some((prefix) =>
          moduleName.startsWith(prefix),
        ) ||
        forbiddenModuleSegments.some((segment) =>
          moduleName.includes(segment),
        )
      ) {
        violations.push(
          `${relative(projectRoot, file)} imports forbidden module ${JSON.stringify(moduleName)}`,
        );
      }
    }
    for (const pattern of [
      { label: "Buffer", expression: /\bBuffer\s*\./u },
      { label: "process", expression: /\bprocess\s*\./u },
      { label: "CommonJS require", expression: /\brequire\s*\(/u },
    ]) {
      if (pattern.expression.test(source)) {
        violations.push(
          `${relative(projectRoot, file)} uses forbidden ${pattern.label} global`,
        );
      }
    }
  }
  return violations;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const projectRoot = resolve(dirname(scriptPath), "..");
  const violations = await collectWorkersBoundaryViolations(projectRoot);
  if (violations.length > 0) {
    console.error(
      [
        "Cloudflare Workers portability boundary failed:",
        ...violations.map((violation) => `- ${violation}`),
      ].join("\n"),
    );
    process.exitCode = 1;
  } else {
    console.log(
      "Cloudflare Workers portability boundary passed: no Node, AWS, or runtime-adapter imports in portable sources.",
    );
  }
}
