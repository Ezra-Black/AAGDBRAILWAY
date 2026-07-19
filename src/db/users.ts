import { query } from "./pool";

/**
 * Site-user (customer) data access.
 *
 * Users are visitors who register to track their graphic requests and shop
 * orders. `angel_name` is the custom name for their deceased loved one used
 * on graphics. Sessions and password-reset tokens store only SHA-256 hashes
 * of the opaque tokens handed to the client, so a DB leak never exposes a
 * usable credential.
 */

export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  angel_name: string | null;
  profile_photo_url: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Shape safe to send to the browser (no password hash). */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  angel_name: string | null;
  profile_photo_url: string | null;
  created_at: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    angel_name: user.angel_name,
    profile_photo_url: user.profile_photo_url,
    created_at: user.created_at,
  };
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    password_hash: row.password_hash as string,
    name: row.name as string,
    angel_name: (row.angel_name as string) ?? null,
    profile_photo_url: (row.profile_photo_url as string) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await query(
    `SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email]
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function getUserById(id: string): Promise<User | null> {
  const result = await query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function createUser(input: {
  email: string;
  password_hash: string;
  name: string;
  angel_name: string | null;
}): Promise<User> {
  const result = await query(
    `INSERT INTO users (email, password_hash, name, angel_name)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.email, input.password_hash, input.name, input.angel_name]
  );
  return mapUser(result.rows[0]);
}

/** Partial profile update — only the provided fields change. */
export async function updateUserProfile(
  id: string,
  patch: {
    email?: string;
    name?: string;
    angel_name?: string | null;
    profile_photo_url?: string | null;
  }
): Promise<User | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (patch.email !== undefined) {
    sets.push(`email = $${i++}`);
    values.push(patch.email);
  }
  if (patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(patch.name);
  }
  if (patch.angel_name !== undefined) {
    sets.push(`angel_name = $${i++}`);
    values.push(patch.angel_name);
  }
  if (patch.profile_photo_url !== undefined) {
    sets.push(`profile_photo_url = $${i++}`);
    values.push(patch.profile_photo_url);
  }

  if (!sets.length) return getUserById(id);

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const result = await query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function updateUserPasswordHash(
  id: string,
  passwordHash: string
): Promise<void> {
  await query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [passwordHash, id]
  );
}

/* ── Sessions ─────────────────────────────────────────────── */

export async function createUserSession(
  userId: string,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  await query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );
}

export async function getUserIdBySessionTokenHash(
  tokenHash: string
): Promise<string | null> {
  const result = await query(
    `SELECT user_id FROM user_sessions
     WHERE token_hash = $1 AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] ? (result.rows[0].user_id as string) : null;
}

export async function deleteUserSessionByTokenHash(
  tokenHash: string
): Promise<void> {
  await query(`DELETE FROM user_sessions WHERE token_hash = $1`, [tokenHash]);
}

/** Kill every session for a user — used after password change/reset. */
export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  await query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
}

export async function deleteExpiredUserSessions(): Promise<void> {
  await query(`DELETE FROM user_sessions WHERE expires_at <= NOW()`);
  await query(
    `DELETE FROM password_reset_tokens WHERE expires_at <= NOW() OR used_at IS NOT NULL`
  );
}

/* ── Password reset tokens ────────────────────────────────── */

export async function createPasswordResetToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  // One live token per user: a new request invalidates older ones.
  await query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );
}

export async function consumePasswordResetToken(
  tokenHash: string
): Promise<string | null> {
  const result = await query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL
     RETURNING user_id`,
    [tokenHash]
  );
  return result.rows[0] ? (result.rows[0].user_id as string) : null;
}

/* ── Account activity (requests + orders linked to the user) ── */

export interface UserActivity {
  requests: Array<{
    id: string;
    angel_name: string;
    graphic_code: string | null;
    status: string;
    created_at: Date;
  }>;
  orders: Array<{
    id: string;
    angel_name: string;
    graphic_code: string;
    amount_cents: number;
    currency: string;
    status: string;
    created_at: Date;
  }>;
}

/**
 * Everything this account has done: requests/orders linked by user_id, plus
 * older ones made with the same email before they registered.
 */
export async function getUserActivity(
  userId: string,
  email: string
): Promise<UserActivity> {
  const [requests, orders] = await Promise.all([
    query(
      `SELECT id, angel_name, graphic_code, status, created_at
       FROM entries
       WHERE user_id = $1 OR lower(email) = lower($2)
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId, email]
    ),
    query(
      `SELECT id, angel_name, graphic_code, amount_cents, currency, status, created_at
       FROM purchases
       WHERE user_id = $1 OR lower(email) = lower($2)
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId, email]
    ),
  ]);

  return {
    requests: requests.rows.map((row) => ({
      id: String(row.id),
      angel_name: String(row.angel_name),
      graphic_code: (row.graphic_code as string) ?? null,
      status: String(row.status),
      created_at: row.created_at as Date,
    })),
    orders: orders.rows.map((row) => ({
      id: String(row.id),
      angel_name: String(row.angel_name),
      graphic_code: String(row.graphic_code),
      amount_cents: Number(row.amount_cents),
      currency: String(row.currency),
      status: String(row.status),
      created_at: row.created_at as Date,
    })),
  };
}
