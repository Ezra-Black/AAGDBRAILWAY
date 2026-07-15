import "dotenv/config";
import { closePool, query } from "./pool";
import { logger } from "../logger";

/**
 * Creates / extends schema. Safe to re-run on every boot.
 * graphic_options feeds the request-form dropdown; seed a few test codes.
 */
export async function migrate(): Promise<void> {
  await query(`
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    CREATE TABLE IF NOT EXISTS entries (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      real_name     TEXT NOT NULL,
      angel_name    TEXT NOT NULL,
      email         TEXT,
      graphic_code  TEXT,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    ALTER TABLE entries ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS graphic_code TEXT;

    CREATE INDEX IF NOT EXISTS idx_entries_real_name
      ON entries (lower(real_name));

    CREATE INDEX IF NOT EXISTS idx_entries_angel_name
      ON entries (lower(angel_name));

    CREATE INDEX IF NOT EXISTS idx_entries_email
      ON entries (lower(email));

    CREATE INDEX IF NOT EXISTS idx_entries_graphic_code
      ON entries (graphic_code);

    CREATE INDEX IF NOT EXISTS idx_entries_status
      ON entries (status);

    CREATE INDEX IF NOT EXISTS idx_entries_created_at
      ON entries (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_entries_pending
      ON entries (created_at ASC)
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS graphic_options (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code        TEXT NOT NULL UNIQUE,
      label       TEXT NOT NULL,
      active      BOOLEAN NOT NULL DEFAULT true,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_graphic_options_active
      ON graphic_options (active, sort_order);
  `);

  await query(
    `INSERT INTO graphic_options (code, label, active, sort_order)
     VALUES
       ($1, $2, true, 1),
       ($3, $4, true, 2),
       ($5, $6, true, 3)
     ON CONFLICT (code) DO NOTHING`,
    [
      "graphic1",
      "Golden Halo Portrait",
      "graphic2",
      "Winged Silhouette",
      "a7k9xm",
      "Celestial Burst (Test Code)",
    ]
  );

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
