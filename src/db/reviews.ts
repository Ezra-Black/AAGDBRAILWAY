import { query } from "./pool";

export type ReviewStatus = "pending" | "approved" | "rejected";
export type ReviewSource = "shop" | "form" | "reviews_page";

export interface Review {
  id: string;
  user_id: string;
  rating: number;
  body: string;
  display_name: string;
  is_anonymous: boolean;
  source: ReviewSource;
  status: ReviewStatus;
  created_at: Date;
  moderated_at: Date | null;
  moderated_by: string | null;
  profile_photo_url?: string | null;
  user_email?: string | null;
  user_name?: string | null;
}

/** Public-safe shape for the reviews page. */
export interface PublicReview {
  id: string;
  rating: number;
  body: string;
  display_name: string;
  profile_photo_url: string | null;
  created_at: Date;
}

function mapReview(row: Record<string, unknown>): Review {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    rating: Number(row.rating),
    body: row.body as string,
    display_name: row.display_name as string,
    is_anonymous: Boolean(row.is_anonymous),
    source: row.source as ReviewSource,
    status: row.status as ReviewStatus,
    created_at: row.created_at as Date,
    moderated_at: (row.moderated_at as Date) ?? null,
    moderated_by: (row.moderated_by as string) ?? null,
    profile_photo_url:
      row.profile_photo_url !== undefined
        ? ((row.profile_photo_url as string) ?? null)
        : undefined,
    user_email:
      row.user_email !== undefined
        ? ((row.user_email as string) ?? null)
        : undefined,
    user_name:
      row.user_name !== undefined
        ? ((row.user_name as string) ?? null)
        : undefined,
  };
}

export async function createReview(input: {
  user_id: string;
  rating: number;
  body: string;
  display_name: string;
  is_anonymous: boolean;
  source: ReviewSource;
}): Promise<Review> {
  const result = await query(
    `INSERT INTO reviews (
       user_id, rating, body, display_name, is_anonymous, source
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.user_id,
      input.rating,
      input.body,
      input.display_name,
      input.is_anonymous,
      input.source,
    ]
  );
  return mapReview(result.rows[0]);
}

/** Approved reviews for the public page — never expose user_id/email. */
export async function listApprovedReviews(
  limit = 100
): Promise<PublicReview[]> {
  const result = await query(
    `SELECT r.id, r.rating, r.body, r.display_name, r.is_anonymous,
            r.created_at, u.profile_photo_url
     FROM reviews r
     JOIN users u ON u.id = r.user_id
     WHERE r.status = 'approved'
     ORDER BY r.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => {
    const anonymous = Boolean(row.is_anonymous);
    return {
      id: row.id as string,
      rating: Number(row.rating),
      body: row.body as string,
      display_name: anonymous
        ? "Anonymous"
        : (row.display_name as string),
      profile_photo_url: anonymous
        ? null
        : ((row.profile_photo_url as string) ?? null),
      created_at: row.created_at as Date,
    };
  });
}

export async function listReviewsForAdmin(options?: {
  status?: ReviewStatus;
  limit?: number;
}): Promise<Review[]> {
  const limit = options?.limit ?? 200;
  const status = options?.status;
  const result = status
    ? await query(
        `SELECT r.*, u.email AS user_email, u.name AS user_name,
                u.profile_photo_url
         FROM reviews r
         JOIN users u ON u.id = r.user_id
         WHERE r.status = $1
         ORDER BY r.created_at DESC
         LIMIT $2`,
        [status, limit]
      )
    : await query(
        `SELECT r.*, u.email AS user_email, u.name AS user_name,
                u.profile_photo_url
         FROM reviews r
         JOIN users u ON u.id = r.user_id
         ORDER BY
           CASE r.status
             WHEN 'pending' THEN 0
             WHEN 'approved' THEN 1
             ELSE 2
           END,
           r.created_at DESC
         LIMIT $1`,
        [limit]
      );
  return result.rows.map(mapReview);
}

export async function getReviewById(id: string): Promise<Review | null> {
  const result = await query(`SELECT * FROM reviews WHERE id = $1 LIMIT 1`, [
    id,
  ]);
  return result.rows[0] ? mapReview(result.rows[0]) : null;
}

export async function setReviewStatus(input: {
  id: string;
  status: ReviewStatus;
  admin_id: string;
}): Promise<Review | null> {
  const result = await query(
    `UPDATE reviews
     SET status = $2,
         moderated_at = NOW(),
         moderated_by = $3
     WHERE id = $1
     RETURNING *`,
    [input.id, input.status, input.admin_id]
  );
  return result.rows[0] ? mapReview(result.rows[0]) : null;
}

export async function deleteReview(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM reviews WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
