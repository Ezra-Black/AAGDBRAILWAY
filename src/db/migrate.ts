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
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_entries_archived
      ON entries (archived_at);

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

    -- Limited-time offers: expires_at is the vault deadline shown as a
    -- countdown on the newsletter page. vaulted_at is set when the offer
    -- closes (automatically or by an admin); vault_acknowledged drives the
    -- admin portal notification bell.
    ALTER TABLE graphic_options ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE graphic_options ADD COLUMN IF NOT EXISTS vaulted_at TIMESTAMPTZ;
    ALTER TABLE graphic_options
      ADD COLUMN IF NOT EXISTS vault_acknowledged BOOLEAN NOT NULL DEFAULT true;

    CREATE INDEX IF NOT EXISTS idx_graphic_options_active
      ON graphic_options (active, sort_order);

    CREATE INDEX IF NOT EXISTS idx_graphic_options_expires
      ON graphic_options (expires_at)
      WHERE vaulted_at IS NULL;

    -- Newsletter: blog-style posts written by admins for the public page.
    CREATE TABLE IF NOT EXISTS newsletter_posts (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title        TEXT NOT NULL,
      author_name  TEXT NOT NULL,
      body         TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_newsletter_posts_created_at
      ON newsletter_posts (created_at DESC);

    -- ── Site users (customers) ─────────────────────────────────────
    -- Separate from admins: these are visitors who register to track
    -- their graphic requests and shop orders. angel_name is the custom
    -- name for their deceased loved one used on graphics.
    CREATE TABLE IF NOT EXISTS users (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email              TEXT NOT NULL UNIQUE,
      password_hash      TEXT NOT NULL,
      name               TEXT NOT NULL,
      angel_name         TEXT,
      profile_photo_url  TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_users_email
      ON users (lower(email));

    -- DB-backed sessions (opaque random token, only its SHA-256 stored).
    CREATE TABLE IF NOT EXISTS user_sessions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_token
      ON user_sessions (token_hash);

    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires
      ON user_sessions (expires_at);

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user
      ON user_sessions (user_id);

    -- Single-use, short-lived password reset tokens (hash only).
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
      ON password_reset_tokens (user_id);

    -- Link requests and orders to the account that made them (when logged
    -- in), so the profile portal can show a user's activity.
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_entries_user
      ON entries (user_id)
      WHERE user_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_purchases_user
      ON purchases (user_id)
      WHERE user_id IS NOT NULL;

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
      image_url   TEXT,
      active      BOOLEAN NOT NULL DEFAULT true,
      sort_order  INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE archive_graphics
      ADD COLUMN IF NOT EXISTS image_url TEXT;

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
                                CHECK (status IN ('pending', 'paid', 'failed', 'delivered')),
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

    -- Existing DBs may still have the old CHECK without 'delivered'.
    ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_status_check;
    ALTER TABLE purchases
      ADD CONSTRAINT purchases_status_check
      CHECK (status IN ('pending', 'paid', 'failed', 'delivered'));

    CREATE INDEX IF NOT EXISTS idx_purchases_created_at
      ON purchases (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_purchases_status
      ON purchases (status);

    CREATE INDEX IF NOT EXISTS idx_purchases_archived
      ON purchases (archived_at);
  `);

  // Keep the archive in sync: any option currently offered (or offered at any
  // boot since this feature shipped) is recorded forever.
  await query(`
    INSERT INTO archive_graphics (code, label, sort_order)
    SELECT code, label, COALESCE(sort_order, 0)
    FROM graphic_options go
    WHERE code IS NOT NULL AND trim(code) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM archive_graphics ag
        WHERE lower(trim(ag.label)) = lower(trim(go.label))
      )
    ON CONFLICT (code) DO NOTHING
  `);

  // Archive-only designs: sold in the shop but never on the request form.
  await query(`
    INSERT INTO archive_graphics (code, label, image_url, active, sort_order)
    VALUES (
      'fairy-ring',
      'Fairy Ring',
      '/assets/shop/fairy-ring.jpg',
      true,
      0
    )
    ON CONFLICT (code) DO UPDATE
      SET label = EXCLUDED.label,
          image_url = EXCLUDED.image_url,
          active = true
  `);

  // Hide label duplicates (e.g. a hand-added "Fairy Ring" without an image)
  // so the shop dropdown only shows the canonical entry with artwork.
  await query(`
    UPDATE archive_graphics a
    SET active = false
    FROM archive_graphics b
    WHERE a.id <> b.id
      AND lower(trim(a.label)) = lower(trim(b.label))
      AND b.image_url IS NOT NULL
      AND a.image_url IS NULL
      AND COALESCE(a.active, true) = true
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
