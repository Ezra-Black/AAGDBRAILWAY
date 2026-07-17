import { Router, type Request, type Response, type NextFunction } from "express";
import {
  loginAdmin,
  logoutAdmin,
  requireAdmin,
  setSessionCookie,
  type AdminRequest,
} from "./auth";
import {
  archiveCompletedEntries,
  createEntry,
  emailExistsInEntries,
  findRecentDuplicateClaim,
  getEntryByAngelName,
  getEntryById,
  getEntryByRealName,
  listAngelGroupsForAdmin,
  listEntries,
  listPending,
  markAngelNameComplete,
  setAngelNameArchived,
  updateEntryStatus,
} from "./db/entries";
import { createAdmin, getAdminByEmail } from "./db/admins";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { graphicCodeExists, listActiveGraphics, createGraphicOption, deleteGraphicOption, listAllGraphics } from "./db/graphics";
import { logger } from "./logger";
import {
  checkoutLimiter,
  contactLimiter,
  facebookAuthLimiter,
  loginLimiter,
  newsletterSubscribeLimiter,
  newsletterVisitLimiter,
  readLimiter,
  rejectHoneypot,
  requireAutomationKeyIfConfigured,
  submitLimiter,
  trackLimiter,
} from "./security";
import {
  bumpNewsletterCount,
  getNewsletterCount,
  subscribeNewsletter,
} from "./db/stats";
import { createContactMessage, listContactMessages } from "./db/contact";
import { getAnalyticsSummary, recordPageView } from "./db/analytics";
import {
  archiveGraphicOption,
  archivePaidPurchases,
  createPurchase,
  getArchiveGraphicByCode,
  getPurchaseByIntent,
  listArchiveGraphics,
  listPurchasesForAdmin,
  markPurchaseStatusByIntent,
  setPurchaseArchived,
} from "./db/shop";
import {
  getStripe,
  SHOP_CURRENCY,
  SHOP_PRODUCT_NAME,
  shopPriceCents,
  stripeConfigured,
  stripePublishableKey,
} from "./stripe";
import { upsertFacebookUser } from "./db/facebook";
import {
  facebookAppId,
  facebookConfigured,
  verifyFacebookToken,
} from "./facebook";
import { sendContactEmail } from "./email";
import {
  adminGraphicCreateSchema,
  adminJoinCheckSchema,
  adminJoinSchema,
  adminLoginSchema,
  contactSchema,
  facebookAuthSchema,
  lookupQuerySchema,
  newsletterSubscribeSchema,
  pageViewSchema,
  PASSWORD_RULES,
  shopCheckoutSchema,
  shopConfirmSchema,
  statusSchema,
  submitSchema,
  uuidSchema,
} from "./validation";

export const apiRouter = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** POST /admin/login */
apiRouter.post(
  "/admin/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await loginAdmin(parsed.data.email, parsed.data.password);
    if (!result) {
      res.status(401).json({ success: false, error: "Invalid email or password" });
      return;
    }

    setSessionCookie(res, result.token);
    logger.info("Admin logged in", { email: result.admin.email });
    res.json({ success: true, admin: result.admin });
  })
);

/**
 * POST /admin/join/check — email must already exist in form submissions
 * and must not already be an admin.
 */
apiRouter.post(
  "/admin/join/check",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = adminJoinCheckSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Enter a valid email",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const email = parsed.data.email;
    const alreadyAdmin = await getAdminByEmail(email);
    if (alreadyAdmin) {
      res.status(409).json({
        success: false,
        error: "That email already has an admin account. Please log in.",
      });
      return;
    }

    const known = await emailExistsInEntries(email);
    if (!known) {
      res.status(403).json({
        success: false,
        error:
          "That email isn’t in our request database yet. Submit the form first, then join as admin.",
      });
      return;
    }

    res.json({
      success: true,
      email,
      password_rules: PASSWORD_RULES,
      message: "Email verified. Create a strong password to finish joining.",
    });
  })
);

