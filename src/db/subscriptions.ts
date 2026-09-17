import { query } from "./pool";

export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export interface UserSubscription {
  id: string;
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapSub(row: Record<string, unknown>): UserSubscription {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    stripe_customer_id: row.stripe_customer_id
      ? String(row.stripe_customer_id)
      : null,
    stripe_subscription_id: row.stripe_subscription_id
      ? String(row.stripe_subscription_id)
      : null,
    status: String(row.status),
    current_period_end: (row.current_period_end as Date) ?? null,
    cancel_at_period_end: Boolean(row.cancel_at_period_end),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

export function isSubscriptionActive(
  sub: UserSubscription | null | undefined
): boolean {
  if (!sub) return false;
  if (sub.status !== "active" && sub.status !== "trialing") return false;
  if (sub.current_period_end && sub.current_period_end.getTime() < Date.now()) {
    return false;
  }
  return true;
}

export async function getSubscriptionForUser(
  userId: string
): Promise<UserSubscription | null> {
  const result = await query(
    `SELECT * FROM subscriptions WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return result.rows[0]
    ? mapSub(result.rows[0] as Record<string, unknown>)
    : null;
}

export async function userHasActiveSubscription(
  userId: string
): Promise<boolean> {
  const sub = await getSubscriptionForUser(userId);
  return isSubscriptionActive(sub);
}

export async function setUserStripeCustomerId(
  userId: string,
  customerId: string
): Promise<void> {
  await query(
    `UPDATE users SET stripe_customer_id = $2, updated_at = NOW() WHERE id = $1`,
    [userId, customerId]
  );
}

export async function getUserIdByStripeCustomerId(
  customerId: string
): Promise<string | null> {
  const result = await query(
    `SELECT id FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId]
  );
  if (result.rows[0]) return String(result.rows[0].id);
  const sub = await query(
    `SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId]
  );
  return sub.rows[0] ? String(sub.rows[0].user_id) : null;
}

export async function upsertSubscriptionFromStripe(input: {
  userId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}): Promise<UserSubscription> {
  const result = await query(
    `INSERT INTO subscriptions
       (user_id, stripe_customer_id, stripe_subscription_id, status,
        current_period_end, cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       status = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = NOW()
     RETURNING *`,
    [
      input.userId,
      input.stripeCustomerId,
      input.stripeSubscriptionId,
      input.status,
      input.currentPeriodEnd,
      input.cancelAtPeriodEnd,
    ]
  );
  if (input.stripeCustomerId) {
    await setUserStripeCustomerId(input.userId, input.stripeCustomerId);
  }
  return mapSub(result.rows[0] as Record<string, unknown>);
}

export async function getUserIdByStripeSubscriptionId(
  subscriptionId: string
): Promise<string | null> {
  const result = await query(
    `SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
    [subscriptionId]
  );
  return result.rows[0] ? String(result.rows[0].user_id) : null;
}

export async function listSubscriptionsForAdmin(limit = 200): Promise<
  Array<UserSubscription & { email: string; name: string }>
> {
  const result = await query(
    `SELECT s.*, u.email, u.name
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     ORDER BY s.updated_at DESC
     LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)]
  );
  return result.rows.map((row) => ({
    ...mapSub(row as Record<string, unknown>),
    email: String(row.email),
    name: String(row.name),
  }));
}
