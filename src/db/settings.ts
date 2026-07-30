import { query } from "./pool";

export const AI_WORKER_ENABLED_KEY = "ai_worker_enabled";

export async function getSettingJson(key: string): Promise<unknown> {
  const result = await query(
    `SELECT value FROM site_settings WHERE key = $1 LIMIT 1`,
    [key]
  );
  if (!result.rows[0]) return null;
  return result.rows[0].value;
}

export async function setSettingJson(
  key: string,
  value: unknown
): Promise<void> {
  await query(
    `INSERT INTO site_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

/** When false, the graphic worker must not claim or process entries. */
export async function isAiWorkerEnabled(): Promise<boolean> {
  const value = await getSettingJson(AI_WORKER_ENABLED_KEY);
  // Default ON if unset so a missing row never bricks automation.
  if (value === null || value === undefined) return true;
  return value === true || value === "true";
}

export async function setAiWorkerEnabled(enabled: boolean): Promise<boolean> {
  await setSettingJson(AI_WORKER_ENABLED_KEY, enabled);
  return enabled;
}
