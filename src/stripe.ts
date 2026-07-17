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

/** The $5 AAG Archive Graphic. Override with SHOP_PRICE_CENTS if it changes. */
export function shopPriceCents(): number {
  const raw = Number(process.env.SHOP_PRICE_CENTS);
  return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : 500;
}

export const SHOP_CURRENCY = "usd";
export const SHOP_PRODUCT_NAME = "AAG Archive Graphic";
