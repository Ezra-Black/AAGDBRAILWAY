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
  closeLegacyFailedBefore,
  findDeliveredDuplicate,
  reclaimStuckProcessing,
  skipLegacyPendingBefore,
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
import { upsertEntryPhoto } from "../db/entryPhotos";
import {
  resolvePlaceholderForXai,
  safeAngelFilename,
} from "./placeholders";

const POLL_SECONDS = Math.max(
  2,
  Number(process.env.POLL_SECONDS) || 10
);

/** Worker boot time — used when WORKER_MIN_CREATED_AT is unset. */
const WORKER_STARTED_AT = new Date();

/**
 * Only automate entries created at/after this time.
 * Set WORKER_MIN_CREATED_AT (ISO) on Railway to freeze the cutoff across redeploys.
 * Default: this process start time (ignores older pending backlog).
 */
function automationCutoff(): Date {
  const raw = process.env.WORKER_MIN_CREATED_AT?.trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    logger.warn("Invalid WORKER_MIN_CREATED_AT — using worker start time", {
      value: raw,
    });
  }
  return WORKER_STARTED_AT;
}

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

  logger.info("Resolving placeholder image", {
    id: entry.id,
    graphic_code: entry.graphic_code,
  });
  const imageUrl = await getGraphicImageUrl(entry.graphic_code);
  if (!imageUrl) {
    await failEntry(
      entry,
      `No placeholder image_url for graphic_code=${entry.graphic_code}`
    );
    return;
  }

  const placeholder = await resolvePlaceholderForXai(
    imageUrl,
    process.env.PUBLIC_BASE_URL
  );
  logger.info("Placeholder ready for xAI", {
    id: entry.id,
    kind: placeholder.kind,
    image_url: imageUrl,
  });

  const edited = await editAngelGraphic({
    angelName: entry.angel_name,
    imageSource: placeholder.source,
  });
  logger.info("xAI edit complete", {
    id: entry.id,
    bytes: edited.buffer.length,
  });

  const storedPath = await saveGenerated(
    entry.id,
    edited.buffer,
    edited.contentType
  );
  const filename = safeAngelFilename(entry.angel_name);

  // Persist in Postgres so admins can download from the web service
  // even when the worker uses a separate Railway volume.
  await upsertEntryPhoto({
    entryId: entry.id,
    kind: "generated",
    contentType: edited.contentType,
    originalFilename: filename,
    bytes: edited.buffer,
  });
  await updateEntryStatus(entry.id, "processing", {
    photo_path: storedPath,
    photo_url: edited.url || storedPath,
    placeholder_url: imageUrl,
    generated_at: new Date().toISOString(),
  });
  logger.info("Generated graphic stored in DB", {
    id: entry.id,
    bytes: edited.buffer.length,
  });

  logger.info("Sending delivery email", { id: entry.id, to: email });
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
      "Graphic was generated but SMTP delivery failed (check Resend/SMTP env). Download from admin Requests."
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

async function tick(cutoff: Date): Promise<void> {
  const reclaimed = await reclaimStuckProcessing(8, cutoff);
  if (reclaimed > 0) {
    logger.warn("Reclaimed stuck processing entries", { count: reclaimed });
  }

  const entry = await claimNextPending(cutoff);
  if (!entry) return;

  logger.info("Claimed pending entry", {
    id: entry.id,
    angel_name: entry.angel_name,
    graphic_code: entry.graphic_code,
    created_at: entry.created_at,
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

  const cutoff = automationCutoff();

  // Close manually-handled backlog so the worker never emails those again.
  const skippedPending = await skipLegacyPendingBefore(cutoff);
  const closedFailed = await closeLegacyFailedBefore(cutoff);
  logger.info("Graphic worker starting", {
    poll_seconds: POLL_SECONDS,
    has_smtp: Boolean(
      process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
    ),
    automation_cutoff: cutoff.toISOString(),
    skipped_legacy_pending: skippedPending,
    closed_legacy_failed: closedFailed,
  });

  for (;;) {
    try {
      await tick(cutoff);
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
