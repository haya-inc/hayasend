import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("hosted integration workflow revision safety", () => {
  it("requires every billable integration workflow to run from protected main", async () => {
    const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
    const workflowNames = (await readdir(workflowDirectory)).filter((name) =>
      name.endsWith("-integration.yml"),
    );

    const missing = (
      await Promise.all(
        workflowNames.map(async (name) => {
          const workflow = await readFile(
            new URL(name, workflowDirectory),
            "utf8",
          );
          const hasMainGuard = workflow.includes(
            '"$GITHUB_REF" != "refs/heads/main"',
          );
          const hasProtectionGuard = workflow.includes(
            '"${GITHUB_REF_PROTECTED:-false}" != "true"',
          );
          return hasMainGuard && hasProtectionGuard ? [] : [name];
        }),
      )
    ).flat();

    expect(missing).toEqual([]);
  });
});
