import { query } from "./pool";

export type EntryPhotoKind = "generated" | "customer";

export interface EntryPhotoMeta {
  id: string;
  entry_id: string;
  kind: EntryPhotoKind;
  content_type: string;
  original_filename: string | null;
  byte_length: number;
  created_at: Date;
}

export interface EntryPhoto extends EntryPhotoMeta {
  bytes: Buffer;
}

/**
 * Store (or replace) a photo for an entry.
 * kind=generated → worker output for manual re-send
 * kind=customer  → upload from the request form (jpg/png only)
 */
export async function upsertEntryPhoto(input: {
  entryId: string;
  kind: EntryPhotoKind;
  contentType: string;
  originalFilename?: string | null;
  bytes: Buffer;
}): Promise<EntryPhotoMeta> {
  const result = await query(
    `INSERT INTO entry_photos (
       entry_id, kind, content_type, original_filename, bytes
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (entry_id, kind) DO UPDATE SET
       content_type = EXCLUDED.content_type,
       original_filename = EXCLUDED.original_filename,
       bytes = EXCLUDED.bytes,
       created_at = NOW()
     RETURNING id, entry_id, kind, content_type, original_filename,
               octet_length(bytes) AS byte_length, created_at`,
    [
      input.entryId,
      input.kind,
      input.contentType,
      input.originalFilename ?? null,
      input.bytes,
    ]
  );
  const row = result.rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    entry_id: String(row.entry_id),
    kind: row.kind as EntryPhotoKind,
    content_type: String(row.content_type),
    original_filename:
      row.original_filename == null ? null : String(row.original_filename),
    byte_length: Number(row.byte_length ?? 0),
    created_at: row.created_at as Date,
  };
}

export async function getEntryPhoto(
  entryId: string,
  kind: EntryPhotoKind
): Promise<EntryPhoto | null> {
  const result = await query(
    `SELECT id, entry_id, kind, content_type, original_filename, bytes, created_at,
            octet_length(bytes) AS byte_length
     FROM entry_photos
     WHERE entry_id = $1 AND kind = $2
     LIMIT 1`,
    [entryId, kind]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    entry_id: String(row.entry_id),
    kind: row.kind as EntryPhotoKind,
    content_type: String(row.content_type),
    original_filename:
      row.original_filename == null ? null : String(row.original_filename),
    byte_length: Number(row.byte_length ?? 0),
    created_at: row.created_at as Date,
    bytes: row.bytes as Buffer,
  };
}

export async function listPhotoFlagsForEntries(
  entryIds: string[]
): Promise<
  Map<string, { has_generated_photo: boolean; has_customer_photo: boolean }>
> {
  const map = new Map<
    string,
    { has_generated_photo: boolean; has_customer_photo: boolean }
  >();
  for (const id of entryIds) {
    map.set(id, { has_generated_photo: false, has_customer_photo: false });
  }
  if (!entryIds.length) return map;

  const result = await query(
    `SELECT entry_id, kind
     FROM entry_photos
     WHERE entry_id = ANY($1::uuid[])`,
    [entryIds]
  );
  for (const row of result.rows) {
    const id = String(row.entry_id);
    const flags = map.get(id) || {
      has_generated_photo: false,
      has_customer_photo: false,
    };
    if (row.kind === "generated") flags.has_generated_photo = true;
    if (row.kind === "customer") flags.has_customer_photo = true;
    map.set(id, flags);
  }
  return map;
}
