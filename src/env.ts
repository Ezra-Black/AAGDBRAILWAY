/**
 * Production boot gates and shared env helpers.
 * Fail closed: missing security-critical vars abort startup in production.
 */

import { logger } from "./logger";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Trimmed env var or empty string. */
export function envTrim(name: string): string {
  return process.env[name]?.trim() || "";
}

/**
 * Origins allowed for CORS + same-origin CSRF checks.
 * Prefer CORS_ORIGIN; fall back to PUBLIC_BASE_URL.
 */
export function allowedOrigins(): string[] {
  const cors = envTrim("CORS_ORIGIN");
  if (cors) {
    return cors
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  }
  const base = envTrim("PUBLIC_BASE_URL").replace(/\/+$/, "");
  return base ? [base] : [];
}

export function publicBaseUrlRequired(): string {
  return envTrim("PUBLIC_BASE_URL").replace(/\/+$/, "");
}

/**
 * Abort process if production is missing required hardening env.
 * Call once before listen() (web) and at worker start.
 */
export function assertProductionSecurityEnv(role: "web" | "worker"): void {
  if (!isProduction()) return;

  const missing: string[] = [];

  if (!envTrim("DATABASE_URL")) missing.push("DATABASE_URL");
  if (!envTrim("PUBLIC_BASE_URL")) missing.push("PUBLIC_BASE_URL");
  if (!envTrim("AUTOMATION_API_KEY")) missing.push("AUTOMATION_API_KEY");
  if (!envTrim("ANALYTICS_SALT") && role === "web") {
    missing.push("ANALYTICS_SALT");
  }
  if (!envTrim("CORS_ORIGIN") && role === "web") {
    missing.push("CORS_ORIGIN");
  }

  if (missing.length === 0) return;

  logger.error("Refusing to start: missing required production env", {
    role,
    missing,
  });
  process.exit(1);
}
