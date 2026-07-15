import { query } from "./pool";

export interface GraphicOption {
  id: string;
  code: string;
  label: string;
  active: boolean;
  sort_order: number;
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
  };
}

/** Dropdown options — includes rows where active is true or null. */
export async function listActiveGraphics(): Promise<GraphicOption[]> {
  const result = await query(
    `SELECT id, code, label, active, sort_order
     FROM graphic_options
     WHERE COALESCE(active, true) = true
     ORDER BY sort_order ASC NULLS LAST, label ASC NULLS LAST`
  );

  return result.rows
    .map((row) => mapGraphic(row as Record<string, unknown>))
    .filter((g): g is GraphicOption => g !== null);
}

/** Admin list — every graphic option. */
export async function listAllGraphics(): Promise<GraphicOption[]> {
  const result = await query(
    `SELECT id, code, label, active, sort_order
     FROM graphic_options
     ORDER BY sort_order ASC NULLS LAST, label ASC NULLS LAST`
  );

  return result.rows
    .map((row) => mapGraphic(row as Record<string, unknown>))
    .filter((g): g is GraphicOption => g !== null);
}

export async function graphicCodeExists(code: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM graphic_options
     WHERE COALESCE(active, true) = true
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
}): Promise<GraphicOption> {
  const sortOrder = Number.isFinite(input.sort_order)
    ? Number(input.sort_order)
    : 0;

  const result = await query(
    `INSERT INTO graphic_options (code, label, active, sort_order)
     VALUES ($1, $2, true, $3)
     RETURNING id, code, label, active, sort_order`,
    [input.code, input.label, sortOrder]
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
    `SELECT id, code, label, active, sort_order
     FROM graphic_options
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  if (!result.rows[0]) return null;
  return mapGraphic(result.rows[0] as Record<string, unknown>);
}
