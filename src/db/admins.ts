import { query } from "./pool";

export interface Admin {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

export async function getAdminByEmail(email: string): Promise<Admin | null> {
  const result = await query(
    `SELECT id, email, password_hash, created_at
     FROM admins
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    email: row.email as string,
    password_hash: row.password_hash as string,
    created_at: row.created_at as Date,
  };
}

export async function getAdminById(id: string): Promise<Admin | null> {
  const result = await query(
    `SELECT id, email, password_hash, created_at
     FROM admins
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    email: row.email as string,
    password_hash: row.password_hash as string,
    created_at: row.created_at as Date,
  };
}

export async function createAdminSession(
  adminId: string,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  await query(
    `INSERT INTO admin_sessions (admin_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [adminId, tokenHash, expiresAt]
  );
}

export async function getAdminIdBySessionTokenHash(
  tokenHash: string
): Promise<string | null> {
  const result = await query(
    `SELECT admin_id
     FROM admin_sessions
     WHERE token_hash = $1
       AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] ? (result.rows[0].admin_id as string) : null;
}

export async function deleteSessionByTokenHash(tokenHash: string): Promise<void> {
  await query(`DELETE FROM admin_sessions WHERE token_hash = $1`, [tokenHash]);
}

export async function deleteExpiredSessions(): Promise<void> {
  await query(`DELETE FROM admin_sessions WHERE expires_at <= NOW()`);
}

export async function createAdmin(
  email: string,
  passwordHash: string
): Promise<{ id: string; email: string }> {
  const result = await query(
    `INSERT INTO admins (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email`,
    [email, passwordHash]
  );
  return {
    id: result.rows[0].id as string,
    email: result.rows[0].email as string,
  };
}
