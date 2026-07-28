import { fileURLToPath } from "node:url";
import { migratePostgres } from "../adapters/postgres/postgres-migrations.js";
import { createPostgresPool } from "../adapters/postgres/postgres-pool.js";
import { loadConfig } from "../config.js";
import { safeErrorCategory } from "../core/error-telemetry.js";

export async function runPortableMigrations(): Promise<void> {
  const config = loadConfig();
  if (config.mode !== "portable") {
    throw new Error("PostgreSQL migrations require HAYASEND_MODE=portable.");
  }
  const pool = createPostgresPool(config, "hayasend-migrate");
  try {
    await migratePostgres(pool);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPortableMigrations()
    .then(() => {
      console.info(
        JSON.stringify({
          level: "info",
          message: "HayaSend PostgreSQL migrations complete",
        }),
      );
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          message: "HayaSend PostgreSQL migrations failed",
          error_type: safeErrorCategory(error),
        }),
      );
      process.exitCode = 1;
    });
}
