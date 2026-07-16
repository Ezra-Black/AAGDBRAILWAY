import { query } from "./pool";

const NEWSLETTER_KEY = "newsletter_signups";

export async function getNewsletterCount(): Promise<number> {
  const result = await query(
    `SELECT value FROM site_stats WHERE key = $1 LIMIT 1`,
    [NEWSLETTER_KEY]
  );
  if (!result.rows[0]) return 55;
  return Number(result.rows[0].value) || 55;
}

/** Bump the public newsletter counter by 3–4. */
export async function bumpNewsletterCount(): Promise<{
  value: number;
  added: number;
}> {
  const added = Math.random() < 0.5 ? 3 : 4;
  const result = await query(
    `INSERT INTO site_stats (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = site_stats.value + $3,
           updated_at = NOW()
     RETURNING value`,
    [NEWSLETTER_KEY, 55 + added, added]
  );
  return {
    value: Number(result.rows[0].value),
    added,
  };
}

/**
 * Save a real mailing-list opt-in. Returns whether the email was newly added,
 * and bumps the public counter by 1 for genuine signups only.
 */
export async function subscribeNewsletter(
  email: string
): Promise<{ created: boolean; count: number }> {
  const insert = await query(
    `INSERT INTO newsletter_subscribers (email)
     VALUES ($1)
     ON CONFLICT ((lower(email))) DO NOTHING
     RETURNING id`,
    [email]
  );
  const created = (insert.rowCount ?? 0) > 0;

  if (created) {
    const bump = await query(
      `INSERT INTO site_stats (key, value, updated_at)
       VALUES ($1, 56, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = site_stats.value + 1,
             updated_at = NOW()
       RETURNING value`,
      [NEWSLETTER_KEY]
    );
    return { created, count: Number(bump.rows[0].value) };
  }

  return { created, count: await getNewsletterCount() };
}
