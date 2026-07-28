import { Pool } from "pg";
import type { Config } from "../../config.js";

export function createPostgresPool(
  config: Config,
  applicationName: string,
): Pool {
  if (
    config.mode !== "portable" ||
    !config.databaseUrl ||
    config.postgresPoolMax === undefined ||
    config.postgresIdleTimeoutMs === undefined ||
    config.postgresConnectionTimeoutMs === undefined ||
    config.postgresMaxLifetimeSeconds === undefined
  ) {
    throw new Error("Portable PostgreSQL settings are incomplete.");
  }
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.postgresPoolMax,
    idleTimeoutMillis: config.postgresIdleTimeoutMs,
    connectionTimeoutMillis: config.postgresConnectionTimeoutMs,
    maxLifetimeSeconds: config.postgresMaxLifetimeSeconds,
    application_name: applicationName,
  });
}

export async function assertPostgresReady(pool: Pool): Promise<void> {
  const result = await pool.query<{
    delivery: string | null;
    application_store: string | null;
    jobs: string | null;
  }>(
    `SELECT
       to_regclass('public.delivery_messages')::text AS delivery,
       to_regclass('public.app_entities')::text AS application_store,
       to_regclass('public.jobs')::text AS jobs`,
  );
  const row = result.rows[0];
  if (!row?.delivery || !row.application_store || !row.jobs) {
    throw new Error(
      "HayaSend PostgreSQL migrations are incomplete; run the migration process before starting.",
    );
  }
}
