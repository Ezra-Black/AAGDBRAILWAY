import { query } from "./pool";

export interface FacebookUser {
  id: string;
  fb_user_id: string;
  name: string | null;
  email: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: Record<string, unknown>): FacebookUser {
  return {
    id: row.id as string,
    fb_user_id: row.fb_user_id as string,
    name: (row.name as string) ?? null,
    email: (row.email as string) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

/** Save (or refresh) a Facebook visitor. Email is kept for business purposes only. */
export async function upsertFacebookUser(input: {
  fb_user_id: string;
  name: string | null;
  email: string | null;
}): Promise<FacebookUser> {
  const result = await query(
    `INSERT INTO facebook_users (fb_user_id, name, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (fb_user_id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, facebook_users.name),
           email = COALESCE(EXCLUDED.email, facebook_users.email),
           updated_at = NOW()
     RETURNING *`,
    [input.fb_user_id, input.name, input.email]
  );
  return mapRow(result.rows[0]);
}
