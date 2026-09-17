import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import {
  loginAdmin,
  logoutAdmin,
  requireAdmin,
  setSessionCookie,
  type AdminRequest,
} from "./auth";
import {
  detectJpegOrPng,
  photoUpload,
  saveGraphicSample,
  deleteGraphicSample,
  saveCustomerPhoto,
  saveNewsletterPhoto,
  deleteNewsletterPhoto,
} from "./uploads";
import { getEntryPhoto, upsertEntryPhoto } from "./db/entryPhotos";
import {
  ackFailedPipelineAlerts,
  archiveCompletedEntries,
  createEntry,
  emailExistsInEntries,
  findOpenGraphicClaimForUser,
  getEntryById,
  getEntryByRealName,
  listAdminEntries,
  listEntries,
  listFailedPipelineAlerts,
  listPending,
  markEntryComplete,
  requeueEntry,
  setEntryArchived,
  updateEntryStatus,
} from "./db/entries";
import { createAdmin, getAdminByEmail } from "./db/admins";
import { z } from "zod";
import bcrypt from "bcryptjs";
import {
  acknowledgeVaultedGraphics,
  createGraphicOption,
  deleteGraphicOption,
  graphicCodeExists,
  graphicRequiresPhoto,
  listActiveGraphics,
  listAllGraphics,
  listUnacknowledgedVaulted,
  updateGraphicOptionExpires,
  updateGraphicRequiresPhoto,
  vaultExpiredGraphics,
  vaultGraphicOption,
} from "./db/graphics";
import {
  attachReactionsToPosts,
  createNewsletterPost,
  deleteNewsletterPost,
  getNewsletterPostById,
  listNewsletterPosts,
  toggleNewsletterReaction,
  updateNewsletterPost,
} from "./db/newsletter";
import { logger } from "./logger";
import {
  checkoutLimiter,
  contactLimiter,
  facebookAuthLimiter,
  loginLimiter,
  newsletterSubscribeLimiter,
  newsletterVisitLimiter,
  reactionLimiter,
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
import { getAnalyticsSummary, recordPageView } from "./db/analytics";
import {
  archiveGraphicOption,
  archivePaidPurchases,
  createPurchase,
  getArchiveGraphicByCode,
  getPurchaseById,
  getPurchaseByIntent,
  listArchiveGraphics,
  listPurchasesForAdmin,
  markPurchaseStatusByIntent,
  mergePurchaseMetadata,
  setArchiveGraphicRequiresPhoto,
  setPurchaseArchived,
  setPurchaseStatus,
} from "./db/shop";
import {
  getPurchasePhoto,
  upsertPurchasePhoto,
} from "./db/purchasePhotos";
import {
  createReview,
  deleteReview,
  listApprovedReviews,
  listReviewsForAdmin,
  setReviewStatus,
} from "./db/reviews";
import {
  addMessageToThread,
  createThreadWithMessage,
  getThreadById,
  listMessagesForThread,
  listThreadsForAdmin,
  markAllOpenThreadsRead,
  markThreadRead,
  setThreadStatus,
  threadCounts,
} from "./db/messages";
import {
  createBillingPortalSession,
  createMembershipCheckoutSession,
  getStripe,
  membershipPeriodEnd,
  membershipPriceCents,
  MEMBERSHIP_INTERVAL,
  MEMBERSHIP_PRODUCT_NAME,
  SHOP_CURRENCY,
  SHOP_PRODUCT_NAME,
  shopPriceCents,
  stripeConfigured,
  stripePublishableKey,
} from "./stripe";
import {
  attachUserIfPresent,
  requireUser,
  type UserRequest,
} from "./userAuth";
import { upsertFacebookUser } from "./db/facebook";
import {
  facebookAppId,
  facebookConfigured,
  verifyFacebookToken,
} from "./facebook";
import { sendContactEmail, sendGraphicDeliveryEmail, sendInboxReplyEmail, siteOriginFromRequest } from "./email";
import {
  canToggleAiWorker,
  isAiWorkerEnabled,
  setAiWorkerEnabled,
} from "./db/settings";
import {
  adminGraphicCreateSchema,
  adminGraphicRequiresPhotoSchema,
  adminGraphicTimerSchema,
  adminJoinCheckSchema,
  adminJoinSchema,
  adminLoginSchema,
  contactSchema,
  createReviewSchema,
  facebookAuthSchema,
  lookupQuerySchema,
  moderateReviewSchema,
  newsletterPostSchema,
  newsletterReactionSchema,
  newsletterSubscribeSchema,
  pageViewSchema,
  PASSWORD_RULES,
  reviewAngelNameRequestSchema,
  shopConfirmSchema,
  statusSchema,
  submitSchema,
  threadReplySchema,
  threadStatusSchema,
  uuidSchema,
} from "./validation";
import {
  listAngelNameRequestsForAdmin,
  listLiveAngelNames,
  pendingAngelNameRequestCount,
  reviewAngelNameRequest,
} from "./db/angelNames";
import {
  getSubscriptionForUser,
  listSubscriptionsForAdmin,
  userHasActiveSubscription,
} from "./db/subscriptions";
import { getUserById } from "./db/users";
import { buildAccountPayload } from "./account";
import { safeAngelFilename } from "./worker/placeholders";

function envTrim(name: string): string {
  return process.env[name]?.trim() || "";
}

function adminJoinEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    envTrim("ALLOW_ADMIN_JOIN").toLowerCase()
  );
}

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
 * POST /admin/join/check — disabled unless ALLOW_ADMIN_JOIN=true
 */
apiRouter.post(
  "/admin/join/check",
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (!adminJoinEnabled()) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }

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

