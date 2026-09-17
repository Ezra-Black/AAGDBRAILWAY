import Stripe from "stripe";

let stripe: Stripe | null = null;
let cachedMembershipPrice: MembershipPrice | null = null;

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

export const SHOP_CURRENCY = "usd";
export const SHOP_PRODUCT_NAME = "AAG Archive Graphic";
export const MEMBERSHIP_PRODUCT_NAME = "AAG Membership";
export const MEMBERSHIP_INTERVAL = "month" as const;
export const MEMBERSHIP_PRODUCT_ID = "prod_VH4tnTPpUSwYtz";

export function membershipProductId(): string {
  return process.env.STRIPE_MEMBERSHIP_PRODUCT_ID?.trim() || MEMBERSHIP_PRODUCT_ID;
}

export interface MembershipPrice {
  product_id: string;
  price_id: string;
  price_cents: number;
  currency: string;
  interval: string;
}

export function membershipPriceCentsFallback(): number {
  const raw = Number(process.env.MEMBERSHIP_PRICE_CENTS);
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : 1000;
}

export async function resolveMembershipPrice(): Promise<MembershipPrice> {
  if (cachedMembershipPrice) return cachedMembershipPrice;

  const productId = membershipProductId();
  const envPrice = process.env.STRIPE_MEMBERSHIP_PRICE_ID?.trim();
  const stripeClient = getStripe();

  let price: Stripe.Price | null = null;
  if (envPrice) {
    price = await stripeClient.prices.retrieve(envPrice);
  } else {
    const product = await stripeClient.products.retrieve(productId, {
      expand: ["default_price"],
    });
    const defaultPrice = product.default_price;
    if (typeof defaultPrice === "string") {
      price = await stripeClient.prices.retrieve(defaultPrice);
    } else if (defaultPrice && typeof defaultPrice === "object") {
      price = defaultPrice;
    } else {
      const listed = await stripeClient.prices.list({
        product: productId,
        active: true,
        type: "recurring",
        limit: 10,
      });
      price =
        listed.data.find((row) => row.recurring?.interval === "month") ||
        listed.data[0] ||
        null;
    }
  }

  if (!price?.id) {
    throw new Error(
      `No active recurring price found for Stripe product ${productId}`
    );
  }

  cachedMembershipPrice = {
    product_id: typeof price.product === "string" ? price.product : productId,
    price_id: price.id,
    price_cents: price.unit_amount ?? membershipPriceCentsFallback(),
    currency: (price.currency || SHOP_CURRENCY).toLowerCase(),
    interval: price.recurring?.interval || MEMBERSHIP_INTERVAL,
  };
  return cachedMembershipPrice;
}

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
  const offer = await resolveMembershipPrice();
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
    line_items: [{ price: offer.price_id, quantity: 1 }],
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
