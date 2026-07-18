import { query } from "./pool";

export interface NewsletterPost {
  id: string;
  title: string;
  author_name: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

function mapPost(row: Record<string, unknown>): NewsletterPost {
  return {
    id: String(row.id),
    title: String(row.title),
    author_name: String(row.author_name),
    body: String(row.body),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

/** Public feed — newest first. */
export async function listNewsletterPosts(limit = 100): Promise<NewsletterPost[]> {
  const result = await query(
    `SELECT id, title, author_name, body, created_at, updated_at
     FROM newsletter_posts
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)]
  );
  return result.rows.map((row) => mapPost(row as Record<string, unknown>));
}

export async function createNewsletterPost(input: {
  title: string;
  author_name: string;
  body: string;
}): Promise<NewsletterPost> {
  const result = await query(
    `INSERT INTO newsletter_posts (title, author_name, body)
     VALUES ($1, $2, $3)
     RETURNING id, title, author_name, body, created_at, updated_at`,
    [input.title, input.author_name, input.body]
  );
  return mapPost(result.rows[0] as Record<string, unknown>);
}

export async function deleteNewsletterPost(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM newsletter_posts WHERE id = $1 RETURNING id`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}