/** POST /admin/join — create admin; gated by ALLOW_ADMIN_JOIN=true */
apiRouter.post(
  "/admin/join",
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (!adminJoinEnabled()) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }

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

/** GET /admin/entries — one row per request.
 *  Query: graphic_code, q, status (pending|processing|processed|failed|complete),
 *  archived, limit, offset.
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
      statusRaw === "pending" ||
      statusRaw === "processing" ||
      statusRaw === "processed" ||
      statusRaw === "failed" ||
      statusRaw === "complete"
        ? statusRaw
        : null;
    const archived =
      req.query.archived === "1" || req.query.archived === "true";
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { rows, total } = await listAdminEntries({
      graphicCode: graphicCode || null,
      search: search || undefined,
      status,
      archived,
      limit,
      offset,
    });
    res.json({
      success: true,
      count: rows.length,
      total,
      limit,
      offset,
      filter: graphicCode || null,
      archived,
      entries: rows,
    });
  })
);

/** PATCH /admin/entries/:id/archive — archive or restore one request */
apiRouter.patch(
  "/admin/entries/:id/archive",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid entry ID" });
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
    const ok = await setEntryArchived(idCheck.data, parsed.data.archived);
    if (!ok) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }
    logger.info("Admin toggled entry archive", {
      id: idCheck.data,
      archived: parsed.data.archived,
    });
    res.json({ success: true });
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

/** GET /admin/graphics — manage dropdown options (sweeps expired offers first) */
apiRouter.get(
  "/admin/graphics",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await vaultExpiredGraphics();
    const graphics = await listAllGraphics();
    res.json({
      success: true,
      count: graphics.length,
      now: new Date().toISOString(),
      graphics,
    });
  })
);

/** GET /admin/graphics/vault-alerts — offers auto-vaulted since last dismissal */
apiRouter.get(
  "/admin/graphics/vault-alerts",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await vaultExpiredGraphics();
    const graphics = await listUnacknowledgedVaulted();
    res.json({ success: true, count: graphics.length, graphics });
  })
);

/** POST /admin/graphics/vault-alerts/ack — dismiss all vault notifications */
apiRouter.post(
  "/admin/graphics/vault-alerts/ack",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const updated = await acknowledgeVaultedGraphics();
    res.json({ success: true, updated });
  })
);

/** GET /admin/ai-worker — whether the graphic AI worker is allowed to run */
apiRouter.get(
  "/admin/ai-worker",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const enabled = await isAiWorkerEnabled();
    res.json({
      success: true,
      enabled,
      can_toggle: canToggleAiWorker(req.admin?.email),
    });
  })
);

/** PATCH /admin/ai-worker — kill switch for AI graphic automation */
apiRouter.patch(
  "/admin/ai-worker",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    if (!canToggleAiWorker(req.admin?.email)) {
      res.status(403).json({
        success: false,
        error: "Only the owner account can turn AI on or off",
      });
      return;
    }
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({
        success: false,
        error: "Body must include enabled: true or false",
      });
      return;
    }
    await setAiWorkerEnabled(enabled);
    logger.info("Admin toggled AI worker", {
      enabled,
      email: req.admin?.email,
    });
    console.error(
      `[ai-worker] admin set enabled=${enabled}`
    );
    res.json({ success: true, enabled, can_toggle: true });
  })
);

/** GET /admin/pipeline-alerts — graphic worker failures not yet dismissed */
apiRouter.get(
  "/admin/pipeline-alerts",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const entries = await listFailedPipelineAlerts();
    res.json({
      success: true,
      count: entries.length,
      entries: entries.map((e) => {
        const graphicLabel =
          e.graphic_label ||
          (typeof e.metadata?.graphic_label === "string"
            ? e.metadata.graphic_label
            : null) ||
          e.graphic_code;
        return {
          id: e.id,
          angel_name: e.angel_name,
          email: e.email,
          graphic_code: e.graphic_code,
          graphic_label: graphicLabel,
          error: e.metadata?.error ?? null,
          updated_at: e.updated_at,
        };
      }),
    });
  })
);

/** POST /admin/pipeline-alerts/ack — dismiss pipeline failure banners */
apiRouter.post(
  "/admin/pipeline-alerts/ack",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const updated = await ackFailedPipelineAlerts();
    res.json({ success: true, updated });
  })
);

apiRouter.get(
  "/admin/members/name-requests",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const statusRaw =
      typeof req.query.status === "string" ? req.query.status.trim() : "pending";
    const status =
      statusRaw === "pending" ||
      statusRaw === "approved" ||
      statusRaw === "denied" ||
      statusRaw === "all"
        ? statusRaw
        : "pending";
    const requests = await listAngelNameRequestsForAdmin({ status });
    const pending = await pendingAngelNameRequestCount();
    res.json({ success: true, count: requests.length, pending, requests });
  })
);

apiRouter.patch(
  "/admin/members/name-requests/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid request id" });
      return;
    }
    const parsed = reviewAngelNameRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    try {
      const updated = await reviewAngelNameRequest({
        id: idCheck.data,
        adminId: req.admin!.id,
        status: parsed.data.status,
        adminNote: parsed.data.admin_note ?? null,
      });
      if (!updated) {
        res.status(404).json({ success: false, error: "Request not found" });
        return;
      }
      logger.info("Admin reviewed angel name request", {
        id: updated.id,
        status: updated.status,
      });
      res.json({ success: true, request: updated });
    } catch (err) {
      const code = (err as { code?: string }).code;
      res.status(code === "ALREADY_REVIEWED" ? 409 : 400).json({
        success: false,
        error: err instanceof Error ? err.message : "Could not review",
      });
    }
  })
);

