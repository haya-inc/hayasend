import { buildSite } from "./api-reference.mjs";

buildSite()
  .then((output) => {
    process.stdout.write(
      `${JSON.stringify({ ok: true, output, reference: "api-reference.html" })}\n`,
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
