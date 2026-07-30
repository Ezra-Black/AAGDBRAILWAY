/**
 * Always-on graphic worker for Railway (or local).
 *
 * Flow:
 *   claim pending entry → skip duplicates → xAI edit placeholder
 *   → email customer via Resend/SMTP → mark processed
 *   On failure: mark failed, email FAILURE_ALERT_EMAIL, admin banner.
 *
 * Env: DATABASE_URL, XAI_API_KEY, SMTP_*, PUBLIC_BASE_URL (optional),
 *      FAILURE_ALERT_EMAIL, POLL_SECONDS, UPLOAD_DIR
 */
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import {
  claimNextPending,
  findDeliveredDuplicate,
  updateEntryStatus,
  type Entry,
} from "../db/entries";
import { getGraphicImageUrl } from "../db/graphics";
import {
  sendGraphicDeliveryEmail,
  sendPipelineFailureEmail,
} from "../email";
import { logger } from "../logger";
import { editAngelGraphic } from "../xai/imagine";
import { loadPlaceholderDataUri, safeAngelFilename } from "./placeholders";

const POLL_SECONDS = Math.max(
  2,
  Number(process.env.POLL_SECONDS) || 10
);

function uploadRoot(): string {
  return process.env.UPLOAD_DIR?.trim() || path.join(process.cwd(), "uploads");
}

async function saveGenerated(
  entryId: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  const ext = contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
      ? "webp"
      : "jpg";
  const dir = path.join(uploadRoot(), "generated");
  await fs.mkdir(dir, { recursive: true });
  const filename = `${entryId}.${ext}`;
  const full = path.join(dir, filename);
  await fs.writeFile(full, buffer);
  return `/uploads/generated/${filename}`;
}

async function failEntry(entry: Entry, error: string): Promise<void> {
  logger.error("Graphic pipeline failed", {
    id: entry.id,
    angel_name: entry.angel_name,
    error,
  });

  await updateEntryStatus(entry.id, "failed", {
    error,
    failure_acked: "false",
    failed_at: new Date().toISOString(),
  });

  await sendPipelineFailureEmail({
    entryId: entry.id,
    angelName: entry.angel_name,
    email: entry.email,
    graphicCode: entry.graphic_code,
    error,
  });
}

async function processEntry(entry: Entry): Promise<void> {
  const email = entry.email?.trim();
  if (!email) {
    await failEntry(entry, "Entry has no customer email");
    return;
  }
  if (!entry.graphic_code?.trim()) {
    await failEntry(entry, "Entry has no graphic_code");
    return;
  }

  const prior = await findDeliveredDuplicate(
    email,
    entry.angel_name,
    entry.graphic_code
  );
  if (prior && prior.id !== entry.id) {
    await updateEntryStatus(entry.id, "processed", {
      skipped_duplicate: "true",
      photo_sent: "true",
      duplicate_of: prior.id,
      note: "Already delivered this angel name + graphic to this email once",
    });
    logger.info("Skipped duplicate delivery", {
      id: entry.id,
      duplicate_of: prior.id,
    });
    return;
  }

  const imageUrl = await getGraphicImageUrl(entry.graphic_code);
  if (!imageUrl) {
    await failEntry(
      entry,
      `No placeholder image_url for graphic_code=${entry.graphic_code}`
    );
    return;
  }

  const dataUri = await loadPlaceholderDataUri(
    imageUrl,
    process.env.PUBLIC_BASE_URL
  );

  const edited = await editAngelGraphic({
    angelName: entry.angel_name,
    imageDataUri: dataUri,
  });

  const storedPath = await saveGenerated(
    entry.id,
    edited.buffer,
    edited.contentType
  );

  const filename = safeAngelFilename(entry.angel_name);
  const sent = await sendGraphicDeliveryEmail({
    to: email,
    angelName: entry.angel_name,
    filename,
    image: edited.buffer,
    contentType: edited.contentType,
  });

  if (!sent) {
    await failEntry(
      entry,
      "Graphic was generated but SMTP delivery failed (check Resend/SMTP env)"
    );
    return;
  }

  await updateEntryStatus(entry.id, "processed", {
    photo_sent: "true",
    photo_path: storedPath,
    photo_url: edited.url || storedPath,
    placeholder_url: imageUrl,
    delivered_at: new Date().toISOString(),
    failure_acked: "true",
  });

  logger.info("Graphic delivered", {
    id: entry.id,
    angel_name: entry.angel_name,
    to: email,
    photo_path: storedPath,
  });
}

async function tick(): Promise<void> {
  const entry = await claimNextPending();
  if (!entry) return;

  logger.info("Claimed pending entry", {
    id: entry.id,
    angel_name: entry.angel_name,
    graphic_code: entry.graphic_code,
  });

  try {
    await processEntry(entry);
  } catch (err) {
    await failEntry(entry, String(err));
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    logger.error("DATABASE_URL is required for the graphic worker");
    process.exit(1);
  }
  if (!process.env.XAI_API_KEY?.trim()) {
    logger.error("XAI_API_KEY is required for the graphic worker");
    process.exit(1);
  }

  logger.info("Graphic worker starting", {
    poll_seconds: POLL_SECONDS,
    has_smtp: Boolean(
      process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
    ),
  });

  for (;;) {
    try {
      await tick();
    } catch (err) {
      logger.error("Worker tick crashed", { error: String(err) });
    }
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch((err) => {
  logger.error("Worker failed to start", { error: String(err) });
  process.exit(1);
});
