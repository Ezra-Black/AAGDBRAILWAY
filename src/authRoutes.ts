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
import { sendPasswordResetEmail } from "./email";
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
  userChangePasswordSchema,
  userForgotPasswordSchema,
  userLoginSchema,
  userProfileUpdateSchema,
  userRegisterSchema,
  userResetPasswordSchema,
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
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  // trust proxy is enabled, so protocol/host reflect the Railway edge.
  return `${req.protocol}://${req.get("host")}`;
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

    await issueSession(res, user.id);
    logger.info("User registered", { user_id: user.id });

    res.status(201).json({
      success: true,
      message: "Welcome! Your account is ready.",
      user: toPublicUser(user),
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
    res.json({ success: true, user: toPublicUser(user) });
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
    res.json({ success: true, user: toPublicUser(req.user!) });
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
      angel_name: patch.angel_name,
    });

    logger.info("User profile updated", { user_id: user.id });
    res.json({
      success: true,
      message: "Profile saved.",
      user: toPublicUser(updated!),
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
 * Always responds with the same message so emails can't be enumerated.
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
