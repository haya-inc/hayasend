import { readFile } from "node:fs/promises";
import { CONFORMANCE_ARTIFACTS } from "./conformance-artifacts.js";

function canonicalJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const requestedArtifact = process.argv[2];
if (requestedArtifact) {
  const artifact = CONFORMANCE_ARTIFACTS[requestedArtifact];
  if (artifact === undefined) {
    throw new Error(`Unknown conformance artifact: ${requestedArtifact}.`);
  }
  process.stdout.write(canonicalJson(artifact));
} else {
  const stale: string[] = [];
  for (const [path, expected] of Object.entries(CONFORMANCE_ARTIFACTS)) {
    let actual: string;
    try {
      actual = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    } catch {
      stale.push(path);
      continue;
    }
    if (actual !== canonicalJson(expected)) {
      stale.push(path);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Generated conformance artifacts are missing or stale: ${stale.join(", ")}.`,
    );
  }
}