apiRouter.get(
  "/admin/members/subscriptions",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const subscriptions = await listSubscriptionsForAdmin();
    res.json({ success: true, count: subscriptions.length, subscriptions });
  })
);

/** PATCH /admin/graphics/:id/vault — close an offer immediately */
apiRouter.patch(
  "/admin/graphics/:id/vault",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid graphic ID" });
      return;
    }

    const graphic = await vaultGraphicOption(idCheck.data);
    if (!graphic) {
      res.status(404).json({
        success: false,
        error: "Graphic not found or already vaulted",
      });
      return;
    }

    logger.info("Admin vaulted graphic option", {
      id: graphic.id,
      code: graphic.code,
    });
    res.json({ success: true, graphic });
  })
);

/** POST /admin/graphics — add a graphic option.
 *  Accepts JSON or multipart/form-data. Optional file field "sample"
 *  (jpeg/png/webp/gif, max 5 MB) becomes the form/shop preview image.
 */
apiRouter.post(
  "/admin/graphics",
  requireAdmin,
  (req: Request, res: Response, next: NextFunction) => {
    photoUpload.single("sample")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          success: false,
          error: "Sample photo is too large — 5 MB max.",
        });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
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

    const file = (req as Request & { file?: { buffer?: Buffer } }).file;
    let imageUrl: string | null = null;
    if (file?.buffer?.length) {
      imageUrl = await saveGraphicSample(file.buffer);
      if (!imageUrl) {
        res.status(400).json({
          success: false,
          error:
            "That file doesn’t look like an image. Use JPEG, PNG, WebP, or GIF.",
        });
        return;
      }
    }

    const { duration_hours, requires_photo, ...option } = parsed.data;
    const expiresAt = duration_hours
      ? new Date(Date.now() + duration_hours * 60 * 60 * 1000)
      : null;

    try {
      const graphic = await createGraphicOption({
        ...option,
        expires_at: expiresAt,
        requires_photo,
      });
      // Every option ever offered is tracked in the archive for the shop.
      await archiveGraphicOption({
        ...graphic,
        image_url: imageUrl,
      });
      logger.info("Admin created graphic option", {
        id: graphic.id,
        code: graphic.code,
        expires_at: graphic.expires_at,
        requires_photo: graphic.requires_photo,
        image_url: imageUrl,
      });
      res.status(201).json({
        success: true,
        graphic: { ...graphic, image_url: imageUrl },
      });
    } catch (err) {
      await deleteGraphicSample(imageUrl);
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

/** PATCH /admin/graphics/:id/requires-photo — toggle customer photo requirement */
apiRouter.patch(
  "/admin/graphics/:id/requires-photo",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid graphic ID" });
      return;
    }
    const parsed = adminGraphicRequiresPhotoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const graphic = await updateGraphicRequiresPhoto(
      idCheck.data,
      parsed.data.requires_photo
    );
    if (!graphic) {
      res.status(404).json({ success: false, error: "Graphic not found" });
      return;
    }
    // Keep the archive shop in sync so vaulted/past offers still require a photo.
    await setArchiveGraphicRequiresPhoto(
      graphic.code,
      graphic.requires_photo
    );
    logger.info("Admin set graphic requires_photo", {
      id: graphic.id,
      requires_photo: graphic.requires_photo,
    });
    res.json({ success: true, graphic });
  })
);

/** PATCH /admin/graphics/:id/timer — set or clear the vault countdown on an open offer.
 *  Days are counted from now; updating expires_at is what powers newsletter countdowns.
 */
apiRouter.patch(
  "/admin/graphics/:id/timer",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid graphic ID" });
      return;
    }

    const parsed = adminGraphicTimerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const expiresAt = parsed.data.clear_timer
      ? null
      : new Date(Date.now() + (parsed.data.duration_days as number) * 24 * 60 * 60 * 1000);

    const graphic = await updateGraphicOptionExpires(idCheck.data, expiresAt);
    if (!graphic) {
      res.status(404).json({
        success: false,
        error: "Graphic not found or already vaulted",
      });
      return;
    }

    logger.info("Admin updated graphic offer timer", {
      id: graphic.id,
      code: graphic.code,
      expires_at: graphic.expires_at,
      cleared: parsed.data.clear_timer,
    });
    res.json({ success: true, graphic });
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

/** PATCH /admin/entries/:id/complete — mark this request processed */
apiRouter.patch(
  "/admin/entries/:id/complete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid entry ID" });
      return;
    }
    const result = await markEntryComplete(idCheck.data);
    if (!result.updated) {
      if (result.reason === "processing") {
        res.status(409).json({
          success: false,
          error:
            "The worker is generating this graphic right now. Wait, or retry after it fails.",
        });
        return;
      }
      res.status(404).json({ success: false, error: "Entry not found or already complete" });
      return;
    }
    logger.info("Admin marked entry complete", { id: idCheck.data });
    res.json({ success: true });
  })
);

/** POST /admin/entries/:id/retry — requeue, or resend email if art already exists */
apiRouter.post(
  "/admin/entries/:id/retry",
  requireAdmin,
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
    if (entry.status === "processing") {
      res.status(409).json({
        success: false,
        error: "This request is already being generated.",
      });
      return;
    }

    const generated = await getEntryPhoto(entry.id, "generated");
    const email = entry.email?.trim();
    if (generated && email) {
      const filename =
        generated.original_filename || safeAngelFilename(entry.angel_name);
      const sent = await sendGraphicDeliveryEmail({
        to: email,
        angelName: entry.angel_name,
        filename,
        image: generated.bytes,
        contentType: generated.content_type,
      });
      if (!sent) {
        res.status(502).json({
          success: false,
          error: "Could not send the email. Check SMTP, then try again.",
        });
        return;
      }
      await updateEntryStatus(entry.id, "processed", {
        photo_sent: "true",
        resent_at: new Date().toISOString(),
        failure_acked: "true",
      });
      logger.info("Admin resent generated graphic", { id: entry.id });
      res.json({ success: true, resent: true });
      return;
    }

    const queued = await requeueEntry(entry.id);
    if (!queued.updated) {
      res.status(409).json({ success: false, error: "Could not requeue this request" });
      return;
    }
    logger.info("Admin requeued entry", { id: entry.id });
    res.json({ success: true, resent: false, requeued: true });
  })
);

