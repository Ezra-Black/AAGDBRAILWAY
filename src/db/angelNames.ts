import { query } from "./pool";

export const STANDARD_ANGEL_NAME_CAP = 5;

export type AngelSlotKind = "standard" | "extra";
export type AngelNameRequestType = "remove" | "extra_slot";
export type AngelNameRequestStatus = "pending" | "approved" | "denied";

export interface UserAngelName {
  id: string;
  user_id: string;
  name: string;
  slot_kind: AngelSlotKind;
  created_at: Date;
  removed_at: Date | null;
}

export interface AngelNameRequest {
  id: string;
  user_id: string;
  type: AngelNameRequestType;
  angel_name_id: string | null;
  requested_name: string | null;
  status: AngelNameRequestStatus;
  user_note: string | null;
  admin_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  user_email?: string | null;
  user_display_name?: string | null;
  angel_name?: string | null;
}

function mapName(row: Record<string, unknown>): UserAngelName {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name),
    slot_kind: (row.slot_kind as AngelSlotKind) || "standard",
    created_at: row.created_at as Date,
    removed_at: (row.removed_at as Date) ?? null,
  };
}

function mapRequest(row: Record<string, unknown>): AngelNameRequest {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    type: row.type as AngelNameRequestType,
    angel_name_id: row.angel_name_id ? String(row.angel_name_id) : null,
    requested_name: row.requested_name ? String(row.requested_name) : null,
    status: row.status as AngelNameRequestStatus,
    user_note: row.user_note ? String(row.user_note) : null,
    admin_note: row.admin_note ? String(row.admin_note) : null,
    reviewed_by: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewed_at: (row.reviewed_at as Date) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    user_email: row.user_email ? String(row.user_email) : null,
    user_display_name: row.user_display_name
      ? String(row.user_display_name)
      : null,
    angel_name: row.angel_name ? String(row.angel_name) : null,
  };
}

export async function listLiveAngelNames(
  userId: string
): Promise<UserAngelName[]> {
  const result = await query(
    `SELECT * FROM user_angel_names
     WHERE user_id = $1 AND removed_at IS NULL
     ORDER BY created_at ASC`,
    [userId]
  );
  return result.rows.map((row) => mapName(row as Record<string, unknown>));
}

export async function getLiveAngelNameById(
  userId: string,
  id: string
): Promise<UserAngelName | null> {
  const result = await query(
    `SELECT * FROM user_angel_names
     WHERE id = $1 AND user_id = $2 AND removed_at IS NULL
     LIMIT 1`,
    [id, userId]
  );
  return result.rows[0]
    ? mapName(result.rows[0] as Record<string, unknown>)
    : null;
}

export async function getExtraAngelSlots(userId: string): Promise<number> {
  const result = await query(
    `SELECT extra_angel_slots FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  return Math.max(0, Number(result.rows[0]?.extra_angel_slots ?? 0));
}

export function maxAngelNames(extraSlots: number): number {
  return STANDARD_ANGEL_NAME_CAP + Math.max(0, extraSlots);
}

export async function addAngelName(input: {
  userId: string;
  name: string;
}): Promise<UserAngelName> {
  const name = input.name.trim();
  const live = await listLiveAngelNames(input.userId);
  if (live.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
    const err = new Error("That angel name is already on this profile.");
    (err as Error & { code: string }).code = "DUPLICATE_NAME";
    throw err;
  }

  const extra = await getExtraAngelSlots(input.userId);
  const cap = maxAngelNames(extra);
  if (live.length >= cap) {
    const err = new Error(
      live.length >= STANDARD_ANGEL_NAME_CAP && extra === 0
        ? "You can list up to 5 angel names. Ask the AAG team if you need a special accommodation."
        : `You already have ${cap} angel names on this profile.`
    );
    (err as Error & { code: string }).code = "CAP_REACHED";
    throw err;
  }

  const standardCount = live.filter((row) => row.slot_kind === "standard")
    .length;
  const slotKind: AngelSlotKind =
    standardCount < STANDARD_ANGEL_NAME_CAP ? "standard" : "extra";

  const result = await query(
    `INSERT INTO user_angel_names (user_id, name, slot_kind)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.userId, name, slotKind]
  );
  return mapName(result.rows[0] as Record<string, unknown>);
}

