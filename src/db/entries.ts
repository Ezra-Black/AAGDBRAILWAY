import { query } from "./pool";

export type EntryStatus = "pending" | "processing" | "processed" | "failed";

export interface Entry {
  id: string;
  real_name: string;
  angel_name: string;
  email: string | null;
  graphic_code: string | null;
  status: EntryStatus;
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
}

export interface CreateEntryInput {
  real_name: string;
  angel_name: string;
  email: string;
  graphic_code: string;
  metadata?: Record<string, unknown>;
}

function mapRow(row: Record<string, unknown>): Entry {
  return {
    id: row.id as string,
    real_name: row.real_name as string,
    angel_name: row.angel_name as string,
    email: (row.email as string) ?? null,
    graphic_code: (row.graphic_code as string) ?? null,
    status: row.status as EntryStatus,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

export async function createEntry(input: CreateEntryInput): Promise<Entry> {
  const result = await query(
    `INSERT INTO entries (real_name, angel_name, email, graphic_code, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [
      input.real_name,
      input.angel_name,
      input.email,
      input.graphic_code,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return mapRow(result.rows[0]);
}

export async function listEntries(limit = 100, offset = 0): Promise<Entry[]> {
  const result = await query(
    `SELECT * FROM entries
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows.map(mapRow);
}

export interface AdminEntryListItem {
  id: string;
  angel_name: string;
  graphic_code: string | null;
  graphic_label: string | null;
  real_name: string;
  email: string | null;
  status: EntryStatus;
  created_at: Date;
}

export interface AdminAngelGroup {
  angel_name: string;
  graphics: { code: string; label: string | null }[];
  emails: string[];
  entry_ids: string[];
  has_pending: boolean;
  latest_at: Date;
}

/** Raw admin rows (one per submission). */
export async function listEntriesForAdmin(
  limit = 2000
): Promise<AdminEntryListItem[]> {
  const result = await query(
    `SELECT
       e.id,
       e.angel_name,
       e.graphic_code,
       g.label AS graphic_label,
       e.real_name,
       e.email,
       e.status,
       e.created_at
     FROM entries e
     LEFT JOIN graphic_options g ON g.code = e.graphic_code
     ORDER BY e.created_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    angel_name: row.angel_name as string,
    graphic_code: (row.graphic_code as string) ?? null,
    graphic_label: (row.graphic_label as string) ?? null,
    real_name: row.real_name as string,
    email: (row.email as string) ?? null,
    status: row.status as EntryStatus,
    created_at: row.created_at as Date,
  }));
}

/** Group submissions by angel name for the admin portal. */
export async function listAngelGroupsForAdmin(
  limit = 2000
): Promise<AdminAngelGroup[]> {
  const rows = await listEntriesForAdmin(limit);
  const groups = new Map<string, AdminAngelGroup>();

  for (const row of rows) {
    const key = row.angel_name.trim().toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        angel_name: row.angel_name,
        graphics: [],
        emails: [],
        entry_ids: [],
        has_pending: false,
        latest_at: row.created_at,
      };
      groups.set(key, group);
    }

    group.entry_ids.push(row.id);
    if (
      row.status === "pending" ||
      row.status === "processing"
    ) {
      group.has_pending = true;
    }
    if (row.created_at > group.latest_at) {
      group.latest_at = row.created_at;
      group.angel_name = row.angel_name;
    }

    if (row.graphic_code) {
      const exists = group.graphics.some((g) => g.code === row.graphic_code);
      if (!exists) {
        group.graphics.push({
          code: row.graphic_code,
          label: row.graphic_label,
        });
      }
    }

    if (row.email) {
      const emailKey = row.email.trim().toLowerCase();
      const emailExists = group.emails.some(
        (e) => e.toLowerCase() === emailKey
      );
      if (!emailExists) {
        group.emails.push(row.email.trim());
      }
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => b.latest_at.getTime() - a.latest_at.getTime()
  );
}

export async function markAngelNameComplete(
  angelName: string
): Promise<number> {
  const result = await query(
    `UPDATE entries
     SET status = 'processed',
         updated_at = NOW()
     WHERE lower(angel_name) = lower($1)
       AND status IN ('pending', 'processing')`,
    [angelName]
  );
  return result.rowCount ?? 0;
}

export async function getEntryById(id: string): Promise<Entry | null> {
  const result = await query(`SELECT * FROM entries WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function getEntryByAngelName(
  angelName: string
): Promise<Entry | null> {
  const result = await query(
    `SELECT * FROM entries
     WHERE lower(angel_name) = lower($1)
     ORDER BY created_at DESC
     LIMIT 1`,
    [angelName]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function getEntryByRealName(
  realName: string
): Promise<Entry | null> {
  const result = await query(
    `SELECT * FROM entries
     WHERE lower(real_name) = lower($1)
     ORDER BY created_at DESC
     LIMIT 1`,
    [realName]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listPending(limit = 50): Promise<Entry[]> {
  const result = await query(
    `SELECT * FROM entries
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapRow);
}

export async function updateEntryStatus(
  id: string,
  status: EntryStatus,
  metadata?: Record<string, unknown>
): Promise<Entry | null> {
  const result = await query(
    `UPDATE entries
     SET status = $2,
         updated_at = NOW(),
         metadata = CASE
           WHEN $3::jsonb IS NULL THEN metadata
           ELSE metadata || $3::jsonb
         END
     WHERE id = $1
     RETURNING *`,
    [id, status, metadata ? JSON.stringify(metadata) : null]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
