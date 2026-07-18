import { query } from "./pool";

export interface GraphicOption {
  id: string;
  code: string;
  label: string;
  active: boolean;
  sort_order: number;
  expires_at: string | null;
  vaulted_at: string | null;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapGraphic(row: Record<string, unknown>): GraphicOption | null {
  const code = String(row.code ?? "").trim() || String(row.label ?? "").trim();
  const label = String(row.label ?? "").trim() || code;
  if (!code) return null;

  return {
    id: String(row.id),
    code,
    label,
    active: row.active !== false && row.active !== "false",
    sort_order: Number(row.sort_order ?? 0),
    expires_at: toIso(row.expires_at),
    vaulted_at: toIso(row.vaulted_at),
  };
}

/** An offer is requestable while it's active, unvaulted, and unexpired. */
const OFFER_OPEN_CLAUSE = `
  COALESCE(active, true) = true
  AND vaulted_at IS NULL
  AND (expires_at IS NULL OR expires_at > NOW())
`;

/** Dropdown / offer-card options — open offers only. */
export async function listActiveGraphics(): Promise<GraphicOption[]> {
  const result = await query(
    `SELECT id, code, label, active, sort_order, expires_at, vaulted_at
     FROM graphic_options
     WHERE ${OFFER_OPEN_CLAUSE}
     ORDER BY sort_order ASC NULLS LAST, label ASC NULLS LAST`
  );

  return result.rows
    .map((row) => mapGraphic(row as Record<string, unknown>))
    .filter((g): g is GraphicOption => g !== null);
}

/** Admin list — every graphic option, including vaulted ones. */
export async function listAllGraphics(): Promise<GraphicOption[]> {
  const result = await query(
    `SELECT id, code, label, active, sort_order, expires_at, vaulted_at
     FROM graphic_options
     ORDER BY (vaulted_at IS NOT NULL) ASC,
              sort_order ASC NULLS LAST, label ASC NULLS LAST`
  );

  return result.rows
    .map((row) => mapGraphic(row as Record<string, unknown>))
    .filter((g): g is GraphicOption => g !== null);
}

export async function graphicCodeExists(code: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM graphic_options
     WHERE ${OFFER_OPEN_CLAUSE}
       AND (
         lower(trim(code)) = lower(trim($1))
         OR lower(trim(label)) = lower(trim($1))
       )
     LIMIT 1`,
    [code]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function createGraphicOption(input: {
  code: string;
  label: string;
  sort_order?: number;
  expires_at?: Date | null;
}): Promise<GraphicOption> {
  const sortOrder = Number.isFinite(input.sort_order)
    ? Number(input.sort_order)
    : 0;

  const result = await query(
    `INSERT INTO graphic_options (code, label, active, sort_order, expires_at)
     VALUES ($1, $2, true, $3, $4)
     RETURNING id, code, label, active, sort_order, expires_at, vaulted_at`,
    [input.code, input.label, sortOrder, input.expires_at ?? null]
  );

  const mapped = mapGraphic(result.rows[0] as Record<string, unknown>);
  if (!mapped) {
    throw new Error("Failed to create graphic option");
  }
  return mapped;
}

export async function deleteGraphicOption(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM graphic_options WHERE id = $1 RETURNING id`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getGraphicById(id: string): Promise<GraphicOption | null> {
  const result = await query(
    `SELECT id, code, label, active, sort_order, expires_at, vaulted_at
     FROM graphic_options
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  if (!result.rows[0]) return null;
  return mapGraphic(result.rows[0] as Record<string, unknown>);
}

/**
 * Sweep: close every offer whose countdown hit zero. Sets vaulted_at so the
 * offer is permanently off the request form, and flags it for the admin
 * notification bell. Returns how many offers were vaulted this pass.
 */
export async function vaultExpiredGraphics(): Promise<number> {
  const result = await query(
    `UPDATE graphic_options
     SET active = false,
         vaulted_at = NOW(),
         vault_acknowledged = false
     WHERE vaulted_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()`
  );
  return result.rowCount ?? 0;
}

/** Admin action: vault an offer immediately, before its timer runs out. */
export async function vaultGraphicOption(
  id: string
): Promise<GraphicOption | null> {
  const result = await query(
    `UPDATE graphic_options
     SET active = false,
         vaulted_at = NOW(),
         vault_acknowledged = true
     WHERE id = $1
       AND vaulted_at IS NULL
     RETURNING id, code, label, active, sort_order, expires_at, vaulted_at`,
    [id]
  );
  if (!result.rows[0]) return null;
  return mapGraphic(result.rows[0] as Record<string, unknown>);
}

/** Auto-vaulted offers the admins haven't dismissed yet (notification bell). */
export async function listUnacknowledgedVaulted(): Promise<GraphicOption[]> {
  const result = await query(
    `SELECT id, code, label, active, sort_order, expires_at, vaulted_at
     FROM graphic_options
     WHERE vaulted_at IS NOT NULL
       AND vault_acknowledged = false
     ORDER BY vaulted_at DESC`
  );
  return result.rows
    .map((row) => mapGraphic(row as Record<string, unknown>))
    .filter((g): g is GraphicOption => g !== null);
}

/** Dismiss all vault notifications. */
export async function acknowledgeVaultedGraphics(): Promise<number> {
  const result = await query(
    `UPDATE graphic_options
     SET vault_acknowledged = true
     WHERE vaulted_at IS NOT NULL
       AND vault_acknowledged = false`
  );
  return result.rowCount ?? 0;
}
