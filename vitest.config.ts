import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "tests/cloudflare/**",
      "node_modules/**",
      "dist/**",
      ".aws-sam/**",
    ],
    coverage: {
      reporter: ["text", "json-summary"],
    },
    environment: "node",
  },
});