/** GET /graphics — open offers (codes, labels, vault countdowns from DB).
 *  Expired offers are swept into the vault before listing, so a dead timer
 *  can never be requested. `now` lets clients sync their countdowns.
 */
apiRouter.get(
  "/graphics",
  readLimiter,
  asyncHandler(async (_req, res) => {
    await vaultExpiredGraphics();
    const graphics = await listActiveGraphics();
    res.json({
      success: true,
      count: graphics.length,
      now: new Date().toISOString(),
      graphics,
    });
  })
);

/** POST /submit — save request with email + chosen graphic.
 *  Accepts JSON or multipart/form-data. Field "customer_photo" (jpg/png)
 *  is required when the selected graphic has requires_photo enabled.
 */
apiRouter.post(
  "/submit",
  submitLimiter,
  (req: Request, res: Response, next: NextFunction) => {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("multipart/form-data")) {
      next();
      return;
    }
    photoUpload.single("customer_photo")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          success: false,
          error: "Photo is too large — 5 MB max. Use JPG or PNG.",
        });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  rejectHoneypot,
  requireUser,
  asyncHandler(async (req: UserRequest, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const user = req.user!;
    const { graphic_code } = parsed.data;

    const subscribed = await userHasActiveSubscription(user.id);
    if (!subscribed) {
      res.status(402).json({
        success: false,
        error: "A $10 membership is required to request graphics.",
        subscription_required: true,
      });
      return;
    }

    const names = await listLiveAngelNames(user.id);
    if (!names.length) {
      res.status(400).json({
        success: false,
        error:
          "Add at least one angel name on your profile before requesting a graphic.",
        angel_names_required: true,
      });
      return;
    }

    const validCode = await graphicCodeExists(graphic_code);
    if (!validCode) {
      res.status(400).json({
        success: false,
        error: "Unknown or inactive graphic code",
        details: { graphic_code: ["Select a valid graphic from the list"] },
      });
      return;
    }

    const needsPhoto = await graphicRequiresPhoto(graphic_code);
    const file = (
      req as Request & { file?: { buffer?: Buffer; originalname?: string } }
    ).file;
    if (needsPhoto && !file?.buffer?.length) {
      res.status(400).json({
        success: false,
        error: "This graphic requires a photo upload (JPG or PNG).",
        details: {
          customer_photo: [
            "Attach a JPG or PNG photo to complete this request",
          ],
        },
      });
      return;
    }

    if (file?.buffer?.length) {
      const kind = detectJpegOrPng(file.buffer);
      if (!kind) {
        res.status(400).json({
          success: false,
          error:
            "That file doesn’t look like a JPG or PNG. Please upload one of those.",
        });
        return;
      }
    }

    const created = [];
    const skipped = [];

    for (const angel of names) {
      const existing = await findOpenGraphicClaimForUser(
        user.id,
        angel.name,
        graphic_code
      );
      if (existing) {
        skipped.push({
          angel_name: angel.name,
          entry_id: existing.id,
          status: existing.status,
        });
        continue;
      }

      const entry = await createEntry({
        real_name: user.name,
        angel_name: angel.name,
        email: user.email,
        graphic_code,
        user_id: user.id,
        metadata: { fanout: true, angel_name_id: angel.id },
      });

      if (file?.buffer?.length) {
        const savedCustomer = await saveCustomerPhoto(entry.id, file.buffer);
        if (savedCustomer) {
          await upsertEntryPhoto({
            entryId: entry.id,
            kind: "customer",
            contentType: savedCustomer.contentType,
            originalFilename:
              file.originalname || `customer.${savedCustomer.ext}`,
            bytes: file.buffer,
          });
          await updateEntryStatus(entry.id, entry.status, {
            customer_photo_path: savedCustomer.path,
            customer_photo_uploaded_at: new Date().toISOString(),
          });
        }
      }

      created.push(entry);
    }

    if (!created.length) {
      res.status(200).json({
        success: true,
        duplicate: true,
        already_sent: true,
        created_count: 0,
        skipped_count: skipped.length,
        skipped,
        message:
          "This graphic is already on the way (or already sent) for every angel name on your profile.",
      });
      return;
    }

    logger.info("Membership request fan-out", {
      user_id: user.id,
      graphic_code,
      created: created.length,
      skipped: skipped.length,
    });

    const count = created.length;
    res.status(201).json({
      success: true,
      duplicate: false,
      already_sent: false,
      created_count: count,
      skipped_count: skipped.length,
      skipped,
      entries: created,
      message:
        count === 1
          ? `Submitted for ${created[0].angel_name}. Watch your email for that graphic.`
          : `Submitted ${count} separate requests — one email per angel name.`,
    });
  })
);

/**
 * GET /admin/entries/:id/photo/:kind — download generated or customer photo.
 * kind = generated | customer
 */
