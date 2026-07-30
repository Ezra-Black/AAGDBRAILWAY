import "dotenv/config";
import bcrypt from "bcryptjs";
import { closePool, query, withTransaction } from "./pool";
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

    -- Pipeline bookkeeping. version is compared-and-set on every worker
    -- transition, so a claim made before a requeue can never overwrite the
    -- newer state. attempt_count / next_retry_at drive capped backoff.
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

    -- Delivery is split so a retry can tell which half already happened:
    --   validated = graphic generated and stored, nothing emailed yet
    --   applied   = the email was handed to SMTP, outcome not yet confirmed
    --   processed = delivery confirmed (kept as the final state name)
    --   escalated = automation stopped on purpose, a person must look
    -- Drop by definition, not by name: a database whose constraint was created
    -- under a different name would otherwise keep the old narrow rule and
    -- reject every new status at runtime instead of here.
    DO $status_check$
    DECLARE existing TEXT;
    BEGIN
      FOR existing IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'entries'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      LOOP
        EXECUTE format('ALTER TABLE entries DROP CONSTRAINT %I', existing);
      END LOOP;
    END
    $status_check$;

    ALTER TABLE entries
      ADD CONSTRAINT entries_status_check
      CHECK (status IN (
        'pending', 'processing', 'validated', 'applied',
        'processed', 'failed', 'escalated'
      ));

    CREATE INDEX IF NOT EXISTS idx_entries_validated
      ON entries (created_at ASC)
      WHERE status = 'validated';

    CREATE INDEX IF NOT EXISTS idx_entries_retry_ready
      ON entries (next_retry_at)
      WHERE status = 'failed' AND next_retry_at IS NOT NULL;

    -- One row per customer delivery intent, written BEFORE the email is
    -- handed to SMTP. The unique key means a second attempt for the same
    -- intent is refused by Postgres rather than by application logic, so an
    -- interrupted or timed-out send can never look like it never happened.
    --   attempted = handed to SMTP, outcome unknown (never auto-retried)
    --   sent      = SMTP accepted the message
    --   not_sent  = proven never sent (bad auth, bad recipient, no connection)
    CREATE TABLE IF NOT EXISTS graphic_deliveries (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      idempotency_key  TEXT NOT NULL UNIQUE,
      entry_id         UUID REFERENCES entries(id) ON DELETE SET NULL,
      state            TEXT NOT NULL DEFAULT 'attempted'
                       CHECK (state IN ('attempted', 'sent', 'not_sent')),
      attempt_count    INT NOT NULL DEFAULT 1,
      last_error       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_graphic_deliveries_entry
      ON graphic_deliveries (entry_id);

    -- Append-only audit so "where did this stop, and why" is answerable from
    -- the database alone, without reading worker logs.
    CREATE TABLE IF NOT EXISTS entry_transitions (
      id           BIGSERIAL PRIMARY KEY,
      entry_id     UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      version      INT NOT NULL DEFAULT 1,
      from_status  TEXT,
      to_status    TEXT NOT NULL,
      actor        TEXT NOT NULL DEFAULT 'system',
      reason       TEXT,
      at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_entry_transitions_entry
      ON entry_transitions (entry_id, at DESC);

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

    -- When true, the request form requires a customer jpg/png upload.
    ALTER TABLE graphic_options
      ADD COLUMN IF NOT EXISTS requires_photo BOOLEAN NOT NULL DEFAULT false;

    -- Separate photo blobs: generated (worker) vs customer (form upload).
    -- Stored in Postgres so the web admin can download even when the worker
    -- runs as a different Railway service / volume.
    CREATE TABLE IF NOT EXISTS entry_photos (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entry_id           UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      kind               TEXT NOT NULL
                         CHECK (kind IN ('generated', 'customer')),
      content_type       TEXT NOT NULL,
      original_filename  TEXT,
      bytes              BYTEA NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entry_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_entry_photos_entry_id
      ON entry_photos (entry_id);

    -- Simple key/value site settings (admin kill switches, etc.)
    CREATE TABLE IF NOT EXISTS site_settings (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL DEFAULT 'null'::jsonb,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO site_settings (key, value)
    VALUES ('ai_worker_enabled', 'true'::jsonb)
    ON CONFLICT (key) DO NOTHING;

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

    -- Logged-in emoji reactions on newsletter posts (love / angel / thumbs_up).
    CREATE TABLE IF NOT EXISTS newsletter_post_reactions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id     UUID NOT NULL REFERENCES newsletter_posts(id) ON DELETE CASCADE,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji       TEXT NOT NULL CHECK (emoji IN ('love', 'angel', 'thumbs_up')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (post_id, user_id, emoji)
    );

    CREATE INDEX IF NOT EXISTS idx_newsletter_reactions_post
      ON newsletter_post_reactions (post_id);

    CREATE INDEX IF NOT EXISTS idx_newsletter_reactions_user
      ON newsletter_post_reactions (user_id);

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

    ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
    ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_contact_messages_unread
      ON contact_messages (created_at DESC)
      WHERE read_at IS NULL AND archived_at IS NULL;

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

  // Log every status change from any code path (worker, admin portal, API),
  // not just the ones that remember to write an audit row.
  await query(`
    CREATE OR REPLACE FUNCTION entries_log_transition() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO entry_transitions (
          entry_id, version, from_status, to_status, actor, reason
        ) VALUES (
          NEW.id,
          NEW.version,
          OLD.status,
          NEW.status,
          COALESCE(NULLIF(current_setting('aagdb.actor', true), ''), 'system'),
          NULLIF(current_setting('aagdb.reason', true), '')
        );
      END IF;
      RETURN NEW;
    END;
    $fn$;

    DROP TRIGGER IF EXISTS trg_entries_log_transition ON entries;
    CREATE TRIGGER trg_entries_log_transition
    AFTER UPDATE OF status ON entries
    FOR EACH ROW EXECUTE FUNCTION entries_log_transition();
  `);

  await sweepPreEbflowInFlight();

  // Link requests and orders to the account that made them (when logged in),
  // so the profile portal can show a user's activity. Runs after the main
  // block because it references both users and purchases.
  await query(`
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_entries_user
      ON entries (user_id)
      WHERE user_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_purchases_user
      ON purchases (user_id)
      WHERE user_id IS NOT NULL;
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

  // Cover Photo / Celestial Angel — on the request form and in the archive shop.
  await query(`
    INSERT INTO graphic_options (code, label, active, sort_order)
    VALUES ('cover-photo', 'Celestial Angel', true, 1)
    ON CONFLICT (code) DO UPDATE
      SET label = EXCLUDED.label,
          active = true
  `);

  await query(`
    INSERT INTO archive_graphics (code, label, image_url, active, sort_order)
    VALUES (
      'cover-photo',
      'Celestial Angel',
      '/assets/shop/coverphoto.jpg',
      true,
      1
    )
    ON CONFLICT (code) DO UPDATE
      SET label = EXCLUDED.label,
          image_url = EXCLUDED.image_url,
          active = true
  `);

  // Pastel Heaven — on the request form and in the archive shop.
  await query(`
    INSERT INTO graphic_options (code, label, active, sort_order)
    VALUES ('pastel-heaven', 'Pastel Heaven', true, 2)
    ON CONFLICT (code) DO UPDATE
      SET label = EXCLUDED.label,
          active = true
  `);

  await query(`
    INSERT INTO archive_graphics (code, label, image_url, active, sort_order)
    VALUES (
      'pastel-heaven',
      'Pastel Heaven',
      '/assets/shop/pastelheaven.jpg',
      true,
      2
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

/**
 * One-time hand-off for requests that were mid-flight when the split states
 * shipped. Under the old single 'processing' state we cannot tell whether the
 * customer email already went out, so these go to a person instead of being
 * retried. Gated on a settings flag: a normal restart must never touch rows
 * the worker is actively holding.
 */
async function sweepPreEbflowInFlight(): Promise<void> {
  const done = await query(
    `SELECT 1 FROM site_settings WHERE key = 'ebflow_pipeline_v1'`
  );
  if (done.rowCount) return;

  const swept = await withTransaction(async (client) => {
    await client.query(
      `SELECT set_config('aagdb.actor', 'migration:ebflow_v1', true),
              set_config('aagdb.reason', 'in flight when delivery states split; outcome unknown', true)`
    );
    return client.query(
      `UPDATE entries
       SET status = 'escalated',
           updated_at = NOW(),
           metadata = metadata || jsonb_build_object(
             'escalated_at', NOW()::text,
             'escalation_reason', 'in_flight_before_split_delivery_states',
             'note', 'Cannot confirm whether the delivery email was sent. Check the customer inbox, then resend or mark complete.',
             'failure_acked', 'false'
           )
       WHERE status = 'processing'
         AND archived_at IS NULL`
    );
  });

  await query(
    `INSERT INTO site_settings (key, value)
     VALUES ('ebflow_pipeline_v1', 'true'::jsonb)
     ON CONFLICT (key) DO NOTHING`
  );

  if (swept.rowCount) {
    logger.warn("Escalated pre-split in-flight requests for manual review", {
      count: swept.rowCount,
    });
  }
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
