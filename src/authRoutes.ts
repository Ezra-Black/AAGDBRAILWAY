import crypto from "crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  createUser,
  deleteAllSessionsForUser,
  getUserActivity,
  getUserByEmail,
  toPublicUser,
  updateUserPasswordHash,
  updateUserProfile,
} from "./db/users";
import {
  addAngelName,
  createAngelNameRequest,
  listLiveAngelNames,
} from "./db/angelNames";
import { buildAccountPayload } from "./account";
import {
  addMessageToThread,
  getThreadById,
  listMessagesForThread,
  listThreadsForUser,
  markThreadRead,
} from "./db/messages";
import { mailerConfigured, sendPasswordResetEmail, siteOriginFromRequest } from "./email";
import { logger } from "./logger";
import {
  passwordResetLimiter,
  profileLimiter,
  rejectHoneypot,
  userAuthLimiter,
} from "./security";
import { deleteProfilePhoto, photoUpload, saveProfilePhoto } from "./uploads";
import {
  authenticateUser,
  hashPassword,
  issueSession,
  logoutUser,
  requireUser,
  verifyPassword,
  type UserRequest,
} from "./userAuth";
import {
  PASSWORD_RULES,
  addAngelNameSchema,
  angelNameRequestSchema,
  threadReplySchema,
  userChangePasswordSchema,
  userForgotPasswordSchema,
  userLoginSchema,
  userProfileUpdateSchema,
  userRegisterSchema,
  userResetPasswordSchema,
  uuidSchema,
} from "./validation";

/**
 * Site-user (customer) authentication + profile API, mounted at /api/auth.
 *
 * Session-based auth via httpOnly Secure cookie (see src/userAuth.ts).
 * Every mutating endpoint is rate-limited and zod-validated; error messages
 * never reveal whether an email is registered.
 */
export const authRouter = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Public site origin for links in emails (reset password, etc.). */
function publicBaseUrl(req: Request): string {
  return siteOriginFromRequest(req);
}

/** POST /api/auth/register — create an account and log straight in. */
authRouter.post(
  "/register",
  userAuthLimiter,
  rejectHoneypot,
  asyncHandler(async (req, res) => {
    const parsed = userRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
        password_rules: PASSWORD_RULES,
      });
      return;
    }

    const { email, password, name, angel_name } = parsed.data;

    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({
        success: false,
        error: "An account with that email already exists. Please log in.",
      });
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser({
      email,
      password_hash: passwordHash,
      name,
      angel_name: angel_name ?? null,
    });

    if (angel_name) {
      try {
        await addAngelName({ userId: user.id, name: angel_name });
      } catch (err) {
        logger.warn("Could not add signup angel name", {
          user_id: user.id,
          error: String(err),
        });
      }
    }

    await issueSession(res, user.id);
    logger.info("User registered", { user_id: user.id });

    res.status(201).json({
      success: true,
      message: "Welcome! Your account is ready.",
      ...(await buildAccountPayload(user)),
    });
  })
);

/** POST /api/auth/login */
authRouter.post(
  "/login",
  userAuthLimiter,
  asyncHandler(async (req, res) => {
    const parsed = userLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const user = await authenticateUser(parsed.data.email, parsed.data.password);
    if (!user) {
      res
        .status(401)
        .json({ success: false, error: "Invalid email or password" });
      return;
    }

    await issueSession(res, user.id);
    logger.info("User logged in", { user_id: user.id });
    res.json({ success: true, ...(await buildAccountPayload(user)) });
  })
);

/** POST /api/auth/logout — destroys the DB session and clears the cookie. */
authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    await logoutUser(req, res);
    res.json({ success: true });
  })
);

/** GET /api/auth/me — current session (protected). */
authRouter.get(
  "/me",
  requireUser,
  asyncHandler(async (req: UserRequest, res) => {
    res.json({ success: true, ...(await buildAccountPayload(req.user!)) });
  })
);

/** PUT /api/auth/profile — update email / display name / angel's name. */
authRouter.put(
  "/profile",
  requireUser,
  profileLimiter,
  asyncHandler(async (req: UserRequest, res) => {
    const parsed = userProfileUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const user = req.user!;
    const patch = parsed.data;

    if (
      patch.email !== undefined &&
      patch.email.toLowerCase() !== user.email.toLowerCase()
    ) {
      const taken = await getUserByEmail(patch.email);
      if (taken) {
        res.status(409).json({
          success: false,
          error: "That email is already in use by another account.",
        });
        return;
      }
    }

    const updated = await updateUserProfile(user.id, {
      email: patch.email,
      name: patch.name,
    });

    logger.info("User profile updated", { user_id: user.id });
    res.json({
      success: true,
      message: "Profile saved.",
      ...(await buildAccountPayload(updated!)),
    });
  })
);

/**
 * POST /api/auth/profile/photo — upload a new profile photo.
 * multipart/form-data with field "photo" (jpeg/png/webp/gif, max 5 MB).
 */