apiRouter.get(
  "/admin/entries/:id/photo/:kind",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid entry ID" });
      return;
    }
    const kindRaw = String(req.params.kind || "").trim();
    if (kindRaw !== "generated" && kindRaw !== "customer") {
      res.status(400).json({
        success: false,
        error: "kind must be generated or customer",
      });
      return;
    }

    const entry = await getEntryById(idCheck.data);
    if (!entry) {
      res.status(404).json({ success: false, error: "Entry not found" });
      return;
    }

    const photo = await getEntryPhoto(idCheck.data, kindRaw);
    if (!photo) {
      res.status(404).json({ success: false, error: "Photo not found" });
      return;
    }

    const ext = photo.content_type.includes("png")
      ? "png"
      : photo.content_type.includes("webp")
        ? "webp"
        : "jpg";
    const fallback =
      kindRaw === "generated"
        ? `${entry.angel_name || "angel"}-generated.${ext}`
        : `${entry.angel_name || "angel"}-customer.${ext}`;
    const filename = (photo.original_filename || fallback).replace(
      /[^\w.\- ()]+/g,
      "_"
    );

    res.setHeader("Content-Type", photo.content_type);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
    res.setHeader("Content-Length", String(photo.bytes.length));
    res.send(photo.bytes);
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

/** GET /newsletter/posts — public feed for the newsletter page.
 *  Includes reaction counts; when logged in, also each post's my_reactions.
 */
apiRouter.get(
  "/newsletter/posts",
  readLimiter,
  attachUserIfPresent,
  asyncHandler(async (req: UserRequest, res) => {
    const posts = await listNewsletterPosts(100);
    const withReactions = await attachReactionsToPosts(
      posts,
      req.user?.id ?? null
    );
    res.json({
      success: true,
      count: withReactions.length,
      posts: withReactions,
    });
  })
);

/** POST /newsletter/posts/:id/reactions — toggle an emoji (logged-in only). */
apiRouter.post(
  "/newsletter/posts/:id/reactions",
  requireUser,
  reactionLimiter,
  asyncHandler(async (req: UserRequest, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid post ID" });
      return;
    }

    const parsed = newsletterReactionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const post = await getNewsletterPostById(idCheck.data);
    if (!post) {
      res.status(404).json({ success: false, error: "Post not found" });
      return;
    }

    const result = await toggleNewsletterReaction(
      idCheck.data,
      req.user!.id,
      parsed.data.emoji
    );

    logger.info("User toggled newsletter reaction", {
      post_id: idCheck.data,
      user_id: req.user!.id,
      emoji: parsed.data.emoji,
      active: result.active,
    });

    res.json({
      success: true,
      active: result.active,
      reactions: result.reactions,
      my_reactions: result.my_reactions,
    });
  })
);

/**
 * POST /admin/newsletter/posts — publish a newsletter post.
 * Accepts JSON or multipart/form-data. Optional file field "photo"
 * (jpeg/png/webp/gif, max 5 MB) is shown on the public newsletter page.
 */
apiRouter.post(
  "/admin/newsletter/posts",
  requireAdmin,
  (req: Request, res: Response, next: NextFunction) => {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("multipart/form-data")) {
      next();
      return;
    }
    photoUpload.single("photo")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          success: false,
          error: "Photo is too large — 5 MB max.",
        });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const parsed = newsletterPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const file = (req as Request & { file?: { buffer?: Buffer } }).file;
    let imageUrl: string | null = null;
    if (file?.buffer?.length) {
      imageUrl = await saveNewsletterPhoto(file.buffer);
      if (!imageUrl) {
        res.status(400).json({
          success: false,
          error:
            "That file doesn’t look like an image. Use JPEG, PNG, WebP, or GIF.",
        });
        return;
      }
    }

    try {
      const post = await createNewsletterPost({
        ...parsed.data,
        image_url: imageUrl,
      });
      logger.info("Admin published newsletter post", {
        id: post.id,
        title: post.title,
        author_name: post.author_name,
        has_image: Boolean(imageUrl),
      });
      res.status(201).json({ success: true, post });
    } catch (err) {
      if (imageUrl) await deleteNewsletterPhoto(imageUrl);
      throw err;
    }
  })
);

/**
 * PATCH /admin/newsletter/posts/:id — edit a published post.
 * Same fields as create. Optional "photo" replaces the image.
 * Set remove_photo=true to clear the existing image without uploading a new one.
 */
apiRouter.patch(
  "/admin/newsletter/posts/:id",
  requireAdmin,
  (req: Request, res: Response, next: NextFunction) => {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("multipart/form-data")) {
      next();
      return;
    }
    photoUpload.single("photo")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          success: false,
          error: "Photo is too large — 5 MB max.",
        });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid post ID" });
      return;
    }

    const existing = await getNewsletterPostById(idCheck.data);
    if (!existing) {
      res.status(404).json({ success: false, error: "Post not found" });
      return;
    }

    const parsed = newsletterPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const file = (req as Request & { file?: { buffer?: Buffer } }).file;
    const removePhoto = ["1", "true", "yes", "on"].includes(
      String(req.body?.remove_photo || "")
        .trim()
        .toLowerCase()
    );

    let nextImageUrl = existing.image_url;
    let uploadedUrl: string | null = null;

    if (file?.buffer?.length) {
      uploadedUrl = await saveNewsletterPhoto(file.buffer);
      if (!uploadedUrl) {
        res.status(400).json({
          success: false,
          error:
            "That file doesn’t look like an image. Use JPEG, PNG, WebP, or GIF.",
        });
        return;
      }
      nextImageUrl = uploadedUrl;
    } else if (removePhoto) {
      nextImageUrl = null;
    }

    try {
      const post = await updateNewsletterPost(idCheck.data, {
        ...parsed.data,
        image_url: nextImageUrl,
      });
      if (!post) {
        if (uploadedUrl) await deleteNewsletterPhoto(uploadedUrl);
        res.status(404).json({ success: false, error: "Post not found" });
        return;
      }

      if (
        existing.image_url &&
        existing.image_url !== post.image_url
      ) {
        await deleteNewsletterPhoto(existing.image_url);
      }

      logger.info("Admin updated newsletter post", {
        id: post.id,
        title: post.title,
        has_image: Boolean(post.image_url),
      });
      res.json({ success: true, post });
    } catch (err) {
      if (uploadedUrl) await deleteNewsletterPhoto(uploadedUrl);
      throw err;
    }
  })
);

