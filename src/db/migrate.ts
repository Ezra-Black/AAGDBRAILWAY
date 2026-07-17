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

    CREATE TABLE IF NOT EXISTS site_stats (
      key         TEXT PRIMARY KEY,
      value       BIGINT NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email       TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_subscribers_email
      ON newsletter_subscribers (lower(email));

    CREATE TABLE IF NOT EXISTS contact_messages (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      message     TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
      ON contact_messages (created_at DESC);

    CREATE TABLE IF NOT EXISTS facebook_users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      fb_user_id    TEXT NOT NULL UNIQUE,
      name          TEXT,
      email         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_facebook_users_email
      ON facebook_users (lower(email));

    -- Privacy-friendly first-party analytics: no IPs, no PII.
    -- visitor_key is a salted hash of a random client-generated id.
    CREATE TABLE IF NOT EXISTS page_views (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      visitor_key    TEXT NOT NULL,
      path           TEXT NOT NULL,
      referrer_host  TEXT,
      device         TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_page_views_created_at
      ON page_views (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_page_views_visitor
      ON page_views (visitor_key, created_at);

    CREATE INDEX IF NOT EXISTS idx_page_views_path
      ON page_views (path);

    -- The Archive: every graphic option ever offered (past and present).
    -- Options removed from the request-form dropdown live on here, so the
    -- shop can sell them as $5 archive graphics.
    CREATE TABLE IF NOT EXISTS archive_graphics (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code        TEXT NOT NULL UNIQUE,
      label       TEXT NOT NULL,
      active      BOOLEAN NOT NULL DEFAULT true,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_archive_graphics_active
      ON archive_graphics (active, sort_order);

    CREATE TABLE IF NOT EXISTS purchases (
      id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      angel_name                TEXT NOT NULL,
      real_name                 TEXT NOT NULL,
      email                     TEXT NOT NULL,
      graphic_code              TEXT NOT NULL,
      note                      TEXT,
      amount_cents              INT NOT NULL,
      currency                  TEXT NOT NULL DEFAULT 'usd',
      stripe_payment_intent_id  TEXT UNIQUE,
      status                    TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'paid', 'failed')),
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_purchases_created_at
      ON purchases (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_purchases_status
      ON purchases (status);
  `);

  // Keep the archive in sync: any option currently offered (or offered at any
  // boot since this feature shipped) is recorded forever.
  await query(`
    INSERT INTO archive_graphics (code, label, sort_order)
    SELECT code, label, COALESCE(sort_order, 0)
    FROM graphic_options
    WHERE code IS NOT NULL AND trim(code) <> ''
    ON CONFLICT (code) DO NOTHING
  `);

  await query(
    `INSERT INTO site_stats (key, value)
     VALUES ('newsletter_signups', 55)
     ON CONFLICT (key) DO NOTHING`
  );

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