authRouter.post(
  "/profile/photo",
  requireUser,
  profileLimiter,
  (req: Request, res: Response, next: NextFunction) => {
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
  asyncHandler(async (req: UserRequest, res) => {
    const file = req.file;
    if (!file || !file.buffer?.length) {
      res
        .status(400)
        .json({ success: false, error: "Attach an image as the “photo” field." });
      return;
    }

    const url = await saveProfilePhoto(req.user!.id, file.buffer);
    if (!url) {
      res.status(400).json({
        success: false,
        error: "That file doesn’t look like an image. Use JPEG, PNG, WebP, or GIF.",
      });
      return;
    }

    const previous = req.user!.profile_photo_url;
    const updated = await updateUserProfile(req.user!.id, {
      profile_photo_url: url,
    });
    await deleteProfilePhoto(previous);

    logger.info("User profile photo updated", { user_id: req.user!.id });
    res.json({
      success: true,
      message: "Photo updated.",
      user: toPublicUser(updated!),
    });
  })
);

/** DELETE /api/auth/profile/photo — remove the current photo. */
authRouter.delete(
  "/profile/photo",
  requireUser,
  profileLimiter,
  asyncHandler(async (req: UserRequest, res) => {
    const previous = req.user!.profile_photo_url;
    const updated = await updateUserProfile(req.user!.id, {
      profile_photo_url: null,
    });
    await deleteProfilePhoto(previous);
    res.json({ success: true, user: toPublicUser(updated!) });
  })
);

/** GET /api/auth/angel-names — live names on the profile. */
authRouter.get(
  "/angel-names",
  requireUser,
  asyncHandler(async (req: UserRequest, res) => {
    const names = await listLiveAngelNames(req.user!.id);
    res.json({ success: true, names });
  })
);

/** POST /api/auth/angel-names — add a name (up to 5, plus granted extras). */
authRouter.post(
  "/angel-names",
  requireUser,
  profileLimiter,
  asyncHandler(async (req: UserRequest, res) => {
    const parsed = addAngelNameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    try {
      await addAngelName({ userId: req.user!.id, name: parsed.data.name });
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message =
        err instanceof Error ? err.message : "Could not add that name.";
      const status =
        code === "CAP_REACHED" || code === "DUPLICATE_NAME" ? 409 : 400;
      res.status(status).json({ success: false, error: message, code });
      return;
    }
    logger.info("User added angel name", { user_id: req.user!.id });
    res.status(201).json({
      success: true,
      message: "Angel name added to your profile.",
      ...(await buildAccountPayload(req.user!)),
    });
  })
);

/** POST /api/auth/angel-names/extra-request — ask for more than 5 names.
 *  Registered before :id so “extra-request” is never parsed as a name id.
 */
authRouter.post(
  "/angel-names/extra-request",
  requireUser,
  profileLimiter,
  asyncHandler(async (req: UserRequest, res) => {
    const parsed = angelNameRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    try {
      await createAngelNameRequest({
        userId: req.user!.id,
        type: "extra_slot",
        userNote: parsed.data.user_note ?? null,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message =
        err instanceof Error ? err.message : "Could not send that request.";
      res
        .status(code === "ALREADY_PENDING" ? 409 : 400)
        .json({ success: false, error: message, code });
      return;
    }
    logger.info("User requested extra angel name slot", {
      user_id: req.user!.id,
    });
    res.status(201).json({
      success: true,
      message:
        "Request sent. The AAG team will review a special accommodation for extra names.",
      ...(await buildAccountPayload(req.user!)),
    });
  })
);

/** POST /api/auth/angel-names/:id/remove-request */
authRouter.post(
  "/angel-names/:id/remove-request",
  requireUser,
  profileLimiter,
  asyncHandler(async (req: UserRequest, res) => {
    const idCheck = uuidSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid name id" });
      return;
    }
    const parsed = angelNameRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    try {
      await createAngelNameRequest({
        userId: req.user!.id,
        type: "remove",
        angelNameId: idCheck.data,
        userNote: parsed.data.user_note ?? null,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message =
        err instanceof Error ? err.message : "Could not send that request.";
      const status =
        code === "NOT_FOUND" ? 404 : code === "ALREADY_PENDING" ? 409 : 400;
      res.status(status).json({ success: false, error: message, code });
      return;
    }
    logger.info("User requested angel name removal", {
      user_id: req.user!.id,
      angel_name_id: idCheck.data,
    });
    res.status(201).json({
      success: true,
      message:
        "Request sent. That name stays on your profile until the AAG team approves the removal.",
      ...(await buildAccountPayload(req.user!)),
    });
  })
);

/** POST /api/auth/password — change password while logged in. */
authRouter.post(
  "/password",
  requireUser,
  userAuthLimiter,
  asyncHandler(async (req: UserRequest, res) => {
    const parsed = userChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
        password_rules: PASSWORD_RULES,
      });
      return;
    }

    const user = req.user!;
    const ok = await verifyPassword(
      parsed.data.current_password,
      user.password_hash
    );
    if (!ok) {
      res
        .status(401)
        .json({ success: false, error: "Current password is incorrect." });
      return;
    }

    await updateUserPasswordHash(user.id, await hashPassword(parsed.data.new_password));
    // Kill every session (including this one) so a stolen cookie dies too,
    // then immediately re-issue one for this browser.
    await deleteAllSessionsForUser(user.id);
    await issueSession(res, user.id);

    logger.info("User changed password", { user_id: user.id });
    res.json({
      success: true,
      message: "Password updated. Other devices have been signed out.",
    });
  })
);

/**
 * POST /api/auth/forgot-password — email a single-use reset link.
 * Always responds with the same message so emails can't be enumerated,
 * except when SMTP is down — then 503 for everyone (no account leak).
 */
authRouter.post(
  "/forgot-password",
  passwordResetLimiter,
  rejectHoneypot,
  asyncHandler(async (req, res) => {
    const parsed = userForgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Enter a valid email",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    if (!mailerConfigured()) {
      logger.warn("Password reset skipped — SMTP is not configured");
      res.status(503).json({
        success: false,
        error:
          "Password reset email isn't available right now. Please try again later.",
      });
      return;
    }

    const genericResponse = {
      success: true,
      message:
        "If an account exists for that email, a reset link is on its way. Check your inbox (and spam folder).",
    };

    const user = await getUserByEmail(parsed.data.email);
    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      await createPasswordResetToken(
        user.id,
        hashToken(token),
        new Date(Date.now() + RESET_TOKEN_TTL_MS)
      );
      const resetUrl = `${publicBaseUrl(req)}/reset-password?token=${token}`;
      const emailed = await sendPasswordResetEmail(user.email, resetUrl);
      logger.info("Password reset requested", { user_id: user.id, emailed });
    }

    res.json(genericResponse);
  })
);