/** DELETE /admin/newsletter/posts/:id — take a post down. */
apiRouter.delete(
  "/admin/newsletter/posts/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid post ID" });
      return;
    }

    const existing = await getNewsletterPostById(idCheck.data);
    if (!existing) {
      res.status(404).json({ success: false, error: "Post not found" });
      return;
    }

    const removed = await deleteNewsletterPost(idCheck.data);
    if (!removed) {
      res.status(404).json({ success: false, error: "Post not found" });
      return;
    }

    await deleteNewsletterPhoto(existing.image_url);
    logger.info("Admin deleted newsletter post", { id: idCheck.data });
    res.json({ success: true });
  })
);

/** POST /contact — start a conversation (requires login). */
apiRouter.post(
  "/contact",
  contactLimiter,
  rejectHoneypot,
  attachUserIfPresent,
  asyncHandler(async (req: UserRequest, res) => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: "Please sign in or create an account to send a message.",
      });
      return;
    }

    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { thread } = await createThreadWithMessage({
      user_id: req.user.id,
      subject: "Contact message",
      body: parsed.data.message,
    });

    // Email ping so ProtonMail still gets notified; inbox lives in Threads.
    const emailed = await sendContactEmail({
      name: parsed.data.name || req.user.name,
      email: parsed.data.email || req.user.email,
      message: parsed.data.message,
    });
    logger.info("Contact thread started", {
      thread_id: thread.id,
      user_id: req.user.id,
      emailed,
    });

    res.status(201).json({
      success: true,
      thread_id: thread.id,
      message:
        "Message sent! You’ll see our reply in your profile inbox.",
    });
  })
);

/* ═══════════ Reviews ═══════════ */

/** GET /api/reviews — approved reviews for the public page (no emails). */
apiRouter.get(
  "/api/reviews",
  readLimiter,
  asyncHandler(async (_req, res) => {
    const reviews = await listApprovedReviews(100);
    // Allowlist only — never leak account email / user_id / photos to the site.
    res.json({
      success: true,
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        body: r.body,
        display_name: r.display_name,
        created_at: r.created_at,
      })),
    });
  })
);

/** POST /api/reviews — submit a review (pending moderation). */
apiRouter.post(
  "/api/reviews",
  requireUser,
  contactLimiter,
  asyncHandler(async (req: UserRequest, res) => {
    const parsed = createReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const isAnonymous = parsed.data.is_anonymous === true;
    const displayName = isAnonymous
      ? "Anonymous"
      : parsed.data.display_name.trim() || req.user!.name;

    const review = await createReview({
      user_id: req.user!.id,
      rating: parsed.data.rating,
      body: parsed.data.body,
      display_name: displayName,
      is_anonymous: isAnonymous,
      source: parsed.data.source,
    });

    logger.info("Review submitted", {
      review_id: review.id,
      user_id: req.user!.id,
      rating: review.rating,
    });

    res.status(201).json({
      success: true,
      message: "Thanks — we’ll review it shortly before it goes live.",
      review: {
        id: review.id,
        status: review.status,
      },
    });
  })
);

/** GET /admin/reviews — moderation queue. */
apiRouter.get(
  "/admin/reviews",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const statusRaw = String(req.query.status || "").trim();
    const status =
      statusRaw === "pending" ||
      statusRaw === "approved" ||
      statusRaw === "rejected"
        ? statusRaw
        : undefined;
    const reviews = await listReviewsForAdmin({ status });
    res.json({ success: true, count: reviews.length, reviews });
  })
);

/** PATCH /admin/reviews/:id — set status (pending / approved / rejected). */
apiRouter.patch(
  "/admin/reviews/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid review id" });
      return;
    }
    const parsed = moderateReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const updated = await setReviewStatus({
      id: idCheck.data,
      status: parsed.data.status,
      admin_id: req.admin!.id,
    });
    if (!updated) {
      res.status(404).json({ success: false, error: "Review not found" });
      return;
    }

    logger.info("Review moderated", {
      review_id: updated.id,
      status: updated.status,
      admin_id: req.admin!.id,
    });
    res.json({ success: true, review: updated });
  })
);

/** DELETE /admin/reviews/:id — permanently remove a review. */
apiRouter.delete(
  "/admin/reviews/:id",
  requireAdmin,
  asyncHandler(async (req: AdminRequest, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid review id" });
      return;
    }
    const ok = await deleteReview(idCheck.data);
    if (!ok) {
      res.status(404).json({ success: false, error: "Review not found" });
      return;
    }
    logger.info("Review deleted", {
      review_id: idCheck.data,
      admin_id: req.admin!.id,
    });
    res.json({ success: true });
  })
);

/* ═══════════ Message threads (admin) ═══════════ */

/** GET /admin/threads — conversation list.
 *  Query: status=open|closed, unread=1, q=search
 */
apiRouter.get(
  "/admin/threads",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const statusRaw = String(req.query.status || "").trim();
    const status =
      statusRaw === "open" || statusRaw === "closed" ? statusRaw : undefined;
    const unreadOnly =
      req.query.unread === "1" || req.query.unread === "true";
    const search =
      typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";

    const [threads, totals] = await Promise.all([
      listThreadsForAdmin({
        status,
        unreadOnly,
        search: search || undefined,
      }),
      threadCounts(),
    ]);
    res.json({
      success: true,
      count: threads.length,
      totals,
      threads,
    });
  })
);

