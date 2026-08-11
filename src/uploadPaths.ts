import path from "path";

/**
 * Resolve a path under the upload root. Returns null if the result would
 * escape the root (symlink / .. tricks).
 */
export function resolveUnderUploadRoot(
  uploadRoot: string,
  relativeOrUrlPath: string
): string | null {
  const root = path.resolve(uploadRoot);
  let rel = relativeOrUrlPath.trim();
  if (rel.startsWith("/uploads/")) {
    rel = rel.slice("/uploads/".length);
  }
  rel = rel.replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return null;

  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".localhost")
  ) {
    return true;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const parts = h.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/** Block obvious SSRF targets (localhost / private ranges / non-http). */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !isPrivateHostname(url.hostname);
}

/**
 * Hostnames the worker may fetch for *placeholder* images (admin-/DB-controlled).
 * Result downloads from xAI use {@link isPublicHttpUrl} instead.
 */
export function isAllowedPlaceholderFetchUrl(raw: string): boolean {
  if (!isPublicHttpUrl(raw)) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();

  const base = (process.env.PUBLIC_BASE_URL || "").trim();
  if (base) {
    try {
      if (new URL(base).hostname.toLowerCase() === host) return true;
    } catch {
      // ignore
    }
  }

  const allowSuffixes = [
    "x.ai",
    "api.x.ai",
    "blob.core.windows.net",
    "r2.cloudflarestorage.com",
    "amazonaws.com",
    "cloudfront.net",
    "googleusercontent.com",
  ];
  return allowSuffixes.some((s) => host === s || host.endsWith("." + s));
}
