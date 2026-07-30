import { query } from "./pool";

export type ThreadStatus = "open" | "closed";
export type MessageSender = "user" | "admin";

export interface MessageThread {
  id: string;
  user_id: string;
  subject: string;
  status: ThreadStatus;
  created_at: Date;
  updated_at: Date;
  user_name?: string | null;
  user_email?: string | null;
  last_message_body?: string | null;
  last_message_sender?: MessageSender | null;
  last_message_at?: Date | null;
  unread_count?: number;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  sender: MessageSender;
  body: string;
  created_at: Date;
  read_at: Date | null;
}

function mapThread(row: Record<string, unknown>): MessageThread {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    subject: row.subject as string,
    status: row.status as ThreadStatus,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    user_name:
      row.user_name !== undefined
        ? ((row.user_name as string) ?? null)
        : undefined,
    user_email:
      row.user_email !== undefined
        ? ((row.user_email as string) ?? null)
        : undefined,
    last_message_body:
      row.last_message_body !== undefined
        ? ((row.last_message_body as string) ?? null)
        : undefined,
    last_message_sender:
      row.last_message_sender !== undefined
        ? ((row.last_message_sender as MessageSender) ?? null)
        : undefined,
    last_message_at:
      row.last_message_at !== undefined
        ? ((row.last_message_at as Date) ?? null)
        : undefined,
    unread_count:
      row.unread_count !== undefined
        ? Number(row.unread_count) || 0
        : undefined,
  };
}

function mapMessage(row: Record<string, unknown>): ThreadMessage {
  return {
    id: row.id as string,
    thread_id: row.thread_id as string,
    sender: row.sender as MessageSender,
    body: row.body as string,
    created_at: row.created_at as Date,
    read_at: (row.read_at as Date) ?? null,
  };
}

/** Start a contact conversation: thread + first user message. */
export async function createThreadWithMessage(input: {
  user_id: string;
  subject?: string;
  body: string;
}): Promise<{ thread: MessageThread; message: ThreadMessage }> {
  const threadResult = await query(
    `INSERT INTO message_threads (user_id, subject)
     VALUES ($1, $2)
     RETURNING *`,
    [input.user_id, input.subject?.trim() || "Contact message"]
  );
  const thread = mapThread(threadResult.rows[0]);

  const msgResult = await query(
    `INSERT INTO thread_messages (thread_id, sender, body)
     VALUES ($1, 'user', $2)
     RETURNING *`,
    [thread.id, input.body]
  );

  return { thread, message: mapMessage(msgResult.rows[0]) };
}

export async function listThreadsForAdmin(
  limit = 200
): Promise<MessageThread[]> {
  const result = await query(
    `SELECT t.*,
            u.name AS user_name,
            u.email AS user_email,
            lm.body AS last_message_body,
            lm.sender AS last_message_sender,
            lm.created_at AS last_message_at,
            (
              SELECT COUNT(*)::int
              FROM thread_messages m
              WHERE m.thread_id = t.id
                AND m.sender = 'user'
                AND m.read_at IS NULL
            ) AS unread_count
     FROM message_threads t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN LATERAL (
       SELECT body, sender, created_at
       FROM thread_messages
       WHERE thread_id = t.id
       ORDER BY created_at DESC
       LIMIT 1
     ) lm ON true
     ORDER BY t.updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapThread);
}

export async function listThreadsForUser(
  userId: string,
  limit = 100
): Promise<MessageThread[]> {
  const result = await query(
    `SELECT t.*,
            lm.body AS last_message_body,
            lm.sender AS last_message_sender,
            lm.created_at AS last_message_at,
            (
              SELECT COUNT(*)::int
              FROM thread_messages m
              WHERE m.thread_id = t.id
                AND m.sender = 'admin'
                AND m.read_at IS NULL
            ) AS unread_count
     FROM message_threads t
     LEFT JOIN LATERAL (
       SELECT body, sender, created_at
       FROM thread_messages
       WHERE thread_id = t.id
       ORDER BY created_at DESC
       LIMIT 1
     ) lm ON true
     WHERE t.user_id = $1
     ORDER BY t.updated_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map(mapThread);
}

export async function getThreadById(
  id: string
): Promise<MessageThread | null> {
  const result = await query(
    `SELECT t.*, u.name AS user_name, u.email AS user_email
     FROM message_threads t
     JOIN users u ON u.id = t.user_id
     WHERE t.id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] ? mapThread(result.rows[0]) : null;
}

export async function listMessagesForThread(
  threadId: string
): Promise<ThreadMessage[]> {
  const result = await query(
    `SELECT * FROM thread_messages
     WHERE thread_id = $1
     ORDER BY created_at ASC`,
    [threadId]
  );
  return result.rows.map(mapMessage);
}

export async function addMessageToThread(input: {
  thread_id: string;
  sender: MessageSender;
  body: string;
}): Promise<ThreadMessage | null> {
  const thread = await getThreadById(input.thread_id);
  if (!thread || thread.status === "closed") return null;

  const result = await query(
    `INSERT INTO thread_messages (thread_id, sender, body)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.thread_id, input.sender, input.body]
  );

  await query(
    `UPDATE message_threads SET updated_at = NOW() WHERE id = $1`,
    [input.thread_id]
  );

  return mapMessage(result.rows[0]);
}

/** Mark messages from the other party as read. */
export async function markThreadRead(input: {
  thread_id: string;
  /** Whose messages to mark read (the other party's sender). */
  sender: MessageSender;
}): Promise<void> {
  await query(
    `UPDATE thread_messages
     SET read_at = NOW()
     WHERE thread_id = $1
       AND sender = $2
       AND read_at IS NULL`,
    [input.thread_id, input.sender]
  );
}

export async function setThreadStatus(input: {
  id: string;
  status: ThreadStatus;
}): Promise<MessageThread | null> {
  const result = await query(
    `UPDATE message_threads
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [input.id, input.status]
  );
  return result.rows[0] ? mapThread(result.rows[0]) : null;
}
