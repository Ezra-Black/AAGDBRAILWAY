import { query } from "./pool";

export interface ContactMessage {
  id: string;
  name: string;
  email: string;
  message: string;
  created_at: Date;
  read_at: Date | null;
  archived_at: Date | null;
}

export interface AdminContactFilters {
  search?: string;
  unreadOnly?: boolean;
  archived?: boolean;
}

function mapRow(row: Record<string, unknown>): ContactMessage {
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    message: row.message as string,
    created_at: row.created_at as Date,
    read_at: (row.read_at as Date) ?? null,
    archived_at: (row.archived_at as Date) ?? null,
  };
}

export async function createContactMessage(input: {
  name: string;
  email: string;
  message: string;
}): Promise<ContactMessage> {
  const result = await query(
    `INSERT INTO contact_messages (name, email, message)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.name, input.email, input.message]
  );
  return mapRow(result.rows[0]);
}

export async function listContactMessages(
  limit = 200,
  filters: AdminContactFilters = {}
): Promise<ContactMessage[]> {
  const params: unknown[] = [limit];
  const clauses = [
    filters.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL",
  ];
  if (filters.unreadOnly) {
    clauses.push("read_at IS NULL");
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim()}%`);
    const n = params.length;
    clauses.push(
      `(name ILIKE $${n} OR email ILIKE $${n} OR message ILIKE $${n})`
    );
  }
  const result = await query(
    `SELECT * FROM contact_messages
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $1`,
    params
  );
  return result.rows.map(mapRow);
}

export interface ContactMessageCounts {
  /** Unarchived messages. */
  inbox: number;
  /** Unarchived and unread — drives the tab badge. */
  unread: number;
  archived: number;
}

export async function contactMessageCounts(): Promise<ContactMessageCounts> {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE archived_at IS NULL)::int AS inbox,
       COUNT(*) FILTER (WHERE archived_at IS NULL AND read_at IS NULL)::int AS unread,
       COUNT(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived
     FROM contact_messages`
  );
  const row = result.rows[0] ?? {};
  return {
    inbox: Number(row.inbox) || 0,
    unread: Number(row.unread) || 0,
    archived: Number(row.archived) || 0,
  };
}

/** Mark one message read or back to unread. */
export async function setContactMessageRead(
  id: string,
  read: boolean
): Promise<ContactMessage | null> {
  const result = await query(
    `UPDATE contact_messages
     SET read_at = ${read ? "COALESCE(read_at, NOW())" : "NULL"}
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Archive (or restore) a single message. Nothing is ever deleted. */
export async function setContactMessageArchived(
  id: string,
  archived: boolean
): Promise<ContactMessage | null> {
  const result = await query(
    `UPDATE contact_messages
     SET archived_at = ${archived ? "NOW()" : "NULL"},
         read_at = ${archived ? "COALESCE(read_at, NOW())" : "read_at"}
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Bulk clean-up: mark every unarchived message read. */
export async function markAllContactMessagesRead(): Promise<number> {
  const result = await query(
    `UPDATE contact_messages
     SET read_at = NOW()
     WHERE read_at IS NULL AND archived_at IS NULL`
  );
  return result.rowCount ?? 0;
}
