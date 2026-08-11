import fs from "fs/promises";
import path from "path";
import {
  isAllowedPlaceholderFetchUrl,
  resolveUnderUploadRoot,
} from "../uploadPaths";

function uploadRoot(): string {
  return process.env.UPLOAD_DIR?.trim() || path.join(process.cwd(), "uploads");
}

function publicBase(explicit?: string): string {
  return (explicit || process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

async function fetchAllowedUrl(url: string): Promise<Buffer> {
  if (!isAllowedPlaceholderFetchUrl(url)) {
    throw new Error("Placeholder URL host is not allow-listed");
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch placeholder URL (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
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
    if (!isAllowedPlaceholderFetchUrl(trimmed)) {
      throw new Error("Placeholder URL host is not allow-listed");
    }
    return { source: trimmed, kind: "url" };
  }

  const base = publicBase(publicBaseUrl);
  if (base && trimmed.startsWith("/")) {
    const absolute = `${base}${trimmed}`;
    if (!isAllowedPlaceholderFetchUrl(absolute)) {
      // Fall through to local disk / data URI instead of a blocked host.
    } else {
      return { source: absolute, kind: "url" };
    }
  }

  return {
    source: await loadPlaceholderDataUri(trimmed, publicBaseUrl),
    kind: "data_uri",
  };
}

/**
 * Load a placeholder image as a data URI for xAI edits.
 * Supports /assets/..., /uploads/..., or allow-listed http(s) URLs.
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
    const buf = await fetchAllowedUrl(trimmed);
    const mime = guessMime(trimmed);
    return `data:${mime};base64,${buf.toString("base64")}`;
  }

  if (trimmed.startsWith("/assets/")) {
    const filePath = path.join(process.cwd(), "public", trimmed);
    const resolvedPublic = path.resolve(path.join(process.cwd(), "public"));
    const resolvedFile = path.resolve(filePath);
    if (
      resolvedFile !== resolvedPublic &&
      !resolvedFile.startsWith(resolvedPublic + path.sep)
    ) {
      throw new Error("Invalid assets path");
    }
    const buf = await fs.readFile(resolvedFile);
    return `data:${guessMime(resolvedFile)};base64,${buf.toString("base64")}`;
  }

  if (trimmed.startsWith("/uploads/")) {
    const filePath = resolveUnderUploadRoot(uploadRoot(), trimmed);
    if (!filePath) {
      throw new Error("Invalid uploads path");
    }
    const buf = await fs.readFile(filePath);
    return `data:${guessMime(filePath)};base64,${buf.toString("base64")}`;
  }

  const local = path.join(process.cwd(), "public", trimmed.replace(/^\//, ""));
  try {
    const resolvedPublic = path.resolve(path.join(process.cwd(), "public"));
    const resolvedFile = path.resolve(local);
    if (
      resolvedFile !== resolvedPublic &&
      !resolvedFile.startsWith(resolvedPublic + path.sep)
    ) {
      throw new Error("Invalid public path");
    }
    const buf = await fs.readFile(resolvedFile);
    return `data:${guessMime(local)};base64,${buf.toString("base64")}`;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid")) throw err;
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
