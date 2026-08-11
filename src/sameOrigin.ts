import type { Request, Response, NextFunction, RequestHandler } from "express";
import { allowedOrigins, isProduction } from "./env";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Reject cross-site mutating requests that carry cookies.
 * Relies on Origin (or Referer) matching CORS_ORIGIN / PUBLIC_BASE_URL.
 * In development with no allow-list configured, this is a no-op.
 */
export const requireSameOrigin: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origins = allowedOrigins();
  if (origins.length === 0) {
    if (isProduction()) {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }
    next();
    return;
  }

  const originHeader = String(req.get("origin") || "").trim();
  if (originHeader) {
    const normalized = originHeader.replace(/\/+$/, "");
    if (origins.includes(normalized)) {
      next();
      return;
    }
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }

  // Same-origin form posts / some clients omit Origin; fall back to Referer.
  const referer = String(req.get("referer") || "").trim();
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (origins.includes(refOrigin)) {
        next();
        return;
      }
    } catch {
      // ignore bad referer
    }
  }

  // Non-browser clients (curl, automation) often send neither — allow when
  // the automation API key path is used, otherwise block cookie-bearing POSTs
  // in production. Requests without cookies are still allowed (public APIs).
  const hasCookie = Boolean(req.headers.cookie);
  if (!hasCookie) {
    next();
    return;
  }

  if (isProduction()) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }
  next();
};