/** POST /admin/join — create admin account for a known submission email */
apiRouter.post(
  "/admin/join",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = adminJoinSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
        password_rules: PASSWORD_RULES,
      });
      return;
    }

    const { email, password } = parsed.data;

    const alreadyAdmin = await getAdminByEmail(email);
    if (alreadyAdmin) {
      res.status(409).json({
        success: false,
        error: "That email already has an admin account. Please log in.",
      });
      return;
    }

    const known = await emailExistsInEntries(email);
    if (!known) {
      res.status(403).json({
        success: false,
        error:
          "That email isn’t in our request database yet. Submit the form first, then join as admin.",
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await createAdmin(email, passwordHash);

    logger.info("New admin registered via join", { email: admin.email });
    res.status(201).json({
      success: true,
      message: "Account created. You can log in now.",
      admin: { id: admin.id, email: admin.email },
    });
  })
);

/** POST /admin/logout */
apiRouter.post(
  "/admin/logout",
  asyncHandler(async (req, res) => {
    await logoutAdmin(req, res);
    res.json({ success: true });
  })
);

/** GET /admin/me — current session */
apiRouter.get(
  "/admin/me",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    res.json({ success: true, admin: req.admin });
  })
);

/** GET /admin/entries — angel names grouped with graphics + all emails.
 *  Query params: graphic_code, q (search), status (pending|complete), archived (1/true).
 */
apiRouter.get(
  "/admin/entries",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const graphicCode =
      typeof req.query.graphic_code === "string"
        ? req.query.graphic_code.trim()
        : "";
    const search =
      typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const statusRaw =
      typeof req.query.status === "string" ? req.query.status.trim() : "";
    const status =
      statusRaw === "pending" || statusRaw === "complete" ? statusRaw : null;
    const archived =
      req.query.archived === "1" || req.query.archived === "true";

    const groups = await listAngelGroupsForAdmin(2000, {
      graphicCode: graphicCode || null,
      search: search || undefined,
      status,
      archived,
    });
    res.json({
      success: true,
      count: groups.length,
      filter: graphicCode || null,
      archived,
      groups,
    });
  })
);

/** PATCH /admin/angel-names/archive — archive or restore all rows for a name */
apiRouter.patch(
  "/admin/angel-names/archive",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        angel_name: z.string().trim().min(1).max(120),
        archived: z.boolean(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: "angel_name and archived are required" });
      return;
    }

    const updated = await setAngelNameArchived(
      parsed.data.angel_name,
      parsed.data.archived
    );
    logger.info("Admin toggled angel name archive", {
      angel_name: parsed.data.angel_name,
      archived: parsed.data.archived,
      updated,
    });
    res.json({ success: true, updated });
  })
);

/** POST /admin/entries/archive-completed — bulk clean-up of finished requests */
apiRouter.post(
  "/admin/entries/archive-completed",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const updated = await archiveCompletedEntries();
    logger.info("Admin archived completed entries", { updated });
    res.json({ success: true, updated });
  })
);

/** GET /admin/graphics — manage dropdown options */
apiRouter.get(
  "/admin/graphics",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const graphics = await listAllGraphics();
    res.json({ success: true, count: graphics.length, graphics });
  })
);

/** POST /admin/graphics — add a graphic option */
apiRouter.post(
  "/admin/graphics",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = adminGraphicCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const graphic = await createGraphicOption(parsed.data);
      // Every option ever offered is tracked in the archive for the shop.
      await archiveGraphicOption(graphic);
      logger.info("Admin created graphic option", {
        id: graphic.id,
        code: graphic.code,
      });
      res.status(201).json({ success: true, graphic });
    } catch (err) {
      const pgCode =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      if (pgCode === "23505") {
        res.status(409).json({
          success: false,
          error: "A graphic with that code already exists",
        });
        return;
      }
      throw err;
    }
  })
);

/** DELETE /admin/graphics/:id — remove a graphic option */
apiRouter.delete(
  "/admin/graphics/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid graphic ID" });
      return;
    }

    const removed = await deleteGraphicOption(idCheck.data);
    if (!removed) {
      res.status(404).json({ success: false, error: "Graphic not found" });
      return;
    }

    logger.info("Admin deleted graphic option", { id: idCheck.data });
    res.json({ success: true });
  })
);