/** POST /api/auth/reset-password — finish the reset with the emailed token. */
authRouter.post(
  "/reset-password",
  userAuthLimiter,
  asyncHandler(async (req, res) => {
    const parsed = userResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
        password_rules: PASSWORD_RULES,
      });
      return;
    }

    const userId = await consumePasswordResetToken(hashToken(parsed.data.token));
    if (!userId) {
      res.status(400).json({
        success: false,
        error: "That reset link is invalid or has expired. Request a new one.",
      });
      return;
    }

    await updateUserPasswordHash(userId, await hashPassword(parsed.data.new_password));
    await deleteAllSessionsForUser(userId);

    logger.info("User reset password", { user_id: userId });
    res.json({
      success: true,
      message: "Password reset. You can log in with your new password now.",
    });
  })
);

/** GET /api/auth/activity — the account's requests and orders (protected). */
authRouter.get(
  "/activity",
  requireUser,
  asyncHandler(async (req: UserRequest, res) => {
    const activity = await getUserActivity(req.user!.id, req.user!.email);
    res.json({ success: true, ...activity });
  })
);

/* ═══════════ Inbox ═══════════ */

/** GET /api/auth/inbox — conversation list for the signed-in user. */
authRouter.get(
  "/inbox",
  requireUser,
  asyncHandler(async (req: UserRequest, res) => {
    const threads = await listThreadsForUser(req.user!.id);
    res.json({ success: true, threads });
  })
);

/** GET /api/auth/inbox/:threadId — open a thread (marks admin replies read). */
authRouter.get(
  "/inbox/:threadId",
  requireUser,
  asyncHandler(async (req: UserRequest, res) => {
    const idCheck = uuidSchema.safeParse(req.params.threadId);
    if (!idCheck.success) {
      res.status(400).json({ success: false, error: "Invalid thread id" });
      return;
    }
    const thread = await getThreadById(idCheck.data);
    if (!thread || thread.user_id !== req.user!.id) {
      res.status(404).json({ success: false, error: "Thread not found" });
      return;
    }
    await markThreadRead({ thread_id: thread.id, sender: "admin" });
    const messages = await listMessagesForThread(thread.id);
    res.json({ success: true, thread, messages });
  })
);

/** POST /api/auth/inbox/:threadId/messages — user reply. */
authRouter.post(
  "/inbox/:threadId/messages",
  requireUser,
  profileLimiter,
  asyncHandler(async (req: UserRequest, res) => {
    const idCheck = uuidSchema.safeParse(req.params.threadId);
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
    if (!thread || thread.user_id !== req.user!.id) {
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
      sender: "user",
      body: parsed.data.body,
    });
    if (!message) {
      res.status(400).json({ success: false, error: "Could not send reply" });
      return;
    }

    logger.info("User replied to thread", {
      thread_id: thread.id,
      user_id: req.user!.id,
      message_id: message.id,
    });
    res.status(201).json({ success: true, message });
  })
);
