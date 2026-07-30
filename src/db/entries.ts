import { query } from "./pool";

export type EntryStatus = "pending" | "processing" | "processed" | "failed";

export interface Entry {
  id: string;
  real_name: string;
  angel_name: string;
  email: string | null;
  graphic_code: string | null;
  status: EntryStatus;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
}

export interface CreateEntryInput {
  real_name: string;
  angel_name: string;
  email: string;
  graphic_code: string;
  /** Account that made the request, when logged in. */
  user_id?: string | null;
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
    archived_at: (row.archived_at as Date) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

export async function createEntry(input: CreateEntryInput): Promise<Entry> {
  const result = await query(
    `INSERT INTO entries (real_name, angel_name, email, graphic_code, user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      input.real_name,
      input.angel_name,
      input.email,
      input.graphic_code,
      input.user_id ?? null,
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
  has_generated_photo: boolean;
  has_customer_photo: boolean;
}

export interface AdminAngelGroup {
  angel_name: string;
  graphics: { code: string; label: string | null }[];
  emails: string[];
  entry_ids: string[];
  has_pending: boolean;
  /** True when this angel name has more than one submission on file. */
  duplicate: boolean;
  submission_count: number;
  /** Earliest submission for this angel name. */
  created_at: Date;
  /** Most recent submission for this angel name. */
  latest_at: Date;
  /** Per-entry photo availability for admin download links. */
  photos: {
    entry_id: string;
    has_generated_photo: boolean;
    has_customer_photo: boolean;
  }[];
}

/** Raw admin rows (one per submission). */
export async function listEntriesForAdmin(
  limit = 2000,
  options: { archived?: boolean; search?: string } = {}
): Promise<AdminEntryListItem[]> {
  const archivedClause = options.archived
    ? "e.archived_at IS NOT NULL"
    : "e.archived_at IS NULL";
  const params: unknown[] = [limit];
  let searchClause = "";
  if (options.search?.trim()) {
    params.push(`%${options.search.trim()}%`);
    searchClause = `
       AND (e.angel_name ILIKE $2
         OR e.real_name ILIKE $2
         OR e.email ILIKE $2
         OR e.graphic_code ILIKE $2
         OR g.label ILIKE $2)`;
  }
  const result = await query(
    `SELECT
       e.id,
       e.angel_name,
       e.graphic_code,
       g.label AS graphic_label,
       e.real_name,
       e.email,
       e.status,
       e.created_at,
       EXISTS (
         SELECT 1 FROM entry_photos p
         WHERE p.entry_id = e.id AND p.kind = 'generated'
       ) AS has_generated_photo,
       EXISTS (
         SELECT 1 FROM entry_photos p
         WHERE p.entry_id = e.id AND p.kind = 'customer'
       ) AS has_customer_photo
     FROM entries e
     LEFT JOIN graphic_options g ON g.code = e.graphic_code
     WHERE ${archivedClause}${searchClause}
     ORDER BY e.created_at DESC
     LIMIT $1`,
    params
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
    has_generated_photo: Boolean(row.has_generated_photo),
    has_customer_photo: Boolean(row.has_customer_photo),
  }));
}

export interface AdminGroupFilters {
  graphicCode?: string | null;
  archived?: boolean;
  search?: string;
  /** "pending" = has open claims, "complete" = everything processed. */
  status?: "pending" | "complete" | null;
}

/** Group submissions by angel name for the admin portal. */
export async function listAngelGroupsForAdmin(
  limit = 2000,
  filters: AdminGroupFilters = {}
): Promise<AdminAngelGroup[]> {
  const rows = await listEntriesForAdmin(limit, {
    archived: filters.archived,
    search: filters.search,
  });
  const filterCode = filters.graphicCode?.trim().toLowerCase() || "";
  const filtered = filterCode
    ? rows.filter(
        (row) => (row.graphic_code || "").trim().toLowerCase() === filterCode
      )
    : rows;

  const groups = new Map<string, AdminAngelGroup>();

  for (const row of filtered) {
    const key = row.angel_name.trim().toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        angel_name: row.angel_name,
        graphics: [],
        emails: [],
        entry_ids: [],
        has_pending: false,
        duplicate: false,
        submission_count: 0,
        created_at: row.created_at,
        latest_at: row.created_at,
        photos: [],
      };
      groups.set(key, group);
    }

    group.entry_ids.push(row.id);
    if (row.has_generated_photo || row.has_customer_photo) {
      group.photos.push({
        entry_id: row.id,
        has_generated_photo: row.has_generated_photo,
        has_customer_photo: row.has_customer_photo,
      });
    }
    group.submission_count = group.entry_ids.length;
    group.duplicate = group.submission_count > 1;
    if (row.status === "pending" || row.status === "processing") {
      group.has_pending = true;
    }
    if (row.created_at > group.latest_at) {
      group.latest_at = row.created_at;
      group.angel_name = row.angel_name;
    }
    if (row.created_at < group.created_at) {
      group.created_at = row.created_at;
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

  let list = Array.from(groups.values());
  if (filters.status === "pending") {
    list = list.filter((g) => g.has_pending);
  } else if (filters.status === "complete") {
    list = list.filter((g) => !g.has_pending);
  }

  return list.sort((a, b) => b.latest_at.getTime() - a.latest_at.getTime());
}

/** Archive (or restore) every submission for an angel name. */
export async function setAngelNameArchived(
  angelName: string,
  archived: boolean
): Promise<number> {
  const result = await query(
    `UPDATE entries
     SET archived_at = ${archived ? "NOW()" : "NULL"},
         updated_at = NOW()
     WHERE lower(angel_name) = lower($1)`,
    [angelName]
  );
  return result.rowCount ?? 0;
}

/** Bulk clean-up: archive every fully completed, unarchived submission. */
export async function archiveCompletedEntries(): Promise<number> {
  const result = await query(
    `UPDATE entries
     SET archived_at = NOW(), updated_at = NOW()
     WHERE archived_at IS NULL
       AND status = 'processed'
       AND lower(angel_name) NOT IN (
         SELECT lower(angel_name) FROM entries
         WHERE archived_at IS NULL AND status IN ('pending', 'processing')
       )`
  );
  return result.rowCount ?? 0;
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

/**
 * Same email + angel name within a cooldown window (anti multi-submit spam).
 * Uses parameterized SQL only — never string-concatenated user input.
 */
export async function findRecentDuplicateClaim(
  email: string,
  angelName: string,
  cooldownHours = 24
): Promise<Entry | null> {
  const hours = Math.min(Math.max(Math.floor(Number(cooldownHours) || 24), 1), 168);
  const result = await query(
    `SELECT * FROM entries
     WHERE lower(email) = lower($1)
       AND lower(angel_name) = lower($2)
       AND created_at > NOW() - make_interval(hours => $3::int)
     ORDER BY created_at DESC
     LIMIT 1`,
    [email, angelName, hours]
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

/** True if this email has submitted at least one form request. */
export async function emailExistsInEntries(email: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM entries
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email]
  );
  return (result.rowCount ?? 0) > 0;
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

/**
 * Re-queue entries stuck in processing (crashed / timed-out worker).
 * Returns how many rows were moved back to pending.
 */
export async function reclaimStuckProcessing(
  olderThanMinutes = 10,
  minCreatedAt?: Date | null
): Promise<number> {
  const minutes = Math.max(2, olderThanMinutes);
  const result = await query(
    `UPDATE entries
     SET status = 'pending',
         updated_at = NOW(),
         metadata = metadata || jsonb_build_object(
           'reclaimed_at', NOW()::text,
           'reclaim_reason', 'stuck_processing'
         )
     WHERE status = 'processing'
       AND archived_at IS NULL
       AND updated_at < NOW() - ($1::text || ' minutes')::interval
       AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)`,
    [String(minutes), minCreatedAt ?? null]
  );
  return result.rowCount ?? 0;
}

/**
 * Atomically claim the oldest pending entry for the graphic worker.
 * Returns null when the queue is empty.
 *
 * When minCreatedAt is set, only rows created at/after that instant are
 * eligible — keeps pre-automation backlog from being emailed again.
 */
export async function claimNextPending(
  minCreatedAt?: Date | null
): Promise<Entry | null> {
  const result = await query(
    `WITH candidate AS (
       SELECT id
       FROM entries
       WHERE status = 'pending'
         AND archived_at IS NULL
         AND ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE entries AS e
     SET status = 'processing',
         updated_at = NOW()
     FROM candidate
     WHERE e.id = candidate.id
     RETURNING e.*`,
    [minCreatedAt ?? null]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Close old pending rows that were fulfilled manually before automation.
 * Does not send email — marks processed + skipped_pre_automation.
 */
export async function skipLegacyPendingBefore(
  before: Date
): Promise<number> {
  const result = await query(
    `UPDATE entries
     SET status = 'processed',
         updated_at = NOW(),
         metadata = metadata || jsonb_build_object(
           'skipped_pre_automation', 'true',
           'photo_sent', 'false',
           'note', 'Closed as pre-automation backlog; do not auto-email'
         )
     WHERE status IN ('pending', 'processing')
       AND archived_at IS NULL
       AND created_at < $1::timestamptz`,
    [before]
  );
  return result.rowCount ?? 0;
}

/**
 * Ack + close failed automation rows created before cutoff (manual backlog
 * that the worker already attempted). Hides them from the failure banner.
 */
export async function closeLegacyFailedBefore(
  before: Date
): Promise<number> {
  const result = await query(
    `UPDATE entries
     SET status = 'processed',
         updated_at = NOW(),
         metadata = metadata || jsonb_build_object(
           'failure_acked', 'true',
           'skipped_pre_automation', 'true',
           'photo_sent', 'false',
           'note', 'Pre-automation request; closed after worker SMTP/backlog attempt'
         )
     WHERE status = 'failed'
       AND archived_at IS NULL
       AND created_at < $1::timestamptz`,
    [before]
  );
  return result.rowCount ?? 0;
}

/** True if this email + angel name + graphic already got a delivered graphic. */
export async function findDeliveredDuplicate(
  email: string,
  angelName: string,
  graphicCode: string
): Promise<Entry | null> {
  const result = await query(
    `SELECT * FROM entries
     WHERE status = 'processed'
       AND archived_at IS NULL
       AND lower(email) = lower($1)
       AND lower(angel_name) = lower($2)
       AND lower(coalesce(graphic_code, '')) = lower($3)
       AND coalesce(metadata->>'photo_sent', '') = 'true'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [email, angelName, graphicCode]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listFailedPipelineAlerts(
  limit = 50
): Promise<Entry[]> {
  const result = await query(
    `SELECT * FROM entries
     WHERE status = 'failed'
       AND archived_at IS NULL
       AND coalesce(metadata->>'failure_acked', 'false') <> 'true'
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapRow);
}

export async function ackFailedPipelineAlerts(): Promise<number> {
  const result = await query(
    `UPDATE entries
     SET metadata = metadata || '{"failure_acked":"true"}'::jsonb,
         updated_at = NOW()
     WHERE status = 'failed'
       AND coalesce(metadata->>'failure_acked', 'false') <> 'true'`
  );
  return result.rowCount ?? 0;
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
