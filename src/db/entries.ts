import type { PoolClient } from "pg";
import { query, withTransaction } from "./pool";
import { claimDelivery, deliveryKey, type DeliveryRecord } from "./deliveries";

export type EntryStatus =
  | "pending"
  | "processing"
  | "validated"
  | "applied"
  | "processed"
  | "failed"
  | "escalated";

/** Statuses where the pipeline still owes the customer something. */
export const IN_FLIGHT_STATUSES: EntryStatus[] = [
  "pending",
  "processing",
  "validated",
  "applied",
  "escalated",
];

/** How many delivery attempts before a request is handed to a person. */
export const MAX_ATTEMPTS = 3;

/** Backoff before each retry, in minutes, indexed by attempts already made. */
const RETRY_BACKOFF_MINUTES = [1, 5, 15];

export interface Entry {
  id: string;
  real_name: string;
  angel_name: string;
  email: string | null;
  graphic_code: string | null;
  status: EntryStatus;
  /** Bumped once per completed delivery cycle; guards against stale claims. */
  version: number;
  attempt_count: number;
  next_retry_at: Date | null;
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

/**
 * Run writes with an identity attached, so entry_transitions records who moved
 * a request rather than an anonymous 'system'.
 */
async function asActor<T>(
  actor: string,
  reason: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('aagdb.actor', $1, true)`, [actor]);
    await client.query(`SELECT set_config('aagdb.reason', $1, true)`, [reason]);
    return fn(client);
  });
}

function mapRow(row: Record<string, unknown>): Entry {
  return {
    id: row.id as string,
    real_name: row.real_name as string,
    angel_name: row.angel_name as string,
    email: (row.email as string) ?? null,
    graphic_code: (row.graphic_code as string) ?? null,
    status: row.status as EntryStatus,
    version: Number(row.version ?? 1),
    attempt_count: Number(row.attempt_count ?? 0),
    next_retry_at: (row.next_retry_at as Date) ?? null,
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
    if (row.status !== "processed") {
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
         WHERE archived_at IS NULL AND status <> 'processed'
       )`
  );
  return result.rowCount ?? 0;
}

/**
 * Admin override: close out every open submission for a name because it was
 * handled by hand. Also acks any failure so the alert banner clears.
 */