export async function createAngelNameRequest(input: {
  userId: string;
  type: AngelNameRequestType;
  angelNameId?: string | null;
  userNote?: string | null;
}): Promise<AngelNameRequest> {
  if (input.type === "remove") {
    const row = input.angelNameId
      ? await getLiveAngelNameById(input.userId, input.angelNameId)
      : null;
    if (!row) {
      const err = new Error("That angel name is not on your profile.");
      (err as Error & { code: string }).code = "NOT_FOUND";
      throw err;
    }
    const existing = await query(
      `SELECT 1 FROM angel_name_requests
       WHERE user_id = $1 AND angel_name_id = $2 AND type = 'remove'
         AND status = 'pending'
       LIMIT 1`,
      [input.userId, row.id]
    );
    if ((existing.rowCount ?? 0) > 0) {
      const err = new Error(
        "A removal request for that name is already with the AAG team."
      );
      (err as Error & { code: string }).code = "ALREADY_PENDING";
      throw err;
    }
    const result = await query(
      `INSERT INTO angel_name_requests
         (user_id, type, angel_name_id, requested_name, user_note)
       VALUES ($1, 'remove', $2, $3, $4)
       RETURNING *`,
      [input.userId, row.id, row.name, input.userNote ?? null]
    );
    return mapRequest(result.rows[0] as Record<string, unknown>);
  }

  const pendingExtra = await query(
    `SELECT 1 FROM angel_name_requests
     WHERE user_id = $1 AND type = 'extra_slot' AND status = 'pending'
     LIMIT 1`,
    [input.userId]
  );
  if ((pendingExtra.rowCount ?? 0) > 0) {
    const err = new Error(
      "A special-accommodation request is already with the AAG team."
    );
    (err as Error & { code: string }).code = "ALREADY_PENDING";
    throw err;
  }

  const result = await query(
    `INSERT INTO angel_name_requests (user_id, type, user_note)
     VALUES ($1, 'extra_slot', $2)
     RETURNING *`,
    [input.userId, input.userNote ?? null]
  );
  return mapRequest(result.rows[0] as Record<string, unknown>);
}

export async function listPendingAngelNameRequestsForUser(
  userId: string
): Promise<AngelNameRequest[]> {
  const result = await query(
    `SELECT * FROM angel_name_requests
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => mapRequest(row as Record<string, unknown>));
}

export async function listAngelNameRequestsForAdmin(input: {
  status?: AngelNameRequestStatus | "all";
  limit?: number;
}): Promise<AngelNameRequest[]> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const status =
    input.status && input.status !== "all" ? input.status : null;
  const result = status
    ? await query(
        `SELECT r.*,
                u.email AS user_email,
                u.name AS user_display_name,
                n.name AS angel_name
         FROM angel_name_requests r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN user_angel_names n ON n.id = r.angel_name_id
         WHERE r.status = $1
         ORDER BY r.created_at DESC
         LIMIT $2`,
        [status, limit]
      )
    : await query(
        `SELECT r.*,
                u.email AS user_email,
                u.name AS user_display_name,
                n.name AS angel_name
         FROM angel_name_requests r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN user_angel_names n ON n.id = r.angel_name_id
         ORDER BY
           CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
           r.created_at DESC
         LIMIT $1`,
        [limit]
      );
  return result.rows.map((row) => mapRequest(row as Record<string, unknown>));
}

export async function reviewAngelNameRequest(input: {
  id: string;
  adminId: string;
  status: "approved" | "denied";
  adminNote?: string | null;
}): Promise<AngelNameRequest | null> {
  const current = await query(
    `SELECT * FROM angel_name_requests WHERE id = $1 LIMIT 1`,
    [input.id]
  );
  if (!current.rows[0]) return null;
  const row = mapRequest(current.rows[0] as Record<string, unknown>);
  if (row.status !== "pending") {
    const err = new Error("That request was already reviewed.");
    (err as Error & { code: string }).code = "ALREADY_REVIEWED";
    throw err;
  }

  if (input.status === "approved" && row.type === "remove" && row.angel_name_id) {
    await query(
      `UPDATE user_angel_names
       SET removed_at = NOW(), removed_by_admin_id = $2
       WHERE id = $1 AND removed_at IS NULL`,
      [row.angel_name_id, input.adminId]
    );
  }

  if (input.status === "approved" && row.type === "extra_slot") {
    await query(
      `UPDATE users
       SET extra_angel_slots = extra_angel_slots + 1, updated_at = NOW()
       WHERE id = $1`,
      [row.user_id]
    );
  }

  const result = await query(
    `UPDATE angel_name_requests
     SET status = $2,
         admin_note = $3,
         reviewed_by = $4,
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [input.id, input.status, input.adminNote ?? null, input.adminId]
  );
  return mapRequest(result.rows[0] as Record<string, unknown>);
}

export async function pendingAngelNameRequestCount(): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::int AS n FROM angel_name_requests WHERE status = 'pending'`
  );
  return Number(result.rows[0]?.n ?? 0);
}
