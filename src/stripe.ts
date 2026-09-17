import Stripe from "stripe";

let stripe: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY?.trim() &&
      process.env.STRIPE_PUBLISHABLE_KEY?.trim()
  );
}

export function stripePublishableKey(): string {
  return process.env.STRIPE_PUBLISHABLE_KEY?.trim() || "";
}

export function getStripe(): Stripe {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    stripe = new Stripe(key);
  }
  return stripe;
}

/** Legacy $5 archive purchase. Kept for historical order rows only. */
export function shopPriceCents(): number {
  const raw = Number(process.env.SHOP_PRICE_CENTS);
  return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : 500;
}

export function membershipPriceCents(): number {
  const raw = Number(process.env.MEMBERSHIP_PRICE_CENTS);
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : 1000;
}

export const SHOP_CURRENCY = "usd";
export const SHOP_PRODUCT_NAME = "AAG Archive Graphic";
export const MEMBERSHIP_PRODUCT_NAME = "AAG Membership";
export const MEMBERSHIP_INTERVAL = "month" as const;

export function membershipPeriodEnd(
  sub: Stripe.Subscription
): Date | null {
  const item = sub.items?.data?.[0] as
    | { current_period_end?: number }
    | undefined;
  const unix =
    (sub as { current_period_end?: number }).current_period_end ??
    item?.current_period_end;
  if (!unix || !Number.isFinite(unix)) return null;
  return new Date(unix * 1000);
}

export async function createMembershipCheckoutSession(input: {
  userId: string;
  email: string;
  customerId?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<Stripe.Checkout.Session> {
  const stripeClient = getStripe();
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    client_reference_id: input.userId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    metadata: { user_id: input.userId },
    subscription_data: {
      metadata: { user_id: input.userId },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: SHOP_CURRENCY,
          unit_amount: membershipPriceCents(),
          recurring: { interval: MEMBERSHIP_INTERVAL },
          product_data: {
            name: MEMBERSHIP_PRODUCT_NAME,
            description:
              "Every AAG graphic, requested from your account for the angel names on your profile.",
          },
        },
      },
    ],
  };

  if (input.customerId) {
    params.customer = input.customerId;
  } else {
    params.customer_email = input.email;
  }

  return stripeClient.checkout.sessions.create(params);
}

export async function createBillingPortalSession(input: {
  customerId: string;
  returnUrl: string;
}): Promise<Stripe.BillingPortal.Session> {
  return getStripe().billingPortal.sessions.create({
    customer: input.customerId,
    return_url: input.returnUrl,
  });
}
