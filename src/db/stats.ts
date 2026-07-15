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
