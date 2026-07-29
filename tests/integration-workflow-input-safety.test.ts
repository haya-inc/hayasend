import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function directInputExpressionsInRunBlocks(workflow: string): string[] {
  const findings: string[] = [];
  const lines = workflow.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const block = /^(\s*)run:\s*[|>][-+]?\s*$/.exec(line);
    if (!block) {
      if (/^\s*run:.*\$\{\{\s*inputs\./.test(line)) {
        findings.push(line.trim());
      }
      continue;
    }

    const runIndent = block[1]?.length ?? 0;
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const bodyLine = lines[bodyIndex] ?? "";
      if (bodyLine.trim() === "") {
        continue;
      }
      const bodyIndent = /^\s*/.exec(bodyLine)?.[0].length ?? 0;
      if (bodyIndent <= runIndent) {
        break;
      }
      if (bodyLine.includes("${{ inputs.")) {
        findings.push(bodyLine.trim());
      }
    }
  }

  return findings;
}

describe("integration workflow dispatch-input safety", () => {
  it("passes untrusted workflow_dispatch values through step env", async () => {
    const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
    const workflowNames = (await readdir(workflowDirectory)).filter(
      (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
    );

    const findings = (
      await Promise.all(
        workflowNames.map(async (name) => {
          const workflow = await readFile(
            new URL(name, workflowDirectory),
            "utf8",
          );
          return directInputExpressionsInRunBlocks(workflow).map(
            (line) => `${name}: ${line}`,
          );
        }),
      )
    ).flat();

    expect(findings).toEqual([]);
  });
});
