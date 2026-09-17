import type Stripe from "stripe";
import { getUserById } from "./db/users";
import {
  getUserIdByStripeCustomerId,
  getUserIdByStripeSubscriptionId,
  upsertSubscriptionFromStripe,
} from "./db/subscriptions";
import { membershipPeriodEnd } from "./stripe";
import { logger } from "./logger";

export async function syncStripeSubscription(
  sub: Stripe.Subscription,
  userIdHint?: string | null
): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id || null;
  const metaUser = sub.metadata?.user_id?.trim() || userIdHint?.trim() || "";
  let userId =
    metaUser ||
    (await getUserIdByStripeSubscriptionId(sub.id)) ||
    (customerId ? await getUserIdByStripeCustomerId(customerId) : null);

  if (userId && !(await getUserById(userId))) userId = null;
  if (!userId) {
    logger.warn("Stripe subscription had no matching user", {
      subscription: sub.id,
      customer: customerId,
    });
    return;
  }

  await upsertSubscriptionFromStripe({
    userId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    status: String(sub.status),
    currentPeriodEnd: membershipPeriodEnd(sub),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  });
}

export async function syncCheckoutSession(
  session: Stripe.Checkout.Session,
  stripe: Stripe
): Promise<void> {
  if (session.mode !== "subscription") return;
  const subId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;
  if (!subId) return;
  const userId =
    session.client_reference_id?.trim() ||
    session.metadata?.user_id?.trim() ||
    null;
  const sub = await stripe.subscriptions.retrieve(subId);
  await syncStripeSubscription(sub, userId);
}