/** PATCH /admin/angel-names/complete — mark all rows for a name as processed */
apiRouter.patch(
  "/admin/angel-names/complete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ angel_name: z.string().trim().min(1).max(120) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "angel_name is required" });
      return;
    }

    const updated = await markAngelNameComplete(parsed.data.angel_name);
    logger.info("Admin marked angel name complete", {
      angel_name: parsed.data.angel_name,
      updated,
    });
    res.json({ success: true, updated });
  })
);

/** GET /graphics — active dropdown options (codes + labels from DB) */
apiRouter.get(
  "/graphics",
  readLimiter,
  asyncHandler(async (_req, res) => {
    const graphics = await listActiveGraphics();
    res.json({ success: true, count: graphics.length, graphics });
  })
);

/** POST /submit — save request with email + chosen graphic */
apiRouter.post(
  "/submit",
  submitLimiter,
  rejectHoneypot,
  asyncHandler(async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { real_name, angel_name, email, graphic_code } = parsed.data;

    const validCode = await graphicCodeExists(graphic_code);
    if (!validCode) {
      res.status(400).json({
        success: false,
        error: "Unknown or inactive graphic code",
        details: { graphic_code: ["Select a valid graphic from the list"] },
      });
      return;
    }

    const cooldownHours = Number(process.env.SUBMIT_COOLDOWN_HOURS) || 24;
    const recentSameClaim = await findRecentDuplicateClaim(
      email,
      angel_name,
      cooldownHours
    );
    if (recentSameClaim) {
      logger.info("Blocked rapid multi-submit", {
        email,
        angel_name,
        existing_id: recentSameClaim.id,
      });
      res.status(200).json({
        success: true,
        duplicate: true,
        message:
          "You’re already on the list for that angel name. Please check your email for an update soon.",
        entry: recentSameClaim,
      });
      return;
    }

    const existing = await getEntryByAngelName(angel_name);

    const entry = await createEntry({
      real_name,
      angel_name,
      email,
      graphic_code,
    });

    logger.info("Entry created", {
      id: entry.id,
      angel_name: entry.angel_name,
      graphic_code: entry.graphic_code,
      status: entry.status,
      name_already_claimed: Boolean(existing),
    });

    if (existing) {
      res.status(201).json({
        success: true,
        duplicate: true,
        message:
          "Submitted! That angel name is already in our database. We’ll send you an update soon — please check your email.",
        entry,
      });
      return;
    }

    res.status(201).json({
      success: true,
      duplicate: false,
      message:
        "Submitted! You’re on the list — keep an eye on your email for an update.",
      entry,
    });
  })
);

/** GET /entries — list recent entries (automation / debug; protect with API key) */
apiRouter.get(
  "/entries",
  readLimiter,
  requireAutomationKeyIfConfigured,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const entries = await listEntries(limit, offset);
    res.json({ success: true, count: entries.length, entries });
  })
);

/**
 * GET /pending — automation poll endpoint
 * Returns unprocessed entries oldest-first so photo generation can drain the queue.
 */
apiRouter.get(
  "/pending",
  readLimiter,
  requireAutomationKeyIfConfigured,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const entries = await listPending(limit);
    res.json({ success: true, count: entries.length, entries });
  })
);

/** GET /entry/:id — fetch by UUID */
apiRouter.get(
  "/entry/:id",
  readLimiter,
  requireAutomationKeyIfConfigured,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid entry ID" });
      return;
    }

    const entry = await getEntryById(idCheck.data);
    if (!entry) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }

    res.json({ success: true, entry });
  })
);

/**
 * GET /lookup — query by angel_name or real_name
 */
