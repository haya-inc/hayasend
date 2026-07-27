import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function npmPackageIntegrity(archive) {
  return `sha512-${createHash("sha512").update(archive).digest("base64")}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const archive = Buffer.concat(chunks);
  if (archive.length === 0) {
    process.stderr.write("Usage: npm-package-integrity.mjs < ARCHIVE\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`${npmPackageIntegrity(archive)}\n`);
  }
}
