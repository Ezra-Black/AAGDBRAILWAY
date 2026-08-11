import fs from "fs/promises";
import path from "path";

function uploadRoot(): string {
  return process.env.UPLOAD_DIR?.trim() || path.join(process.cwd(), "uploads");
}

function publicBase(explicit?: string): string {
  return (explicit || process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

/**
 * Prefer a public https URL for xAI (smaller request, faster).
 * Falls back to a data URI when the file is only on local disk.
 */
export async function resolvePlaceholderForXai(
  imageUrl: string,
  publicBaseUrl?: string
): Promise<{ source: string; kind: "url" | "data_uri" }> {
  const trimmed = imageUrl.trim();
  if (!trimmed) {
    throw new Error("Missing placeholder image_url");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { source: trimmed, kind: "url" };
  }

  const base = publicBase(publicBaseUrl);
  if (base && trimmed.startsWith("/")) {
    return { source: `${base}${trimmed}`, kind: "url" };
  }

  return {
    source: await loadPlaceholderDataUri(trimmed, publicBaseUrl),
    kind: "data_uri",
  };
}

/**
 * Load a placeholder image as a data URI for xAI edits.
 * Supports /assets/..., /uploads/..., or absolute http(s) URLs.
 * Never writes back to the original asset.
 */
export async function loadPlaceholderDataUri(
  imageUrl: string,
  publicBaseUrl?: string
): Promise<string> {
  const trimmed = imageUrl.trim();
  if (!trimmed) {
    throw new Error("Missing placeholder image_url");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const res = await fetch(trimmed);
    if (!res.ok) {
      throw new Error(`Failed to fetch placeholder URL (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || guessMime(trimmed);
    return `data:${mime};base64,${buf.toString("base64")}`;
  }

  if (trimmed.startsWith("/assets/")) {
    const filePath = path.join(process.cwd(), "public", trimmed);
    const buf = await fs.readFile(filePath);
    return `data:${guessMime(filePath)};base64,${buf.toString("base64")}`;
  }

  if (trimmed.startsWith("/uploads/")) {
    const rel = trimmed.replace(/^\/uploads\//, "");
    const filePath = path.join(uploadRoot(), rel);
    const buf = await fs.readFile(filePath);
    return `data:${guessMime(filePath)};base64,${buf.toString("base64")}`;
  }

  const local = path.join(process.cwd(), "public", trimmed.replace(/^\//, ""));
  try {
    const buf = await fs.readFile(local);
    return `data:${guessMime(local)};base64,${buf.toString("base64")}`;
  } catch {
    const base = publicBase(publicBaseUrl);
    if (!base) {
      throw new Error(
        `Cannot resolve placeholder ${trimmed} — set PUBLIC_BASE_URL or ship the file in public/`
      );
    }
    return loadPlaceholderDataUri(
      `${base}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`
    );
  }
}

export function safeAngelFilename(angelName: string): string {
  const base = angelName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "angel"}.jpg`;
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}
