import "dotenv/config";
import { closePool, query } from "./pool";
import { logger } from "../logger";

/**
 * Creates the entries table if it does not exist.
 * Schema is automation-friendly: status + timestamps + UUID for polling.
 * Extra metadata lives in a JSONB column so you can extend without migrations.
 */
export async function migrate(): Promise<void> {
  await query(`
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    CREATE TABLE IF NOT EXISTS entries (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      real_name     TEXT NOT NULL,
      angel_name    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_entries_real_name
      ON entries (lower(real_name));

    CREATE INDEX IF NOT EXISTS idx_entries_angel_name
      ON entries (lower(angel_name));

    CREATE INDEX IF NOT EXISTS idx_entries_status
      ON entries (status);

    CREATE INDEX IF NOT EXISTS idx_entries_created_at
      ON entries (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_entries_pending
      ON entries (created_at ASC)
      WHERE status = 'pending';
  `);

  logger.info("Database migration complete");
}

async function runCli() {
  try {
    await migrate();
    logger.info("Migration finished successfully");
    await closePool();
    process.exit(0);
  } catch (err) {
    logger.error("Migration failed", { error: String(err) });
    await closePool();
    process.exit(1);
  }
}

if (require.main === module) {
  void runCli();
}
