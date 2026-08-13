import type { PoolClient } from "pg";
import { query } from "./pool";

export type DeliveryState = "attempted" | "sent" | "not_sent";

export interface DeliveryRecord {
  idempotency_key: string;
  entry_id: string | null;
  state: DeliveryState;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Stable identity for one customer delivery intent.
 *
 * A retry of the same request keeps this key, so it can be recognised and
 * refused. A genuinely different request (new angel name, different graphic,
 * different customer) produces a different key and is allowed through.
 */
export function deliveryKey(input: {
  email: string;
  angelName: string;
  graphicCode: string;
}): string {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  return [
    norm(input.email),
    norm(input.angelName),
    norm(input.graphicCode),
  ].join("|");
}

function mapRow(row: Record<string, unknown>): DeliveryRecord {
  return {
    idempotency_key: String(row.idempotency_key),
    entry_id: row.entry_id == null ? null : String(row.entry_id),
    state: row.state as DeliveryState,
    attempt_count: Number(row.attempt_count ?? 0),
    last_error: row.last_error == null ? null : String(row.last_error),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

export type ClaimDeliveryResult =
  | { claimed: true; record: DeliveryRecord }
  | { claimed: false; existing: DeliveryRecord };

/**
 * Reserve the right to email this customer, before any email is sent.
 *
 * Succeeds when no attempt exists yet, or when the previous attempt is proven
 * never to have been sent. Fails when a delivery is already recorded as sent
 * (duplicate) or as attempted with an unconfirmed outcome (needs a human,
 * because sending again risks a second copy).
 */
export async function claimDelivery(
  client: PoolClient,
  input: { key: string; entryId: string }
): Promise<ClaimDeliveryResult> {
  const claimed = await client.query(
    `INSERT INTO graphic_deliveries (idempotency_key, entry_id, state, attempt_count)
     VALUES ($1, $2, 'attempted', 1)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET state = 'attempted',
           entry_id = EXCLUDED.entry_id,
           attempt_count = graphic_deliveries.attempt_count + 1,
           last_error = NULL,
           updated_at = NOW()
       WHERE graphic_deliveries.state = 'not_sent'
     RETURNING *`,
    [input.key, input.entryId]
  );

  if (claimed.rows[0]) {
    return { claimed: true, record: mapRow(claimed.rows[0]) };
  }

  const existing = await client.query(
    `SELECT * FROM graphic_deliveries WHERE idempotency_key = $1`,
    [input.key]
  );
  return { claimed: false, existing: mapRow(existing.rows[0]) };
}

/** SMTP accepted the message. This key can never be sent again. */
export async function markDeliverySent(key: string): Promise<void> {
  await query(
    `UPDATE graphic_deliveries
     SET state = 'sent', last_error = NULL, updated_at = NOW()
     WHERE idempotency_key = $1`,
    [key]
  );
}

/** Proven not to have been sent, so a later attempt is safe. */
export async function markDeliveryNotSent(
  key: string,
  error: string
): Promise<void> {
  await query(
    `UPDATE graphic_deliveries
     SET state = 'not_sent', last_error = $2, updated_at = NOW()
     WHERE idempotency_key = $1`,
    [key, error.slice(0, 2000)]
  );
}

/**
 * Outcome unknown: the message may or may not have reached the customer.
 * The record stays 'attempted' so nothing retries it automatically.
 */
export async function markDeliveryUnconfirmed(
  key: string,
  error: string
): Promise<void> {
  await query(
    `UPDATE graphic_deliveries
     SET state = 'attempted', last_error = $2, updated_at = NOW()
     WHERE idempotency_key = $1`,
    [key, error.slice(0, 2000)]
  );
}

export async function getDelivery(
  key: string
): Promise<DeliveryRecord | null> {
  const result = await query(
    `SELECT * FROM graphic_deliveries WHERE idempotency_key = $1`,
    [key]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Let an admin authorise one more send after checking the customer's inbox.
 * Clears the block that an unconfirmed attempt puts on the key.
 */
export async function releaseDeliveryForResend(key: string): Promise<boolean> {
  const result = await query(
    `UPDATE graphic_deliveries
     SET state = 'not_sent',
         last_error = 'Released by admin for one more send',
         updated_at = NOW()
     WHERE idempotency_key = $1
       AND state = 'attempted'`,
    [key]
  );
  return (result.rowCount ?? 0) > 0;
}
