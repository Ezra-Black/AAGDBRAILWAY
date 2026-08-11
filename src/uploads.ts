import crypto from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import { logger } from "./logger";

/**
 * Profile photo storage.
 *
 * Files land in UPLOAD_DIR (default ./uploads). On Railway, attach a Volume
 * to the service and set UPLOAD_DIR to its mount path (e.g. /data/uploads)
 * so photos survive redeploys. Swapping in S3/R2 later only means replacing
 * `saveProfilePhoto` / `deleteProfilePhoto` — routes stay the same.
 *
 * Security: uploads are buffered in memory, capped at 5 MB, and validated by
 * magic bytes (not the client-supplied MIME type or filename). Stored names
 * are random hex + a whitelisted extension, so user input never touches the
 * filesystem path.
 */

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export function uploadDir(): string {
  return (
    process.env.UPLOAD_DIR?.trim() || path.join(__dirname, "..", "uploads")
  );
}

export function ensureUploadDir(): void {
  fs.mkdirSync(path.join(uploadDir(), "avatars"), { recursive: true });
  fs.mkdirSync(path.join(uploadDir(), "graphics"), { recursive: true });
  fs.mkdirSync(path.join(uploadDir(), "customer"), { recursive: true });
  fs.mkdirSync(path.join(uploadDir(), "generated"), { recursive: true });
}

export const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
});

type ImageKind = { ext: string; mime: string };

/** Sniff real file type from magic bytes; null when not an allowed image. */
function detectImageKind(buffer: Buffer): ImageKind | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { ext: "png", mime: "image/png" };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  // GIF: "GIF87a" / "GIF89a"
  const gifHeader = buffer.toString("ascii", 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { ext: "gif", mime: "image/gif" };
  }
  return null;
}

/**
 * Persist an uploaded photo for a user. Returns the public URL path
 * (served from /uploads/...) or null when the file isn't a valid image.
 */
export async function saveProfilePhoto(
  userId: string,
  buffer: Buffer
): Promise<string | null> {
  const kind = detectImageKind(buffer);
  if (!kind) return null;

  ensureUploadDir();
  const name = `${userId}-${crypto.randomBytes(8).toString("hex")}.${kind.ext}`;
  const filePath = path.join(uploadDir(), "avatars", name);
  await fs.promises.writeFile(filePath, buffer);
  return `/uploads/avatars/${name}`;
}

/** Remove a previously stored photo. Ignores anything outside our dir. */
export async function deleteProfilePhoto(urlPath: string | null): Promise<void> {
  if (!urlPath || !urlPath.startsWith("/uploads/avatars/")) return;

  const name = path.basename(urlPath);
  // Random-hex names only — anything else is not ours to delete.
  if (!/^[0-9a-f-]+\.(jpg|png|webp|gif)$/i.test(name)) return;

  const filePath = path.join(uploadDir(), "avatars", name);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    // Already gone (e.g. ephemeral disk after redeploy) — not an error.
    logger.info("Old profile photo not removed", { error: String(err) });
  }
}

/**
 * Persist a sample graphic for the request form / shop preview.
 * Returns the public URL path or null when the file isn't a valid image.
 */
export async function saveGraphicSample(
  buffer: Buffer
): Promise<string | null> {
  const kind = detectImageKind(buffer);
  if (!kind) return null;

  ensureUploadDir();
  const name = `${crypto.randomBytes(16).toString("hex")}.${kind.ext}`;
  const filePath = path.join(uploadDir(), "graphics", name);
  await fs.promises.writeFile(filePath, buffer);
  return `/uploads/graphics/${name}`;
}

/** Remove a previously stored graphic sample. Ignores paths outside our dir. */
export async function deleteGraphicSample(
  urlPath: string | null
): Promise<void> {
  if (!urlPath || !urlPath.startsWith("/uploads/graphics/")) return;

  const name = path.basename(urlPath);
  if (!/^[0-9a-f]+\.(jpg|png|webp|gif)$/i.test(name)) return;

  const filePath = path.join(uploadDir(), "graphics", name);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    logger.info("Old graphic sample not removed", { error: String(err) });
  }
}

/** JPG/PNG only — used for customer request-form uploads. */
export function detectJpegOrPng(buffer: Buffer): ImageKind | null {
  const kind = detectImageKind(buffer);
  if (!kind) return null;
  if (kind.ext !== "jpg" && kind.ext !== "png") return null;
  return kind;
}

/**
 * Persist a customer-uploaded photo for a request (separate from generated art).
 * Returns the public path under /uploads/customer/ or null if not jpg/png.
 */
export async function saveCustomerPhoto(
  _entryId: string,
  buffer: Buffer
): Promise<{ path: string; contentType: string; ext: string } | null> {
  const kind = detectJpegOrPng(buffer);
  if (!kind) return null;

  ensureUploadDir();
  // Unguessable name (entry id is not embedded). Disk path is metadata-only;
  // /uploads/customer is not publicly served — admins use DB-backed downloads.
  const name = `${crypto.randomBytes(16).toString("hex")}.${kind.ext}`;
  const filePath = path.join(uploadDir(), "customer", name);
  await fs.promises.writeFile(filePath, buffer);
  return {
    path: `/uploads/customer/${name}`,
    contentType: kind.mime,
    ext: kind.ext,
  };
}
