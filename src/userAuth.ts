import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import {
  createUserSession,
  deleteUserSessionByTokenHash,
  getUserByEmail,
  getUserById,
  getUserIdBySessionTokenHash,
  toPublicUser,
  type PublicUser,
  type User,
} from "./db/users";

/**
 * Site-user (customer) authentication.
 *
 * Session model: an opaque 256-bit random token in an httpOnly, Secure,
 * SameSite=Lax cookie. Only the SHA-256 hash of the token is stored in
 * Postgres, so neither an XSS payload (can't read httpOnly cookies) nor a
 * DB dump (hashes only) yields a usable session. SameSite=Lax + JSON-only
 * bodies + strict CORS covers CSRF for these endpoints.
 *
 * Future OAuth: add a provider column to `users`, verify the provider token
 * server-side (see src/facebook.ts for the pattern), then call
 * `issueSession` for the matched/created user — the cookie flow is shared.
 */

const COOKIE_NAME = "aag_user_session";
const SESSION_DAYS = 30;
export const BCRYPT_ROUNDS = 12;

export interface UserRequest extends Request {
  user?: User;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function cookieOptions() {
  return {
    httpOnly: true,
    // Railway terminates TLS at the edge; trust proxy is set in index.ts so
    // Secure cookies work behind it in production.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  passwordHash: string
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

/** Create a DB session for the user and set the session cookie. */
export async function issueSession(res: Response, userId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await createUserSession(userId, hashToken(token), expiresAt);
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

export function clearUserSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

/** Verify email + password. Returns the user or null (never says which failed). */
export async function authenticateUser(
  email: string,
  password: string
): Promise<User | null> {
  const user = await getUserByEmail(email);
  // Compare against a dummy hash when the user doesn't exist so response
  // timing doesn't reveal whether an email is registered.
  const hash =
    user?.password_hash ??
    "$2a$12$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const ok = await bcrypt.compare(password, hash);
  return ok && user ? user : null;
}

export async function logoutUser(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (token) {
    await deleteUserSessionByTokenHash(hashToken(token));
  }
  clearUserSessionCookie(res);
}

async function resolveUserFromRequest(req: Request): Promise<User | null> {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (!token || token.length > 200) return null;

  const userId = await getUserIdBySessionTokenHash(hashToken(token));
  if (!userId) return null;

  return getUserById(userId);
}

/** Hard gate: 401 when there is no valid session. */
export async function requireUser(
  req: UserRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = await resolveUserFromRequest(req);
    if (!user) {
      clearUserSessionCookie(res);
      res.status(401).json({
        success: false,
        error: "Please log in to continue",
        auth_required: true,
      });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Soft gate: attaches req.user when logged in, continues either way. */
export async function attachUserIfPresent(
  req: UserRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = await resolveUserFromRequest(req);
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function publicUser(user: User): PublicUser {
  return toPublicUser(user);
}