export async function markAngelNameComplete(
  angelName: string
): Promise<number> {
  const result = await asActor(
    "admin",
    "closed by hand from the admin portal",
    (client) =>
      client.query(
        `UPDATE entries
     SET status = 'processed',
         next_retry_at = NULL,
         updated_at = NOW(),
         metadata = metadata || jsonb_build_object(
           'failure_acked', 'true',
           'closed_by', 'admin',
           'closed_at', NOW()::text
         )
     WHERE lower(angel_name) = lower($1)
       AND status <> 'processed'`,
        [angelName]
      )
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
  const result = await asActor(
    "worker:sweeper",
    "requeued a claim the worker never finished",
    (client) =>
      client.query(
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
      )
  );
  return result.rowCount ?? 0;
}

/**
 * Atomically claim the oldest pending entry for the graphic worker.
 * Returns null when the queue is empty.
 *
 * When minCreatedAt is set, only rows created at/after that instant are
 * eligible — keeps pre-automation backlog from being emailed again.
 *
 * Entries whose graphic has requires_photo=true are never claimed — those
 * are manual (customer photo attached); the AI worker must not touch them.
 */
export async function claimNextPending(
  minCreatedAt?: Date | null
): Promise<Entry | null> {
  const result = await asActor(
    "worker:generate",
    "claimed the oldest eligible request",
    (client) =>
      client.query(
    `WITH candidate AS (
       SELECT e.id
       FROM entries e
       WHERE e.status = 'pending'
         AND e.archived_at IS NULL
         AND (e.next_retry_at IS NULL OR e.next_retry_at <= NOW())
         AND ($1::timestamptz IS NULL OR e.created_at >= $1::timestamptz)
         AND NOT EXISTS (
           SELECT 1
           FROM graphic_options g
           WHERE g.requires_photo = true
             AND (
               lower(trim(g.code)) = lower(trim(coalesce(e.graphic_code, '')))
               OR lower(trim(g.label)) = lower(trim(coalesce(e.graphic_code, '')))
             )
         )
       ORDER BY e.created_at ASC
       FOR UPDATE OF e SKIP LOCKED
       LIMIT 1
     )
     UPDATE entries AS e
     SET status = 'processing',
         updated_at = NOW()
     FROM candidate
     WHERE e.id = candidate.id
     RETURNING e.*`,
        [minCreatedAt ?? null]
      )
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Release any requires_photo jobs stuck in processing back to pending
 * so admins can handle them manually (worker must not finish these).
 */
export async function releaseRequiresPhotoProcessing(): Promise<number> {
  const result = await asActor(
    "worker:sweeper",
    "returned a manual-only graphic to the queue",
    (client) =>
      client.query(
        `UPDATE entries e
     SET status = 'pending',
         updated_at = NOW(),
         metadata = e.metadata || jsonb_build_object(
           'released_at', NOW()::text,
           'release_reason', 'requires_photo_manual_only'
         )
     WHERE e.status = 'processing'
       AND e.archived_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM graphic_options g
         WHERE g.requires_photo = true
           AND (
             lower(trim(g.code)) = lower(trim(coalesce(e.graphic_code, '')))
             OR lower(trim(g.label)) = lower(trim(coalesce(e.graphic_code, '')))
           )
       )`
      )
  );
  return result.rowCount ?? 0;
}

/**
 * Close old pending rows that were fulfilled manually before automation.
 * Does not send email — marks processed + skipped_pre_automation.
 */
export async function skipLegacyPendingBefore(
  before: Date
): Promise<number> {
  const result = await asActor(
    "worker:startup",
    "closed pre-automation backlog without emailing",
    (client) =>
      client.query(
        `UPDATE entries
     SET status = 'processed',
         updated_at = NOW(),
         metadata = metadata || jsonb_build_object(
           'skipped_pre_automation', 'true',
           'photo_sent', 'false',
           'note', 'Closed as pre-automation backlog; do not auto-email'
         )
     WHERE status IN ('pending', 'processing', 'validated', 'applied')
       AND archived_at IS NULL
       AND created_at < $1::timestamptz`,
        [before]
      )
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
  const result = await asActor(
    "worker:startup",
    "closed pre-automation failures",
    (client) =>
      client.query(
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
      )
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

export interface PipelineAlertEntry extends Entry {
  graphic_label: string | null;
}

export async function listFailedPipelineAlerts(
  limit = 50
): Promise<PipelineAlertEntry[]> {
  const result = await query(
    `SELECT e.*,
       (
         SELECT g.label
         FROM graphic_options g
         WHERE lower(trim(g.code)) = lower(trim(coalesce(e.graphic_code, '')))
            OR lower(trim(g.label)) = lower(trim(coalesce(e.graphic_code, '')))
         ORDER BY (lower(trim(g.code)) = lower(trim(coalesce(e.graphic_code, '')))) DESC
         LIMIT 1
       ) AS graphic_label
     FROM entries e
     WHERE e.status IN ('failed', 'escalated')
       AND e.archived_at IS NULL
       AND coalesce(e.metadata->>'failure_acked', 'false') <> 'true'
     ORDER BY e.updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => {
    const entry = mapRow(row as Record<string, unknown>);
    const label =
      row.graphic_label == null || String(row.graphic_label).trim() === ""
        ? null
        : String(row.graphic_label).trim();
    return { ...entry, graphic_label: label };
  });
}

export async function ackFailedPipelineAlerts(): Promise<number> {
  const result = await query(
    `UPDATE entries
     SET metadata = metadata || '{"failure_acked":"true"}'::jsonb,
         updated_at = NOW()
     WHERE status IN ('failed', 'escalated')
       AND coalesce(metadata->>'failure_acked', 'false') <> 'true'`
  );
  return result.rowCount ?? 0;
}

export interface TransitionOptions {
  /** Recorded in entry_transitions: worker stage, 'admin', 'api'. */
  actor?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Set when this transition ends a delivery cycle. */
  bumpVersion?: boolean;
  clearRetry?: boolean;
}

/**
 * Move an entry between states, but only if it is still where and how the
 * caller last saw it. A mismatched status or version means another worker (or
 * an admin) has already moved this row, so the caller must stop rather than
 * overwrite newer work. Returns null when the guard rejects the write.
 */
export async function transitionEntry(
  id: string,
  from: EntryStatus | EntryStatus[],
  to: EntryStatus,
  expectedVersion: number,
  options: TransitionOptions = {}
): Promise<Entry | null> {
  const fromStatuses = Array.isArray(from) ? from : [from];
  const result = await asActor(
    options.actor ?? "worker",
    options.reason ?? "",
    (client) =>
      client.query(
        `UPDATE entries
       SET status = $3,
           version = CASE WHEN $5 THEN version + 1 ELSE version END,
           next_retry_at = CASE WHEN $6 THEN NULL ELSE next_retry_at END,
           updated_at = NOW(),
           metadata = CASE
             WHEN $7::jsonb IS NULL THEN metadata
             ELSE metadata || $7::jsonb
           END
       WHERE id = $1
         AND status = ANY($2::text[])
         AND version = $4
       RETURNING *`,
        [
          id,
          fromStatuses,
          to,
          expectedVersion,
          options.bumpVersion ?? false,
          options.clearRetry ?? false,
          options.metadata ? JSON.stringify(options.metadata) : null,
        ]
      )
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export type FailureClass = "transient" | "permanent";

/**
 * Record a pipeline failure. Transient failures get a backed-off retry until
 * the attempt cap; permanent ones (and exhausted retries) stop as 'escalated'
 * so a person picks them up instead of the queue churning.
 */
export async function recordFailure(input: {
  entry: Entry;
  stage: "generate" | "deliver";
  error: string;
  failureClass: FailureClass;
  metadata?: Record<string, unknown>;
}): Promise<{ entry: Entry | null; escalated: boolean; retryInMinutes: number | null }> {
  const attempts = input.entry.attempt_count + 1;
  const backoff = RETRY_BACKOFF_MINUTES[input.entry.attempt_count] ?? null;
  const escalate =
    input.failureClass === "permanent" ||
    attempts >= MAX_ATTEMPTS ||
    backoff === null;

  const metadata = {
    error: input.error,
    failure_stage: input.stage,
    failure_class: input.failureClass,
    failed_at: new Date().toISOString(),
    failure_acked: "false",
    attempt_count: String(attempts),
    ...(input.metadata ?? {}),
  };

  return asActor(
    `worker:${input.stage}`,
    input.error.slice(0, 300),
    async (client) => {
      const result = await client.query(
        `UPDATE entries
       SET status = $2,
           attempt_count = $3,
           next_retry_at = $4,
           updated_at = NOW(),
           metadata = metadata || $5::jsonb
       WHERE id = $1
         AND version = $6
       RETURNING *`,
      [
        input.entry.id,
        escalate ? "escalated" : "failed",
        attempts,
        escalate ? null : new Date(Date.now() + backoff! * 60_000),
        JSON.stringify(
          escalate
            ? {
                ...metadata,
                escalated_at: new Date().toISOString(),
                escalation_reason:
                  input.failureClass === "permanent"
                    ? "permanent_failure"
                    : "retry_attempts_exhausted",
              }
            : metadata
        ),
          input.entry.version,
        ]
      );

      return {
        entry: result.rows[0] ? mapRow(result.rows[0]) : null,
        escalated: escalate,
        retryInMinutes: escalate ? null : backoff,
      };
    }
  );
}

/**
 * Put failures whose backoff has elapsed back in the queue. Generation output
 * is reused on the retry, and the delivery record decides whether a second
 * email is allowed, so requeueing here cannot produce a duplicate send.
 */
export async function requeueDueRetries(
  minCreatedAt?: Date | null
): Promise<number> {
  const result = await asActor(
    "worker:sweeper",
    "retry backoff elapsed",
    (client) =>
      client.query(
        `UPDATE entries
     SET status = 'pending',
         next_retry_at = NULL,
         updated_at = NOW(),
         metadata = metadata || jsonb_build_object(
           'requeued_at', NOW()::text,
           'requeue_reason', 'retry_backoff_elapsed'
         )
     WHERE status = 'failed'
       AND archived_at IS NULL
       AND next_retry_at IS NOT NULL
       AND next_retry_at <= NOW()
       AND attempt_count < $1
       AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)`,
        [MAX_ATTEMPTS, minCreatedAt ?? null]
      )
  );
  return result.rowCount ?? 0;
}

/**
 * An entry left in 'applied' means an email was handed to SMTP and the worker
 * never saw the outcome. Retrying could send a second copy, so age it out to a
 * person instead.
 */
export async function escalateStuckApplied(
  olderThanMinutes = 15
): Promise<number> {
  const minutes = Math.max(5, olderThanMinutes);
  const result = await asActor(
    "worker:sweeper",
    "delivery outcome never confirmed",
    (client) =>
      client.query(
        `UPDATE entries
     SET status = 'escalated',
         updated_at = NOW(),
         metadata = metadata || jsonb_build_object(
           'escalated_at', NOW()::text,
           'escalation_reason', 'delivery_outcome_unconfirmed',
           'note', 'Email was handed to SMTP but never confirmed. Check the customer inbox before resending.',
           'failure_acked', 'false'
         )
     WHERE status = 'applied'
       AND archived_at IS NULL
       AND updated_at < NOW() - ($1::text || ' minutes')::interval`,
        [String(minutes)]
      )
  );
  return result.rowCount ?? 0;
}

/**
 * Admin action: allow one more delivery attempt for a request that stopped
 * because an earlier send was never confirmed. Clears the block on the
 * delivery key and gives the request a fresh set of retries.
 */
export async function reopenForResend(id: string): Promise<Entry | null> {
  const result = await asActor(
    "admin",
    "admin authorised one more send",
    (client) =>
      client.query(
        `UPDATE entries
       SET status = 'pending',
           attempt_count = 0,
           next_retry_at = NULL,
           updated_at = NOW(),
           metadata = metadata || jsonb_build_object(
             'reopened_at', NOW()::text,
             'reopened_by', 'admin',
             'failure_acked', 'true'
           )
       WHERE id = $1
         AND status IN ('failed', 'escalated')
       RETURNING *`,
        [id]
      )
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** The delivery identity for this entry, when it has enough detail to send. */
export function entryDeliveryKey(entry: Entry): string | null {
  const email = entry.email?.trim();
  const graphicCode = entry.graphic_code?.trim();
  if (!email || !graphicCode) return null;
  return deliveryKey({ email, angelName: entry.angel_name, graphicCode });
}

export type DeliveryClaim =
  | { kind: "empty" }
  | { kind: "claimed"; entry: Entry; deliveryKey: string }
  | { kind: "duplicate"; entry: Entry; existing: DeliveryRecord }
  | { kind: "unconfirmed"; entry: Entry; existing: DeliveryRecord };

/**
 * Claim one generated request for delivery.
 *
 * The row moves to 'applied' and the delivery intent is recorded in the same
 * transaction, before any email is sent. If the caller then crashes, times
 * out, or is killed, the durable record still says an attempt was made.
 */
export async function claimValidatedForDelivery(
  minCreatedAt?: Date | null
): Promise<DeliveryClaim> {
  return withTransaction(async (client) => {
    const candidate = await client.query(
      `SELECT * FROM entries
       WHERE status = 'validated'
         AND archived_at IS NULL
         AND ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [minCreatedAt ?? null]
    );
    if (!candidate.rows[0]) return { kind: "empty" as const };

    const entry = mapRow(candidate.rows[0]);
    const email = entry.email?.trim();
    const graphicCode = entry.graphic_code?.trim();
    if (!email || !graphicCode) {
      // Validation should have caught this; treat as unconfirmed so a person
      // looks rather than the row silently spinning.
      await client.query(
        `UPDATE entries
         SET status = 'escalated',
             updated_at = NOW(),
             metadata = metadata || jsonb_build_object(
               'escalation_reason', 'missing_email_or_graphic_at_delivery',
               'failure_acked', 'false'
             )
         WHERE id = $1`,
        [entry.id]
      );
      return { kind: "empty" as const };
    }

    const key = deliveryKey({
      email,
      angelName: entry.angel_name,
      graphicCode,
    });

    await client.query(`SELECT set_config('aagdb.actor', $1, true)`, [
      "worker:deliver",
    ]);

    const claim = await claimDelivery(client, { key, entryId: entry.id });
    if (!claim.claimed) {
      if (claim.existing.state === "sent") {
        await client.query(`SELECT set_config('aagdb.reason', $1, true)`, [
          "already delivered under this idempotency key",
        ]);
        const closed = await client.query(
          `UPDATE entries
           SET status = 'processed',
               version = version + 1,
               next_retry_at = NULL,
               updated_at = NOW(),
               metadata = metadata || jsonb_build_object(
                 'photo_sent', 'true',
                 'skipped_duplicate', 'true',
                 'duplicate_of_delivery', $2::text,
                 'note', 'A delivery for this customer, angel name and graphic was already sent'
               )
           WHERE id = $1
           RETURNING *`,
          [entry.id, key]
        );
        return {
          kind: "duplicate" as const,
          entry: mapRow(closed.rows[0]),
          existing: claim.existing,
        };
      }

      await client.query(`SELECT set_config('aagdb.reason', $1, true)`, [
        "previous delivery attempt never confirmed",
      ]);
      const held = await client.query(
        `UPDATE entries
         SET status = 'escalated',
             updated_at = NOW(),
             metadata = metadata || jsonb_build_object(
               'escalated_at', NOW()::text,
               'escalation_reason', 'delivery_outcome_unconfirmed',
               'note', 'An earlier send for this customer was never confirmed. Check their inbox, then release it for one more send or mark it complete.',
               'failure_acked', 'false'
             )
         WHERE id = $1
         RETURNING *`,
        [entry.id]
      );
      return {
        kind: "unconfirmed" as const,
        entry: mapRow(held.rows[0]),
        existing: claim.existing,
      };
    }

    await client.query(`SELECT set_config('aagdb.reason', $1, true)`, [
      "delivery intent recorded before send",
    ]);
    const applied = await client.query(
      `UPDATE entries
       SET status = 'applied',
           attempt_count = attempt_count + 1,
           updated_at = NOW(),
           metadata = metadata || jsonb_build_object(
             'delivery_key', $2::text,
             'delivery_attempted_at', NOW()::text
           )
       WHERE id = $1
         AND status = 'validated'
         AND version = $3
       RETURNING *`,
      [entry.id, key, entry.version]
    );
    if (!applied.rows[0]) return { kind: "empty" as const };

    return {
      kind: "claimed" as const,
      entry: mapRow(applied.rows[0]),
      deliveryKey: key,
    };
  });
}

/**
 * Unguarded status write for admin and external-automation callers. The worker
 * uses transitionEntry instead, so that its writes carry a version check.
 */
export async function updateEntryStatus(
  id: string,
  status: EntryStatus,
  metadata?: Record<string, unknown>,
  actor = "api"
): Promise<Entry | null> {
  const result = await asActor(actor, "direct status write", (client) =>
    client.query(
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
    )
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
