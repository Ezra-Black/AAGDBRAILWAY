import type { Request, Response, NextFunction, RequestHandler } from "express";
import rateLimit from "express-rate-limit";

const jsonLimitMessage = {
  success: false,
  error: "Too many requests, please try again later",
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Global ceiling — soft DDoS protection across all routes. */
export const globalLimiter = rateLimit({
  windowMs: envInt("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
  max: envInt("RATE_LIMIT_MAX", 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonLimitMessage,
});

/** Tight limit on public form submits (per IP). */
export const submitLimiter = rateLimit({
  windowMs: envInt("SUBMIT_RATE_WINDOW_MS", 15 * 60 * 1000),
  max: envInt("SUBMIT_RATE_MAX", 8),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many submissions from this device. Please wait and try again.",
  },
});

/** Login brute-force protection. */
export const loginLimiter = rateLimit({
  windowMs: envInt("LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000),
  max: envInt("LOGIN_RATE_MAX", 8),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many login attempts, try again later",
  },
});

/** Visit bump: once an hour per IP so refreshes don’t explode the counter. */
export const newsletterVisitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Visit already counted",
  },
});

/** Read/automation endpoints — keep enumeration expensive. */
export const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: envInt("READ_RATE_MAX", 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonLimitMessage,
});

/**
 * Optional API key for automation/debug endpoints.
 * When AUTOMATION_API_KEY is set, require header: x-api-key: <key>
 */
export function requireAutomationKeyIfConfigured(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = process.env.AUTOMATION_API_KEY?.trim();
  if (!expected) {
    next();
    return;
  }

  const provided = String(req.header("x-api-key") || "").trim();
  if (!provided || provided !== expected) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  next();
}

/** Reject obvious bot honeypot fills without revealing the trap. */
export function honeypotFilled(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const website = (body as { website?: unknown }).website;
  if (typeof website !== "string") return false;
  return website.trim().length > 0;
}

export const rejectHoneypot: RequestHandler = (req, res, next) => {
  if (honeypotFilled(req.body)) {
    // Fake success so bots don't retry aggressively
    res.status(201).json({
      success: true,
      duplicate: false,
      message:
        "Submitted! You’re on the list — keep an eye on your email for an update.",
    });
    return;
  }
  next();
};