apiRouter.get(
  "/lookup",
  readLimiter,
  requireAutomationKeyIfConfigured,
  asyncHandler(async (req, res) => {
    const parsed = lookupQuerySchema.safeParse({
      angel_name:
        typeof req.query.angel_name === "string"
          ? req.query.angel_name
          : undefined,
      real_name:
        typeof req.query.real_name === "string" ? req.query.real_name : undefined,
    });

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Provide angel_name or real_name query parameter",
      });
      return;
    }

    const angelName = parsed.data.angel_name?.trim() || "";
    const realName = parsed.data.real_name?.trim() || "";

    const entry = angelName
      ? await getEntryByAngelName(angelName)
      : await getEntryByRealName(realName!);

    if (!entry) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }

    res.json({ success: true, entry });
  })
);

/**
 * PATCH /entry/:id/status — mark processed / failed (for automation scripts)
 */
apiRouter.patch(
  "/entry/:id/status",
  readLimiter,
  requireAutomationKeyIfConfigured,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid entry ID" });
      return;
    }

    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const entry = await updateEntryStatus(
      idCheck.data,
      parsed.data.status,
      parsed.data.metadata
    );

    if (!entry) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }

    logger.info("Entry status updated", {
      id: entry.id,
      status: entry.status,
    });

    res.json({ success: true, entry });
  })
);

/** GET /health — liveness for Railway */
apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** GET /newsletter/count — current public newsletter signup total */
apiRouter.get(
  "/newsletter/count",
  readLimiter,
  asyncHandler(async (_req, res) => {
    const count = await getNewsletterCount();
    res.json({ success: true, count });
  })
);

/**
 * POST /newsletter/visit — bump counter by 3–4 when someone joins the site.
 * Limited to once per IP per hour; clients should also gate with sessionStorage.
 */
apiRouter.post(
  "/newsletter/visit",
  newsletterVisitLimiter,
  asyncHandler(async (_req, res) => {
    const { value, added } = await bumpNewsletterCount();
    res.json({ success: true, count: value, added });
  })
);

/** POST /newsletter/subscribe — real mailing-list opt-in from the popup. */
apiRouter.post(
  "/newsletter/subscribe",
  newsletterSubscribeLimiter,
  rejectHoneypot,
  asyncHandler(async (req, res) => {
    const parsed = newsletterSubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Enter a valid email",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { created, count } = await subscribeNewsletter(parsed.data.email);
    logger.info("Newsletter opt-in", { created });

    res.status(created ? 201 : 200).json({
      success: true,
      already_subscribed: !created,
      count,
      message: created
        ? "You’re in! Welcome to the list — good things are coming your way."
        : "You’re already on the list — we’ve got you covered.",
    });
  })
);

/** POST /contact — message from the contact page. */
apiRouter.post(
  "/contact",
  contactLimiter,
  rejectHoneypot,
  asyncHandler(async (req, res) => {
    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const saved = await createContactMessage(parsed.data);

    // Forward to the studio ProtonMail inbox. The message is already stored,
    // so an SMTP hiccup never loses it.
    const emailed = await sendContactEmail(parsed.data);
    logger.info("Contact message received", { id: saved.id, emailed });

    res.status(201).json({
      success: true,
      message:
        "Message sent! Thanks for reaching out — we’ll get back to you soon.",
    });
  })
);

/* ═══════════ Shop — the $5 AAG Archive Graphic ═══════════ */

/** GET /shop/config — publishable key + price for the checkout page. */
apiRouter.get(
  "/shop/config",
  readLimiter,
  asyncHandler(async (_req, res) => {
    if (!stripeConfigured()) {
      res.json({ success: true, enabled: false });
      return;
    }
    res.json({
      success: true,
      enabled: true,
      publishable_key: stripePublishableKey(),
      price_cents: shopPriceCents(),
      currency: SHOP_CURRENCY,
      product_name: SHOP_PRODUCT_NAME,
    });
  })
);

/** GET /shop/graphics — the archive dropdown (every option ever offered). */
apiRouter.get(
  "/shop/graphics",
  readLimiter,
  asyncHandler(async (_req, res) => {
    const graphics = await listArchiveGraphics();
    res.json({ success: true, count: graphics.length, graphics });
  })
);

