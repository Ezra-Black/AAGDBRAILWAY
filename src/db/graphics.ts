import { query } from "./pool";

export interface GraphicOption {
  id: string;
  code: string;
  label: string;
  active: boolean;
  sort_order: number;
}

export async function listActiveGraphics(): Promise<GraphicOption[]> {
  const result = await query(
    `SELECT id, code, label, active, sort_order
     FROM graphic_options
     WHERE active = true
     ORDER BY sort_order ASC, label ASC`
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    code: row.code as string,
    label: row.label as string,
    active: row.active as boolean,
    sort_order: row.sort_order as number,
  }));
}

export async function graphicCodeExists(code: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM graphic_options
     WHERE code = $1 AND active = true
     LIMIT 1`,
    [code]
  );
  return result.rowCount !== null && result.rowCount > 0;
}
