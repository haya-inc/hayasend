import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const migrationsPath = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: "2026-07-27",
        d1Databases: ["TEST_DB"],
        r2Buckets: ["TEST_BUCKET", "TEST_TARGET_BUCKET"],
        queueProducers: ["TEST_QUEUE"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
        },
      },
    })),
  ],
  test: {
    include: ["tests/cloudflare/**/*.test.ts"],
  },
});
