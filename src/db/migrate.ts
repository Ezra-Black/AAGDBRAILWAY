import "dotenv/config";
import bcrypt from "bcryptjs";
import { closePool, query } from "./pool";
import { logger } from "../logger";

const SEED_ADMIN_EMAIL = "allaudrey22@gmail.com";
const SEED_ADMIN_PASSWORD = "EzraIsAwesome1!";

/**
 * Creates / extends schema. Safe to re-run on every boot.
 * graphic_options feeds the request-form dropdown (managed in DB, not seeded here).
 * admins table holds login accounts (password hashes only).
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

    CREATE TABLE IF NOT EXISTS admins (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_admins_email
      ON admins (lower(email));

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id    UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_token
      ON admin_sessions (token_hash);

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
      ON admin_sessions (expires_at);
  `);

  // Repair common manual-insert issues so the dropdown can see rows
  await query(`
    UPDATE graphic_options
    SET active = true
    WHERE active IS NULL
  `);

  await query(`
    UPDATE graphic_options AS g
    SET code = trim(g.label)
    WHERE (g.code IS NULL OR trim(g.code) = '')
      AND g.label IS NOT NULL
      AND trim(g.label) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM graphic_options AS x
        WHERE lower(trim(x.code)) = lower(trim(g.label))
          AND x.id <> g.id
      )
  `);

  const passwordHash = await bcrypt.hash(SEED_ADMIN_PASSWORD, 12);
  await query(
    `INSERT INTO admins (email, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [SEED_ADMIN_EMAIL, passwordHash]
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
