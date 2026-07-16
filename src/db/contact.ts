import { query } from "./pool";

export interface ContactMessage {
  id: string;
  name: string;
  email: string;
  message: string;
  created_at: Date;
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
  const row = result.rows[0];
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    message: row.message as string,
    created_at: row.created_at as Date,
  };
}

export async function listContactMessages(
  limit = 200
): Promise<ContactMessage[]> {
  const result = await query(
    `SELECT * FROM contact_messages
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    message: row.message as string,
    created_at: row.created_at as Date,
  }));
}