/**
 * POST /shop/checkout — start a purchase.
 * Validates the order, creates a Stripe PaymentIntent for the fixed price
 * (amount is always set server-side), and records a pending purchase.
 */
apiRouter.post(
  "/shop/checkout",
  checkoutLimiter,
  rejectHoneypot,
  asyncHandler(async (req, res) => {
    if (!stripeConfigured()) {
      res.status(503).json({
        success: false,
        error: "The shop isn’t available right now. Please try again later.",
      });
      return;
    }

    const parsed = shopCheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const graphic = await getArchiveGraphicByCode(parsed.data.graphic_code);
    if (!graphic) {
      res.status(400).json({
        success: false,
        error: "Please pick a graphic from the list.",
        details: { graphic_code: ["Unknown archive graphic"] },
      });
      return;
    }

    const amount = shopPriceCents();
    const intent = await getStripe().paymentIntents.create({
      amount,
      currency: SHOP_CURRENCY,
      automatic_payment_methods: { enabled: true },
      receipt_email: parsed.data.email,
      description: `${SHOP_PRODUCT_NAME} — ${graphic.label} for “${parsed.data.angel_name}”`,
      metadata: {
        product: SHOP_PRODUCT_NAME,
        graphic_code: graphic.code,
        graphic_label: graphic.label,
        angel_name: parsed.data.angel_name,
        real_name: parsed.data.real_name,
      },
    });

    const purchase = await createPurchase({
      angel_name: parsed.data.angel_name,
      real_name: parsed.data.real_name,
      email: parsed.data.email,
      graphic_code: graphic.code,
      note: null,
      amount_cents: amount,
      currency: SHOP_CURRENCY,
      stripe_payment_intent_id: intent.id,
    });

    logger.info("Shop checkout started", {
      purchase_id: purchase.id,
      graphic_code: graphic.code,
    });

    res.status(201).json({
      success: true,
      client_secret: intent.client_secret,
      purchase_id: purchase.id,
      amount_cents: amount,
      currency: SHOP_CURRENCY,
    });
  })
);

/**
 * POST /shop/confirm — after the browser finishes payment, verify the result
 * directly with Stripe (never trusting the client) and update the purchase.
 */
apiRouter.post(
  "/shop/confirm",
  checkoutLimiter,
  asyncHandler(async (req, res) => {
    if (!stripeConfigured()) {
      res.status(503).json({ success: false, error: "Shop unavailable" });
      return;
    }

    const parsed = shopConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid payment id" });
      return;
    }

    const purchase = await getPurchaseByIntent(parsed.data.payment_intent_id);
    if (!purchase) {
      res.status(404).json({ success: false, error: "Purchase not found" });
      return;
    }

    const intent = await getStripe().paymentIntents.retrieve(
      parsed.data.payment_intent_id
    );

    let status = purchase.status;
    if (intent.status === "succeeded") {
      status = "paid";
    } else if (intent.status === "canceled") {
      status = "failed";
    }

    if (status !== purchase.status) {
      await markPurchaseStatusByIntent(intent.id, status);
      logger.info("Purchase status updated", { purchase_id: purchase.id, status });
    }

    res.json({
      success: true,
      status,
      paid: status === "paid",
      message:
        status === "paid"
          ? "Payment received! Your archive graphic is officially in the queue."
          : "Payment not completed yet.",
    });
  })
);

/** GET /admin/purchases — order list for the admin portal.
 *  Query params: q (search), status (pending|paid|failed), archived (1/true).
 */
apiRouter.get(
  "/admin/purchases",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const search =
      typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const statusRaw =
      typeof req.query.status === "string" ? req.query.status.trim() : "";
    const status =
      statusRaw === "pending" || statusRaw === "paid" || statusRaw === "failed"
        ? statusRaw
        : null;
    const archived =
      req.query.archived === "1" || req.query.archived === "true";

    const purchases = await listPurchasesForAdmin(200, {
      search: search || undefined,
      status,
      archived,
    });
    res.json({ success: true, count: purchases.length, archived, purchases });
  })
);

