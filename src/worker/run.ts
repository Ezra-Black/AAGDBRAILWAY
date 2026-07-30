/**
 * Always-on graphic worker for Railway (or local).
 *
 * Two stages, so a retry can tell which half of the job already happened:
 *
 *   generate  pending → processing → validated
 *             claim, reuse or create the graphic, store it in Postgres
 *
 *   deliver   validated → applied → processed
 *             record the delivery intent, email the customer, confirm it
 *
 * Every transition is guarded on the row's version, so a claim made before a
 * requeue can never overwrite newer state. Delivery is guarded by a unique
 * idempotency key written before the send, so an interrupted or unconfirmed
 * send is never repeated automatically.
 *
 * Env: DATABASE_URL, XAI_API_KEY, SMTP_*, PUBLIC_BASE_URL (optional),
 *      FAILURE_ALERT_EMAIL, POLL_SECONDS, UPLOAD_DIR
 */
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import {
  claimNextPending,
  claimValidatedForDelivery,
  closeLegacyFailedBefore,
  escalateStuckApplied,
  findDeliveredDuplicate,
  reclaimStuckProcessing,
  recordFailure,
  releaseRequiresPhotoProcessing,
  requeueDueRetries,
  skipLegacyPendingBefore,
  transitionEntry,
  type Entry,
  type FailureClass,
} from "../db/entries";
import {
  markDeliveryNotSent,
  markDeliverySent,
  markDeliveryUnconfirmed,
} from "../db/deliveries";
import { getGraphicImageUrl, getGraphicLabel, graphicRequiresPhoto } from "../db/graphics";
import {
  sendGraphicDeliveryEmail,
  sendPipelineFailureEmail,
} from "../email";
import { logger } from "../logger";
import { migrate } from "../db/migrate";
import { withAdvisoryLock } from "../db/pool";
import { editAngelGraphic } from "../xai/imagine";
import { getEntryPhoto, upsertEntryPhoto } from "../db/entryPhotos";
import { isAiWorkerEnabled } from "../db/settings";
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

/** How long an unconfirmed delivery may sit before a person is asked. */
const APPLIED_REVIEW_MINUTES = Math.max(
  5,
  Number(process.env.DELIVERY_REVIEW_MINUTES) || 15
);

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

async function graphicDisplayName(entry: Entry): Promise<string> {
  if (!entry.graphic_code) return "(unknown graphic)";
  try {
    const label = await getGraphicLabel(entry.graphic_code);
    return label || entry.graphic_code;
  } catch (err) {
    logger.warn("Could not resolve graphic label", { error: String(err) });
    return entry.graphic_code;
  }
}

/**
 * Record a stage failure and tell Audrey. Transient failures are retried with
 * backoff; permanent ones stop immediately for a person to handle.
 */
async function failStage(
  entry: Entry,
  stage: "generate" | "deliver",
  error: string,
  failureClass: FailureClass,
  metadata?: Record<string, unknown>
): Promise<void> {
  const graphicDisplay = await graphicDisplayName(entry);

  logger.error("Graphic pipeline failed", {
    id: entry.id,
    stage,
    failure_class: failureClass,
    angel_name: entry.angel_name,
    email: entry.email,
    graphic_code: entry.graphic_code,
    graphic_label: graphicDisplay,
    error,
  });
  console.error(
    `[pipeline-fail] stage=${stage} entry=${entry.id} angel=${entry.angel_name} graphic=${graphicDisplay} (${entry.graphic_code || "n/a"}) error=${error}`
  );

  const outcome = await recordFailure({
    entry,
    stage,
    error,
    failureClass,
    metadata: { graphic_label: graphicDisplay, ...(metadata ?? {}) },
  });

  if (!outcome.entry) {
    logger.warn("Failure not recorded — row moved on before we could write it", {
      id: entry.id,
      expected_version: entry.version,
    });
    return;
  }

  await sendPipelineFailureEmail({
    entryId: entry.id,
    angelName: entry.angel_name,
    email: entry.email,
    graphicCode: entry.graphic_code
      ? `${graphicDisplay} (${entry.graphic_code})`
      : graphicDisplay,
    error,
    escalated: outcome.escalated,
    retryInMinutes: outcome.retryInMinutes,
  });
}