/** GET /admin/threads/counts — badge poll for the portal. */
apiRouter.get(
  "/admin/threads/counts",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const totals = await threadCounts();
    res.json({ success: true, totals });
  })
);

/** POST /admin/threads/read-all — mark open-inbox user messages read. */
apiRouter.post(
  "/admin/threads/read-all",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const updated = await markAllOpenThreadsRead();
    logger.info("Admin marked message inbox read", { updated });
    res.json({ success: true, updated });
  })
);

/** GET /admin/threads/:id — full thread + mark user messages read. */
apiRouter.get(
  "/admin/threads/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid thread id" });
      return;
    }
    const thread = await getThreadById(idCheck.data);
    if (!thread) {
      res.status(404).json({ success: false, error: "Thread not found" });
      return;
    }
    await markThreadRead({ thread_id: thread.id, sender: "user" });
    const messages = await listMessagesForThread(thread.id);
    res.json({ success: true, thread, messages });
  })
);

/** POST /admin/threads/:id/messages — admin reply. */
apiRouter.post(
  "/admin/threads/:id/messages",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid thread id" });
      return;
    }
    const parsed = threadReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const thread = await getThreadById(idCheck.data);
    if (!thread) {
      res.status(404).json({ success: false, error: "Thread not found" });
      return;
    }
    if (thread.status === "closed") {
      res.status(400).json({
        success: false,
        error: "This conversation is closed.",
      });
      return;
    }

    const message = await addMessageToThread({
      thread_id: thread.id,
      sender: "admin",
      body: parsed.data.body,
    });
    if (!message) {
      res.status(400).json({ success: false, error: "Could not send reply" });
      return;
    }

    const inboxUrl = `${siteOriginFromRequest(req)}/profile#inbox`;
    if (thread.user_email) {
      await sendInboxReplyEmail({
        to: thread.user_email,
        name: thread.user_name || "there",
        inboxUrl,
        preview: parsed.data.body,
      });
    }

    logger.info("Admin replied to thread", {
      thread_id: thread.id,
      message_id: message.id,
    });
    res.status(201).json({ success: true, message });
  })
);

/** PATCH /admin/threads/:id — open/close. */
apiRouter.patch(
  "/admin/threads/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid thread id" });
      return;
    }
    const parsed = threadStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const updated = await setThreadStatus({
      id: idCheck.data,
      status: parsed.data.status,
    });
    if (!updated) {
      res.status(404).json({ success: false, error: "Thread not found" });
      return;
    }
    res.json({ success: true, thread: updated });
  })
);

/* ═══════════ Membership + archive catalog ═══════════ */

/** GET /shop/config — archive is free for members; Stripe is for $10 membership. */
apiRouter.get(
  "/shop/config",
  readLimiter,
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      enabled: true,
      priced: false,
      membership_price_cents: membershipPriceCents(),
      currency: SHOP_CURRENCY,
      product_name: MEMBERSHIP_PRODUCT_NAME,
      stripe_enabled: stripeConfigured(),
      publishable_key: stripeConfigured() ? stripePublishableKey() : "",
    });
  })
);

apiRouter.get(
  "/subscription/config",
  attachUserIfPresent,
  asyncHandler(async (req: UserRequest, res) => {
    const account = req.user ? await buildAccountPayload(req.user) : null;
    res.json({
      success: true,
      enabled: true,
      checkout_enabled: stripeConfigured(),
      checkout_hint: stripeConfigured()
        ? null
        : "Membership checkout isn’t available yet — Stripe keys aren’t set.",
      currency: SHOP_CURRENCY,
      price_cents: membershipPriceCents(),
      interval: MEMBERSHIP_INTERVAL,
      product_name: MEMBERSHIP_PRODUCT_NAME,
      subscription: account?.subscription ?? null,
      plans: [
        {
          id: "monthly",
          name: "AAG Membership",
          description:
            "Ten dollars a month. Every graphic AAG has ever made, requested from your account.",
          price_cents: membershipPriceCents(),
          currency: SHOP_CURRENCY,
          interval: MEMBERSHIP_INTERVAL,
          featured: true,
          features: [
            "Every graphic AAG has ever made, included",
            "Request from your account — no typing names on the form",
            "Each angel name on your profile gets its own graphic and its own email",
            "Up to 5 angel names (ask us if you need more)",
            "Cancel anytime",
          ],
        },
      ],
    });
  })
);

apiRouter.post(
  "/subscription/checkout",
  checkoutLimiter,
  requireUser,
  asyncHandler(async (req: UserRequest, res) => {
    if (!stripeConfigured()) {
      res.status(503).json({
        success: false,
        error: "Membership checkout isn’t available right now.",
      });
      return;
    }

    const user = req.user!;
    if (await userHasActiveSubscription(user.id)) {
      res.json({
        success: true,
        already_member: true,
        url: "/profile",
      });
      return;
    }

    const origin = siteOriginFromRequest(req);
    const existing = await getSubscriptionForUser(user.id);
    const session = await createMembershipCheckoutSession({
      userId: user.id,
      email: user.email,
      customerId: user.stripe_customer_id || existing?.stripe_customer_id,
      successUrl: `${origin}/profile?membership=success`,
      cancelUrl: `${origin}/subscription?canceled=1`,
    });

    res.json({ success: true, url: session.url });
  })
);