/** PATCH /admin/purchases/:id/archive — archive or restore one order */
apiRouter.patch(
  "/admin/purchases/:id/archive",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid order ID" });
      return;
    }
    const parsed = z
      .object({ archived: z.boolean() })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "archived is required" });
      return;
    }

    const ok = await setPurchaseArchived(idCheck.data, parsed.data.archived);
    if (!ok) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }
    logger.info("Admin toggled order archive", {
      id: idCheck.data,
      archived: parsed.data.archived,
    });
    res.json({ success: true });
  })
);

/** POST /admin/purchases/archive-paid — bulk clean-up of paid orders */
apiRouter.post(
  "/admin/purchases/archive-paid",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const updated = await archivePaidPurchases();
    logger.info("Admin archived paid orders", { updated });
    res.json({ success: true, updated });
  })
);

/**
 * POST /track/pageview — privacy-friendly first-party analytics beacon.
 * Stores no IPs and no personal data: only a salted hash of a random
 * client-generated id, the path, referrer hostname, and device bucket.
 */
apiRouter.post(
  "/track/pageview",
  trackLimiter,
  asyncHandler(async (req, res) => {
    const parsed = pageViewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid beacon" });
      return;
    }

    // Keep only the referrer's hostname; drop self-referrals.
    let referrerHost: string | null = null;
    if (parsed.data.referrer) {
      try {
        const host = new URL(parsed.data.referrer).hostname.toLowerCase();
        const selfHost = String(req.headers.host || "")
          .split(":")[0]
          .toLowerCase();
        if (host && host !== selfHost) referrerHost = host.slice(0, 200);
      } catch {
        referrerHost = null;
      }
    }

    await recordPageView({
      visitor_id: parsed.data.visitor_id,
      path: parsed.data.path,
      referrer_host: referrerHost,
      device: parsed.data.device ?? null,
    });

    res.status(202).json({ success: true });
  })
);

/** GET /admin/analytics — dashboard metrics for the admin portal. */
apiRouter.get(
  "/admin/analytics",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days) || 30;
    const summary = await getAnalyticsSummary(days);
    res.json({ success: true, ...summary });
  })
);

/**
 * GET /auth/facebook/config — tells the client whether Facebook login is
 * enabled and which app id to initialize the SDK with.
 */
apiRouter.get(
  "/auth/facebook/config",
  readLimiter,
  asyncHandler(async (_req, res) => {
    if (!facebookConfigured()) {
      res.json({ success: true, enabled: false });
      return;
    }
    res.json({ success: true, enabled: true, app_id: facebookAppId() });
  })
);

/**
 * POST /auth/facebook — exchange a Facebook JS SDK access token.
 * The token is verified server-side with Facebook before anything is stored.
 * We keep the email securely in Postgres, strictly for business purposes.
 */
apiRouter.post(
  "/auth/facebook",
  facebookAuthLimiter,
  asyncHandler(async (req, res) => {
    if (!facebookConfigured()) {
      res.status(503).json({
        success: false,
        error: "Facebook login is not enabled on this server",
      });
      return;
    }

    const parsed = facebookAuthSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid token" });
      return;
    }

    const profile = await verifyFacebookToken(parsed.data.access_token);
    if (!profile) {
      res.status(401).json({
        success: false,
        error: "Could not verify your Facebook session. Please try again.",
      });
      return;
    }

    if (!profile.email) {
      // User connected but declined the email permission — ask again.
      res.status(200).json({
        success: true,
        needs_email: true,
        message:
          "Almost there — please share your email so we can keep you updated.",
      });
      return;
    }

    const saved = await upsertFacebookUser(profile);
    logger.info("Facebook visitor linked", { fb_user_id: saved.fb_user_id });

    res.status(201).json({
      success: true,
      needs_email: false,
      message:
        "Thanks! Your email is stored securely and used for business purposes only.",
    });
  })
);

/** GET /admin/contact-messages — inbox for the admin portal. */
apiRouter.get(
  "/admin/contact-messages",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const messages = await listContactMessages(200);
    res.json({ success: true, count: messages.length, messages });
  })
);