/** Stage 1: turn a pending request into a stored graphic. */
async function generateStage(cutoff: Date): Promise<boolean> {
  const entry = await claimNextPending(cutoff);
  if (!entry) return false;

  logger.info("Claimed pending entry", {
    id: entry.id,
    version: entry.version,
    attempt: entry.attempt_count,
    angel_name: entry.angel_name,
    graphic_code: entry.graphic_code,
    created_at: entry.created_at,
  });

  try {
    // Safety net: never run AI on graphics that require a customer photo.
    if (entry.graphic_code && (await graphicRequiresPhoto(entry.graphic_code))) {
      await transitionEntry(entry.id, "processing", "pending", entry.version, {
        actor: "worker:generate",
        reason: "manual-only graphic requires a customer photo",
        metadata: {
          skipped_requires_photo: "true",
          note: "Manual-only graphic (requires customer photo) — worker ignored",
        },
      });
      logger.info("Skipped requires_photo entry (manual only)", {
        id: entry.id,
        graphic_code: entry.graphic_code,
      });
      return true;
    }

    const email = entry.email?.trim();
    if (!email) {
      await failStage(entry, "generate", "Entry has no customer email", "permanent");
      return true;
    }
    if (!entry.graphic_code?.trim()) {
      await failStage(entry, "generate", "Entry has no graphic_code", "permanent");
      return true;
    }

    // Cheap pre-check: skip generation entirely for an already-served intent.
    const prior = await findDeliveredDuplicate(
      email,
      entry.angel_name,
      entry.graphic_code
    );
    if (prior && prior.id !== entry.id) {
      await transitionEntry(entry.id, "processing", "processed", entry.version, {
        actor: "worker:generate",
        reason: "already delivered to this customer",
        bumpVersion: true,
        clearRetry: true,
        metadata: {
          skipped_duplicate: "true",
          photo_sent: "true",
          duplicate_of: prior.id,
          note: "Already delivered this angel name + graphic to this email once",
        },
      });
      logger.info("Skipped duplicate delivery", {
        id: entry.id,
        duplicate_of: prior.id,
      });
      return true;
    }

    // A retry after a delivery failure must not pay for the artwork twice.
    const stored = await getEntryPhoto(entry.id, "generated");
    if (stored) {
      logger.info("Reusing graphic generated on an earlier attempt", {
        id: entry.id,
        bytes: stored.byte_length,
      });
      await transitionEntry(entry.id, "processing", "validated", entry.version, {
        actor: "worker:generate",
        reason: "reused stored graphic",
        metadata: { reused_generated_photo: "true" },
      });
      return true;
    }

    const imageUrl = await getGraphicImageUrl(entry.graphic_code);
    if (!imageUrl) {
      await failStage(
        entry,
        "generate",
        `No placeholder image_url for graphic_code=${entry.graphic_code}`,
        "permanent"
      );
      return true;
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

    // Persist in Postgres so the delivery stage and the admin portal can read
    // it even when the worker uses a separate Railway volume.
    await upsertEntryPhoto({
      entryId: entry.id,
      kind: "generated",
      contentType: edited.contentType,
      originalFilename: safeAngelFilename(entry.angel_name),
      bytes: edited.buffer,
    });

    const validated = await transitionEntry(
      entry.id,
      "processing",
      "validated",
      entry.version,
      {
        actor: "worker:generate",
        reason: "graphic generated and stored",
        metadata: {
          photo_path: storedPath,
          photo_url: edited.url || storedPath,
          placeholder_url: imageUrl,
          generated_at: new Date().toISOString(),
        },
      }
    );
    if (!validated) {
      logger.warn("Generated graphic but the row moved on — leaving it alone", {
        id: entry.id,
        expected_version: entry.version,
      });
      return true;
    }

    logger.info("Graphic stored and ready to deliver", {
      id: entry.id,
      bytes: edited.buffer.length,
    });
  } catch (err) {
    await failStage(entry, "generate", String(err), "transient");
  }
  return true;
}

/** Stage 2: email the stored graphic exactly once. */
async function deliverStage(cutoff: Date): Promise<boolean> {
  const claim = await claimValidatedForDelivery(cutoff);

  if (claim.kind === "empty") return false;

  if (claim.kind === "duplicate") {
    logger.info("Delivery already sent for this request — closed as duplicate", {
      id: claim.entry.id,
      delivery_key: claim.existing.idempotency_key,
    });
    return true;
  }

  if (claim.kind === "unconfirmed") {
    logger.warn("Held back a possible repeat send for review", {
      id: claim.entry.id,
      delivery_key: claim.existing.idempotency_key,
      last_error: claim.existing.last_error,
    });
    console.error(
      `[needs-review] entry=${claim.entry.id} angel=${claim.entry.angel_name} reason=earlier send never confirmed`
    );
    await sendPipelineFailureEmail({
      entryId: claim.entry.id,
      angelName: claim.entry.angel_name,
      email: claim.entry.email,
      graphicCode: claim.entry.graphic_code,
      error:
        "An earlier email for this customer, angel name and graphic was handed to " +
        "the mail server but never confirmed. It was not sent again, to avoid a " +
        "second copy. Check the customer's inbox before resending.",
      escalated: true,
    });
    return true;
  }

  const { entry, deliveryKey: key } = claim;
  const email = entry.email!.trim();

  try {
    const stored = await getEntryPhoto(entry.id, "generated");
    if (!stored) {
      await markDeliveryNotSent(key, "No generated graphic stored for this entry");
      await failStage(
        entry,
        "deliver",
        "No generated graphic stored for this entry",
        "transient"
      );
      return true;
    }

    logger.info("Sending delivery email", {
      id: entry.id,
      to: email,
      attempt: entry.attempt_count,
    });

    const outcome = await sendGraphicDeliveryEmail({
      to: email,
      angelName: entry.angel_name,
      filename: stored.original_filename || safeAngelFilename(entry.angel_name),
      image: stored.bytes,
      contentType: stored.content_type,
    });

    if (outcome.status === "sent") {
      await markDeliverySent(key);
      const done = await transitionEntry(
        entry.id,
        "applied",
        "processed",
        entry.version,
        {
          actor: "worker:deliver",
          reason: "delivery confirmed by SMTP",
          bumpVersion: true,
          clearRetry: true,
          metadata: {
            photo_sent: "true",
            delivered_at: new Date().toISOString(),
            failure_acked: "true",
          },
        }
      );
      logger.info("Graphic delivered", {
        id: entry.id,
        angel_name: entry.angel_name,
        to: email,
        version: done?.version ?? entry.version,
      });
      return true;
    }

    if (outcome.status === "not_sent") {
      // Proven undelivered, so a later attempt is safe.
      await markDeliveryNotSent(key, outcome.error);
      await failStage(entry, "deliver", outcome.error, "transient", {
        delivery_outcome: "not_sent",
      });
      return true;
    }

    // Unknown: the customer may already have it. Stop and ask.
    await markDeliveryUnconfirmed(key, outcome.error);
    await transitionEntry(entry.id, "applied", "escalated", entry.version, {
      actor: "worker:deliver",
      reason: "delivery outcome unconfirmed",
      metadata: {
        error: outcome.error,
        failure_stage: "deliver",
        delivery_outcome: "unknown",
        escalated_at: new Date().toISOString(),
        escalation_reason: "delivery_outcome_unconfirmed",
        note: "The mail server never confirmed this send. Check the customer inbox before resending.",
        failure_acked: "false",
      },
    });
    logger.error("Delivery outcome unknown — escalated instead of retried", {
      id: entry.id,
      error: outcome.error,
    });
    console.error(
      `[needs-review] entry=${entry.id} angel=${entry.angel_name} reason=send outcome unknown error=${outcome.error}`
    );
    await sendPipelineFailureEmail({
      entryId: entry.id,
      angelName: entry.angel_name,
      email: entry.email,
      graphicCode: entry.graphic_code,
      error:
        `The mail server never confirmed this delivery, so it may or may not have ` +
        `arrived: ${outcome.error}. It will not be retried automatically. Check the ` +
        `customer's inbox, then resend from Admin → Requests if needed.`,
      escalated: true,
    });
  } catch (err) {
    // The delivery record stays 'attempted', so nothing retries the send.
    await markDeliveryUnconfirmed(key, String(err));
    await failStage(entry, "deliver", String(err), "permanent", {
      delivery_outcome: "unknown",
    });
  }
  return true;
}

async function tick(cutoff: Date): Promise<void> {
  const released = await releaseRequiresPhotoProcessing();
  if (released > 0) {
    logger.info("Released requires_photo jobs back to pending", {
      count: released,
    });
  }

  // An unconfirmed delivery is never retried, only aged out to a person.
  const escalated = await escalateStuckApplied(APPLIED_REVIEW_MINUTES);
  if (escalated > 0) {
    logger.warn("Escalated deliveries with no confirmed outcome", {
      count: escalated,
    });
    console.error(
      `[needs-review] ${escalated} delivery(s) had no confirmed outcome — see Admin → Requests`
    );
  }

  if (!(await isAiWorkerEnabled())) {
    // Kill switch: keep the housekeeping sweeps, claim no new work.
    return;
  }

  const reclaimed = await reclaimStuckProcessing(8, cutoff);
  if (reclaimed > 0) {
    logger.warn("Reclaimed stuck processing entries", { count: reclaimed });
  }

  const requeued = await requeueDueRetries(cutoff);
  if (requeued > 0) {
    logger.info("Requeued failures whose backoff elapsed", { count: requeued });
  }

  await generateStage(cutoff);
  await deliverStage(cutoff);
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

  // The worker migrates too, so it no longer matters whether this service or
  // the web service redeploys first. The lock keeps them from racing.
  await withAdvisoryLock("aagdb_migrate", () => migrate());

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
    delivery_review_minutes: APPLIED_REVIEW_MINUTES,
    skipped_legacy_pending: skippedPending,
    closed_legacy_failed: closedFailed,
    ai_worker_enabled: await isAiWorkerEnabled(),
  });

  let lastPausedLog = 0;
  for (;;) {
    try {
      const aiOn = await isAiWorkerEnabled();
      if (!aiOn) {
        const now = Date.now();
        if (now - lastPausedLog > 60_000) {
          logger.warn("AI worker paused by admin kill switch");
          console.error("[ai-worker] paused — admin turned AI off");
          lastPausedLog = now;
        }
      }
      await tick(cutoff);
    } catch (err) {
      logger.error("Worker tick crashed", { error: String(err) });
      console.error(`[pipeline-fail] tick-crash error=${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch((err) => {
  logger.error("Worker failed to start", { error: String(err) });
  process.exit(1);
});
