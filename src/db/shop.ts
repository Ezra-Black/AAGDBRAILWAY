import { query } from "./pool";

export interface ArchiveGraphic {
  id: string;
  code: string;
  label: string;
  image_url: string | null;
  active: boolean;
  sort_order: number;
}

export interface Purchase {
  id: string;
  angel_name: string;
  real_name: string;
  email: string;
  graphic_code: string;
  note: string | null;
  amount_cents: number;
  currency: string;
  stripe_payment_intent_id: string | null;
  status: "pending" | "paid" | "failed" | "delivered";
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapPurchase(row: Record<string, unknown>): Purchase {
  return {
    id: row.id as string,
    angel_name: row.angel_name as string,
    real_name: row.real_name as string,
    email: row.email as string,
    graphic_code: row.graphic_code as string,
    note: (row.note as string) ?? null,
    amount_cents: Number(row.amount_cents),
    currency: row.currency as string,
    stripe_payment_intent_id: (row.stripe_payment_intent_id as string) ?? null,
    status: row.status as Purchase["status"],
    archived_at: (row.archived_at as Date) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

/** Active archive graphics for the shop dropdown. */
export async function listArchiveGraphics(): Promise<ArchiveGraphic[]> {
  const result = await query(
    `SELECT id, code, label, image_url, active, sort_order
     FROM archive_graphics
     WHERE COALESCE(active, true) = true
     ORDER BY sort_order ASC NULLS LAST, label ASC`
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    code: String(row.code),
    label: String(row.label),
    image_url: (row.image_url as string) ?? null,
    active: row.active !== false,
    sort_order: Number(row.sort_order ?? 0),
  }));
}

export async function getArchiveGraphicByCode(
  code: string
): Promise<ArchiveGraphic | null> {
  const result = await query(
    `SELECT id, code, label, image_url, active, sort_order
     FROM archive_graphics
     WHERE COALESCE(active, true) = true
       AND lower(trim(code)) = lower(trim($1))
     LIMIT 1`,
    [code]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    code: String(row.code),
    label: String(row.label),
    image_url: (row.image_url as string) ?? null,
    active: row.active !== false,
    sort_order: Number(row.sort_order ?? 0),
  };
}

/** Record a graphic option in the archive forever (idempotent). */
export async function archiveGraphicOption(input: {
  code: string;
  label: string;
  sort_order?: number;
}): Promise<void> {
  await query(
    `INSERT INTO archive_graphics (code, label, sort_order)
     VALUES ($1, $2, $3)
     ON CONFLICT (code) DO NOTHING`,
    [input.code, input.label, input.sort_order ?? 0]
  );
}

export async function createPurchase(input: {
  angel_name: string;
  real_name: string;
  email: string;
  graphic_code: string;
  note: string | null;
  amount_cents: number;
  currency: string;
  stripe_payment_intent_id: string;
}): Promise<Purchase> {
  const result = await query(
    `INSERT INTO purchases
       (angel_name, real_name, email, graphic_code, note,
        amount_cents, currency, stripe_payment_intent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.angel_name,
      input.real_name,
      input.email,
      input.graphic_code,
      input.note,
      input.amount_cents,
      input.currency,
      input.stripe_payment_intent_id,
    ]
  );
  return mapPurchase(result.rows[0]);
}

export async function getPurchaseByIntent(
  paymentIntentId: string
): Promise<Purchase | null> {
  const result = await query(
    `SELECT * FROM purchases WHERE stripe_payment_intent_id = $1 LIMIT 1`,
    [paymentIntentId]
  );
  return result.rows[0] ? mapPurchase(result.rows[0]) : null;
}

export async function markPurchaseStatusByIntent(
  paymentIntentId: string,
  status: Purchase["status"]
): Promise<Purchase | null> {
  // Stripe "paid" must not overwrite an admin "delivered" mark.
  const result = await query(
    `UPDATE purchases
     SET status = $2, updated_at = NOW()
     WHERE stripe_payment_intent_id = $1
       AND NOT (status = 'delivered' AND $2::text = 'paid')
     RETURNING *`,
    [paymentIntentId, status]
  );
  return result.rows[0] ? mapPurchase(result.rows[0]) : null;
}

/** Admin-driven status change (paid ↔ delivered). */
export async function setPurchaseStatus(
  id: string,
  status: "paid" | "delivered"
): Promise<Purchase | null> {
  const result = await query(
    `UPDATE purchases
     SET status = $2, updated_at = NOW()
     WHERE id = $1
       AND status IN ('paid', 'delivered')
     RETURNING *`,
    [id, status]
  );
  return result.rows[0] ? mapPurchase(result.rows[0]) : null;
}

export interface AdminPurchase extends Purchase {
  graphic_label: string | null;
}

export interface AdminPurchaseFilters {
  archived?: boolean;
  search?: string;
  status?: Purchase["status"] | null;
}

export async function listPurchasesForAdmin(
  limit = 200,
  filters: AdminPurchaseFilters = {}
): Promise<AdminPurchase[]> {
  const params: unknown[] = [limit];
  const clauses = [
    filters.archived ? "p.archived_at IS NOT NULL" : "p.archived_at IS NULL",
  ];
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`p.status = $${params.length}`);
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim()}%`);
    const n = params.length;
    clauses.push(
      `(p.angel_name ILIKE $${n}
        OR p.real_name ILIKE $${n}
        OR p.email ILIKE $${n}
        OR p.graphic_code ILIKE $${n}
        OR a.label ILIKE $${n})`
    );
  }
  const result = await query(
    `SELECT p.*, a.label AS graphic_label
     FROM purchases p
     LEFT JOIN archive_graphics a ON a.code = p.graphic_code
     WHERE ${clauses.join(" AND ")}
     ORDER BY p.created_at DESC
     LIMIT $1`,
    params
  );
  return result.rows.map((row) => ({
    ...mapPurchase(row),
    graphic_label: (row.graphic_label as string) ?? null,
  }));
}

/** Archive (or restore) a single order. */
export async function setPurchaseArchived(
  id: string,
  archived: boolean
): Promise<boolean> {
  const result = await query(
    `UPDATE purchases
     SET archived_at = ${archived ? "NOW()" : "NULL"},
         updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Bulk clean-up: archive every paid or delivered, unarchived order. */
export async function archivePaidPurchases(): Promise<number> {
  const result = await query(
    `UPDATE purchases
     SET archived_at = NOW(), updated_at = NOW()
     WHERE archived_at IS NULL
       AND status IN ('paid', 'delivered')`
  );
  return result.rowCount ?? 0;
}
