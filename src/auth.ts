import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import {
  createAdminSession,
  deleteSessionByTokenHash,
  getAdminByEmail,
  getAdminById,
  getAdminIdBySessionTokenHash,
} from "./db/admins";

const COOKIE_NAME = "aag_admin_session";
const SESSION_DAYS = 14;

export interface AdminRequest extends Request {
  admin?: { id: string; email: string };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

export async function loginAdmin(
  email: string,
  password: string
): Promise<{ admin: { id: string; email: string }; token: string } | null> {
  const admin = await getAdminByEmail(email);
  if (!admin) return null;

  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return null;

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await createAdminSession(admin.id, hashToken(token), expiresAt);

  return {
    admin: { id: admin.id, email: admin.email },
    token,
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export async function logoutAdmin(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (token) {
    await deleteSessionByTokenHash(hashToken(token));
  }
  clearSessionCookie(res);
}

export async function requireAdmin(
  req: AdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = req.cookies?.[COOKIE_NAME] as string | undefined;
    if (!token) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const adminId = await getAdminIdBySessionTokenHash(hashToken(token));
    if (!adminId) {
      clearSessionCookie(res);
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const admin = await getAdminById(adminId);
    if (!admin) {
      clearSessionCookie(res);
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    req.admin = { id: admin.id, email: admin.email };
    next();
  } catch (err) {
    next(err);
  }
}