apiRouter.post(
  "/subscription/portal",
  checkoutLimiter,
  requireUser,
  asyncHandler(async (req: UserRequest, res) => {
    if (!stripeConfigured()) {
      res.status(503).json({ success: false, error: "Billing portal unavailable" });
      return;
    }
    const sub = await getSubscriptionForUser(req.user!.id);
    const customerId =
      req.user!.stripe_customer_id || sub?.stripe_customer_id;
    if (!customerId) {
      res.status(400).json({
        success: false,
        error: "No billing account yet. Subscribe first.",
      });
      return;
    }
    const origin = siteOriginFromRequest(req);
    const portal = await createBillingPortalSession({
      customerId,
      returnUrl: `${origin}/profile`,
    });
    res.json({ success: true, url: portal.url });
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
 * Accepts JSON or multipart/form-data. Field "customer_photo" (jpg/png)
 * is required when the selected archive graphic has requires_photo enabled.
 */
apiRouter.post(
  "/shop/checkout",
  checkoutLimiter,
  (req: Request, res: Response, next: NextFunction) => {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("multipart/form-data")) {
      next();
      return;
    }
    photoUpload.single("customer_photo")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          success: false,
          error: "Photo is too large — 5 MB max. Use JPG or PNG.",
        });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  rejectHoneypot,
  attachUserIfPresent,
  asyncHandler(async (req: UserRequest, res) => {
    res.status(410).json({
      success: false,
      error:
        "Per-graphic purchases are retired. A $10 membership includes every graphic. Request from your account.",
      membership_required: true,
    });
    return;

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

    const file = (
      req as Request & { file?: { buffer?: Buffer; originalname?: string } }
    ).file;
    if (graphic.requires_photo && !file?.buffer?.length) {
      res.status(400).json({
        success: false,
        error: "This graphic requires a photo upload (JPG or PNG).",
        details: {
          customer_photo: [
            "Attach a JPG or PNG photo to complete this order",
          ],
        },
      });
      return;
    }

    // Validate image bytes before creating a Stripe intent / purchase row.
    let photoKind: ReturnType<typeof detectJpegOrPng> = null;
    if (file?.buffer?.length) {
      photoKind = detectJpegOrPng(file.buffer);
      if (!photoKind) {
        res.status(400).json({
          success: false,
          error:
            "That file doesn’t look like a JPG or PNG. Please upload one of those.",
        });
        return;
      }
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
        requires_photo: graphic.requires_photo ? "true" : "false",
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
      user_id: req.user?.id ?? null,
    });

    let hasCustomerPhoto = false;
    if (file?.buffer?.length && photoKind) {
      const savedCustomer = await saveCustomerPhoto(purchase.id, file.buffer);
      if (savedCustomer) {
        await upsertPurchasePhoto({
          purchaseId: purchase.id,
          contentType: savedCustomer.contentType,
          originalFilename:
            file.originalname || `customer.${savedCustomer.ext}`,
          bytes: file.buffer,
        });
        await mergePurchaseMetadata(purchase.id, {
          customer_photo_path: savedCustomer.path,
          customer_photo_uploaded_at: new Date().toISOString(),
        });
        hasCustomerPhoto = true;
      }
    }

    logger.info("Shop checkout started", {
      purchase_id: purchase.id,
      graphic_code: graphic.code,
      has_customer_photo: hasCustomerPhoto,
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
    res.status(410).json({
      success: false,
      error:
        "Per-graphic purchases are retired. A $10 membership includes every graphic.",
    });
    return;

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
      // Keep delivered if an admin already marked it; otherwise mark paid.
      status = purchase.status === "delivered" ? "delivered" : "paid";
    } else if (intent.status === "canceled" && purchase.status !== "delivered") {
      status = "failed";
    }

    if (status !== purchase.status) {
      await markPurchaseStatusByIntent(intent.id, status);
      logger.info("Purchase status updated", { purchase_id: purchase.id, status });
    }

    res.json({
      success: true,
      status,
      paid: status === "paid" || status === "delivered",
      message:
        status === "paid" || status === "delivered"
          ? "Payment received! Your archive graphic is officially in the queue."
          : "Payment not completed yet.",
    });
  })
);

/** GET /admin/purchases — order list for the admin portal.
 *  Query params: q (search), status (pending|paid|failed|delivered), archived (1/true).
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
      statusRaw === "pending" ||
      statusRaw === "paid" ||
      statusRaw === "failed" ||
      statusRaw === "delivered"
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

/** PATCH /admin/purchases/:id/status — mark paid ↔ delivered */
apiRouter.patch(
  "/admin/purchases/:id/status",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid order ID" });
      return;
    }
    const parsed = z
      .object({
        status: z.enum(["paid", "delivered"]),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "status must be paid or delivered",
      });
      return;
    }

    const purchase = await setPurchaseStatus(idCheck.data, parsed.data.status);
    if (!purchase) {
      res.status(404).json({
        success: false,
        error: "Order not found or not eligible for that status",
      });
      return;
    }
    logger.info("Admin updated order status", {
      id: purchase.id,
      status: purchase.status,
    });
    res.json({ success: true, purchase });
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

/** GET /admin/purchases/:id/photo — download the customer photo for an order. */
apiRouter.get(
  "/admin/purchases/:id/photo",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid order ID" });
      return;
    }

    const purchase = await getPurchaseById(idCheck.data);
    if (!purchase) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    const photo = await getPurchasePhoto(idCheck.data);
    if (!photo) {
      res.status(404).json({ success: false, error: "Photo not found" });
      return;
    }

    const ext = photo.content_type.includes("png") ? "png" : "jpg";
    const fallback = `${purchase.angel_name || "angel"}-customer.${ext}`;
    const filename = (photo.original_filename || fallback).replace(
      /[^\w.\- ()]+/g,
      "_"
    );

    res.setHeader("Content-Type", photo.content_type);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.send(photo.bytes);
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

