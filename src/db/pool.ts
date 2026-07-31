import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { logger } from "../logger";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    pool = new Pool({
      connectionString,
      // Railway private networking + SSL when connecting publicly
      ssl:
        process.env.NODE_ENV === "production" &&
        !connectionString.includes("localhost")
          ? { rejectUnauthorized: false }
          : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    pool.on("error", (err) => {
      logger.error("Unexpected PostgreSQL pool error", { error: err.message });
    });
  }

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
) {
  return getPool().query<T>(text, params);
}

/** Run fn on one dedicated connection (needed for session-scoped state). */
export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Run fn inside a transaction on a single connection. Rolls back on throw.
 * Use for multi-statement guards that must not interleave with another worker.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        logger.error("Rollback failed", { error: String(rollbackErr) });
      }
      throw err;
    }
  });
}

/**
 * Serialize fn across every process pointed at this database.
 * The web service and the graphic worker both run migrations on boot, so
 * without this they can race on the same CREATE/ALTER statements.
 */
export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [name]);
    try {
      return await fn();
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [name]);
      } catch (err) {
        logger.error("Failed to release advisory lock", {
          name,
          error: String(err),
        });
      }
    }
  });
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
