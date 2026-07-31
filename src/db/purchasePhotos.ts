import { query } from "./pool";

export interface PurchasePhotoMeta {
  id: string;
  purchase_id: string;
  content_type: string;
  original_filename: string | null;
  byte_length: number;
  created_at: Date;
}

export interface PurchasePhoto extends PurchasePhotoMeta {
  bytes: Buffer;
}

/** Store (or replace) the customer photo attached to an archive-shop order. */
export async function upsertPurchasePhoto(input: {
  purchaseId: string;
  contentType: string;
  originalFilename?: string | null;
  bytes: Buffer;
}): Promise<PurchasePhotoMeta> {
  const result = await query(
    `INSERT INTO purchase_photos (
       purchase_id, content_type, original_filename, bytes
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (purchase_id) DO UPDATE SET
       content_type = EXCLUDED.content_type,
       original_filename = EXCLUDED.original_filename,
       bytes = EXCLUDED.bytes,
       created_at = NOW()
     RETURNING id, purchase_id, content_type, original_filename,
               octet_length(bytes) AS byte_length, created_at`,
    [
      input.purchaseId,
      input.contentType,
      input.originalFilename ?? null,
      input.bytes,
    ]
  );
  const row = result.rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    purchase_id: String(row.purchase_id),
    content_type: String(row.content_type),
    original_filename:
      row.original_filename == null ? null : String(row.original_filename),
    byte_length: Number(row.byte_length ?? 0),
    created_at: row.created_at as Date,
  };
}

export async function getPurchasePhoto(
  purchaseId: string
): Promise<PurchasePhoto | null> {
  const result = await query(
    `SELECT id, purchase_id, content_type, original_filename, bytes, created_at,
            octet_length(bytes) AS byte_length
     FROM purchase_photos
     WHERE purchase_id = $1
     LIMIT 1`,
    [purchaseId]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    purchase_id: String(row.purchase_id),
    content_type: String(row.content_type),
    original_filename:
      row.original_filename == null ? null : String(row.original_filename),
    byte_length: Number(row.byte_length ?? 0),
    created_at: row.created_at as Date,
    bytes: row.bytes as Buffer,
  };
}
