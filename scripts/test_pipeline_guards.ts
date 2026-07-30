/**
 * Guard tests for the graphic pipeline. Runs against a real Postgres.
 *
 *   DATABASE_URL=postgresql://... npm run test:pipeline
 *
 * These cover the cases that produce duplicate customer emails, which is the
 * one failure the pipeline exists to prevent. No network calls: the xAI and
 * SMTP steps are represented by the state changes they would cause.
 */
import "dotenv/config";
import {
  claimNextPending,
  claimValidatedForDelivery,
  escalateStuckApplied,
  recordFailure,
  reopenForResend,
  requeueDueRetries,
  transitionEntry,
  createEntry,
  getEntryById,
  MAX_ATTEMPTS,
  type Entry,
} from "../src/db/entries";
import {
  getDelivery,
  markDeliveryNotSent,
  markDeliverySent,
  markDeliveryUnconfirmed,
} from "../src/db/deliveries";
import { upsertEntryPhoto } from "../src/db/entryPhotos";
import { migrate } from "../src/db/migrate";
import { closePool, query } from "../src/db/pool";

const PAST = new Date(Date.now() - 60 * 60 * 1000);

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    if (detail !== undefined) console.error("        got:", detail);
  }
}

async function section(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n${name}`);
  await fn();
}

/** Take every other request out of the queue so claims are unambiguous. */
async function emptyQueue(): Promise<void> {
  await query(
    `UPDATE entries SET archived_at = NOW()
     WHERE archived_at IS NULL AND status <> 'processed'`
  );
}

let seq = 0;
async function newRequest(overrides: Partial<{ email: string; angel: string; graphic: string }> = {}) {
  seq += 1;
  await emptyQueue();
  return createEntry({
    real_name: `Test Customer ${seq}`,
    angel_name: overrides.angel ?? `Test Angel ${seq}`,
    email: overrides.email ?? `guard-test-${seq}@example.test`,
    graphic_code: overrides.graphic ?? "guard-test-graphic",
  });
}

/** Stand in for the xAI call: the artwork exists and is stored. */
async function storeGeneratedArtwork(entry: Entry): Promise<void> {
  await upsertEntryPhoto({
    entryId: entry.id,
    kind: "generated",
    contentType: "image/jpeg",
    originalFilename: "test.jpg",
    bytes: Buffer.from("fake-jpeg-bytes"),
  });
}

/** Drive one request from pending to validated the way the worker does. */
async function toValidated(entry: Entry): Promise<Entry> {
  const claimed = await claimNextPending(PAST);
  if (!claimed || claimed.id !== entry.id) {
    throw new Error(`Expected to claim ${entry.id}, got ${claimed?.id ?? "nothing"}`);
  }
  await storeGeneratedArtwork(claimed);
  const validated = await transitionEntry(
    claimed.id,
    "processing",
    "validated",
    claimed.version,
    { actor: "test:generate" }
  );
  if (!validated) throw new Error("Could not reach validated");
  return validated;
}

async function main(): Promise<void> {
  await migrate();
  console.log("Migration applied. Re-running to confirm it is repeatable.");
  await migrate();

  // Keep the queue clean: earlier runs must not be claimed by this one.
  await query(
    `UPDATE entries SET archived_at = NOW()
     WHERE email LIKE 'guard-test-%@example.test' AND archived_at IS NULL`
  );
  await query(
    `DELETE FROM graphic_deliveries WHERE idempotency_key LIKE 'guard-test-%'`
  );

  await section("A new request starts durable, at version 1", async () => {
    const entry = await newRequest();
    check("status is pending", entry.status === "pending", entry.status);
    check("version is 1", entry.version === 1, entry.version);
    check("no attempts yet", entry.attempt_count === 0, entry.attempt_count);
  });

  await section("Claiming is atomic and does not bump the version", async () => {
    const entry = await newRequest();
    const claimed = await claimNextPending(PAST);
    check("claimed the queued request", claimed?.id === entry.id, claimed?.id);
    check("moved to processing", claimed?.status === "processing", claimed?.status);
    check("version unchanged", claimed?.version === 1, claimed?.version);

    const second = await claimNextPending(PAST);
    check(
      "a claimed row cannot be claimed twice",
      second === null,
      second?.id
    );
  });

  await section("A stale claim cannot overwrite newer state", async () => {
    const entry = await newRequest();
    const claimed = await claimNextPending(PAST);
    if (!claimed) throw new Error("nothing claimed");

    // Something else finishes the row and bumps the version.
    await transitionEntry(claimed.id, "processing", "validated", claimed.version, {
      actor: "test:other-worker",
    });
    await transitionEntry(claimed.id, "validated", "processed", claimed.version, {
      actor: "test:other-worker",
      bumpVersion: true,
    });

    const stale = await transitionEntry(
      claimed.id,
      "processing",
      "validated",
      claimed.version,
      { actor: "test:stale-worker" }
    );
    check("stale write is refused", stale === null, stale?.status);

    const fresh = await getEntryById(entry.id);
    check("row kept its finished state", fresh?.status === "processed", fresh?.status);
    check("version was bumped once", fresh?.version === 2, fresh?.version);
  });

  await section(
    "A send whose outcome is unknown is never repeated automatically",
    async () => {
      const entry = await newRequest();
      const validated = await toValidated(entry);

      const claim = await claimValidatedForDelivery(PAST);
      check("delivery was claimed", claim.kind === "claimed", claim.kind);
      if (claim.kind !== "claimed") return;

      check(
        "row is marked applied before any email goes out",
        claim.entry.status === "applied",
        claim.entry.status
      );
      const record = await getDelivery(claim.deliveryKey);
      check(
        "delivery intent is durable before the send",
        record?.state === "attempted",
        record?.state
      );
      check("attempt was counted", claim.entry.attempt_count === 1, claim.entry.attempt_count);

      // The send times out, or the worker is killed mid-send. Either way the
      // outcome is unknown, so the message may already be with the customer.
      await markDeliveryUnconfirmed(claim.deliveryKey, "SMTP send timed out");
      await transitionEntry(
        claim.entry.id,
        "applied",
        "escalated",
        claim.entry.version,
        { actor: "test:deliver", reason: "outcome unknown" }
      );

      // A person requeues it, or a sweeper does. The pipeline must still refuse.
      await query(
        `UPDATE entries SET status = 'validated', updated_at = NOW() WHERE id = $1`,
        [entry.id]
      );

      const retry = await claimValidatedForDelivery(PAST);
      check(
        "the retry is held for review, not sent",
        retry.kind === "unconfirmed",
        retry.kind
      );
      if (retry.kind === "unconfirmed") {
        check(
          "row ends up escalated",
          retry.entry.status === "escalated",
          retry.entry.status
        );
      }

      const after = await getDelivery(validated.metadata ? claim.deliveryKey : claim.deliveryKey);
      check("delivery key still blocked", after?.state === "attempted", after?.state);
    }
  );

  await section("A confirmed send closes the key for good", async () => {
    const shared = {
      email: "repeat-customer@example.test",
      angel: "Repeat Angel",
      graphic: "guard-test-graphic",
    };
    const first = await newRequest(shared);
    await toValidated(first);
    const claim = await claimValidatedForDelivery(PAST);
    if (claim.kind !== "claimed") throw new Error(`expected claim, got ${claim.kind}`);

    await markDeliverySent(claim.deliveryKey);
    const done = await transitionEntry(
      claim.entry.id,
      "applied",
      "processed",
      claim.entry.version,
      { actor: "test:deliver", bumpVersion: true, clearRetry: true }
    );
    check("first request completed", done?.status === "processed", done?.status);
    check("version bumped on completion", done?.version === 2, done?.version);

    // The same intent arrives again (double form submit, requeue, whatever).
    const second = await newRequest(shared);
    await toValidated(second);
    const repeat = await claimValidatedForDelivery(PAST);
    check(
      "the repeat is recognised as already delivered",
      repeat.kind === "duplicate",
      repeat.kind
    );
    if (repeat.kind === "duplicate") {
      check(
        "it is closed without sending",
        repeat.entry.status === "processed",
        repeat.entry.status
      );
      check(
        "and marked as a skipped duplicate",
        repeat.entry.metadata.skipped_duplicate === "true",
        repeat.entry.metadata
      );
    }
  });

  await section("A send proven not to have happened may retry", async () => {
    const entry = await newRequest();
    await toValidated(entry);
    const claim = await claimValidatedForDelivery(PAST);
    if (claim.kind !== "claimed") throw new Error(`expected claim, got ${claim.kind}`);

    await markDeliveryNotSent(claim.deliveryKey, "EAUTH: invalid credentials");
    await query(
      `UPDATE entries SET status = 'validated', updated_at = NOW() WHERE id = $1`,
      [entry.id]
    );

    const retry = await claimValidatedForDelivery(PAST);
    check("retry is allowed", retry.kind === "claimed", retry.kind);
    if (retry.kind === "claimed") {
      check(
        "attempts keep counting up",
        retry.entry.attempt_count === 2,
        retry.entry.attempt_count
      );
    }
  });

  await section("Failures back off, then stop for a person", async () => {
    const entry = await newRequest();
    let current = await toValidated(entry);

    const first = await recordFailure({
      entry: current,
      stage: "deliver",
      error: "connection reset",
      failureClass: "transient",
    });
    check("first failure retries", first.escalated === false, first);
    check("a retry time is set", first.entry?.next_retry_at !== null, first.entry?.next_retry_at);
    check("backoff is 1 minute", first.retryInMinutes === 1, first.retryInMinutes);

    const notDue = await requeueDueRetries(PAST);
    check("a future retry is not requeued yet", notDue === 0, notDue);

    // Pull the retry time into the past and confirm it comes back.
    await query(
      `UPDATE entries SET next_retry_at = NOW() - interval '1 minute' WHERE id = $1`,
      [entry.id]
    );
    const requeued = await requeueDueRetries(PAST);
    check("a due retry is requeued", requeued === 1, requeued);
    current = (await getEntryById(entry.id))!;
    check("back to pending", current.status === "pending", current.status);

    // Burn the remaining attempts.
    for (let i = current.attempt_count; i < MAX_ATTEMPTS; i += 1) {
      const outcome = await recordFailure({
        entry: (await getEntryById(entry.id))!,
        stage: "deliver",
        error: "connection reset",
        failureClass: "transient",
      });
      if (i === MAX_ATTEMPTS - 1) {
        check("the last attempt escalates", outcome.escalated === true, outcome);
      }
    }
    current = (await getEntryById(entry.id))!;
    check("ends escalated", current.status === "escalated", current.status);
    check(
      "no retry is scheduled after escalation",
      current.next_retry_at === null,
      current.next_retry_at
    );
    check(
      "escalation reason is recorded",
      current.metadata.escalation_reason === "retry_attempts_exhausted",
      current.metadata.escalation_reason
    );
  });

  await section("Failures that can never succeed skip the retries", async () => {
    const entry = await newRequest();
    const current = await toValidated(entry);
    const outcome = await recordFailure({
      entry: current,
      stage: "generate",
      error: "Entry has no customer email",
      failureClass: "permanent",
    });
    check("escalates on the first attempt", outcome.escalated === true, outcome);
    check(
      "reason says permanent",
      outcome.entry?.metadata.escalation_reason === "permanent_failure",
      outcome.entry?.metadata.escalation_reason
    );
  });

  await section("An unconfirmed delivery ages out to a person", async () => {
    const entry = await newRequest();
    await toValidated(entry);
    const claim = await claimValidatedForDelivery(PAST);
    if (claim.kind !== "claimed") throw new Error(`expected claim, got ${claim.kind}`);

    const notYet = await escalateStuckApplied(15);
    check("a fresh applied row is left alone", notYet === 0, notYet);

    await query(
      `UPDATE entries SET updated_at = NOW() - interval '30 minutes' WHERE id = $1`,
      [entry.id]
    );
    const swept = await escalateStuckApplied(15);
    check("an old applied row is escalated", swept >= 1, swept);
    const after = await getEntryById(entry.id);
    check("status is escalated", after?.status === "escalated", after?.status);
    check(
      "reason explains the risk",
      after?.metadata.escalation_reason === "delivery_outcome_unconfirmed",
      after?.metadata.escalation_reason
    );
  });

  await section("An admin can authorise exactly one more send", async () => {
    const entry = await newRequest();
    await toValidated(entry);
    const claim = await claimValidatedForDelivery(PAST);
    if (claim.kind !== "claimed") throw new Error(`expected claim, got ${claim.kind}`);
    await markDeliveryUnconfirmed(claim.deliveryKey, "timed out");
    await transitionEntry(
      claim.entry.id,
      "applied",
      "escalated",
      claim.entry.version,
      { actor: "test:deliver" }
    );

    const reopened = await reopenForResend(entry.id);
    check("request is back in the queue", reopened?.status === "pending", reopened?.status);
    check("attempts are reset", reopened?.attempt_count === 0, reopened?.attempt_count);
  });

  await section("Every status change is on the record", async () => {
    const entry = await newRequest();
    const validated = await toValidated(entry);
    await transitionEntry(validated.id, "validated", "processed", validated.version, {
      actor: "test:deliver",
      reason: "confirmed",
      bumpVersion: true,
    });

    const rows = await query(
      `SELECT from_status, to_status, actor, reason
       FROM entry_transitions WHERE entry_id = $1 ORDER BY at`,
      [entry.id]
    );
    const path = rows.rows.map((r) => `${r.from_status}->${r.to_status}`).join(", ");
    check(
      "the whole path is auditable",
      path === "pending->processing, processing->validated, validated->processed",
      path
    );
    check(
      "every step names who did it",
      rows.rows.every((r) => String(r.actor) !== "system"),
      rows.rows.map((r) => r.actor)
    );
    check(
      "the claim is attributed to the worker",
      rows.rows[0]?.actor === "worker:generate",
      rows.rows[0]?.actor
    );
    check(
      "reasons are recorded",
      rows.rows.some((r) => r.reason === "confirmed"),
      rows.rows.map((r) => r.reason)
    );
  });

  await section("Illegal statuses are still rejected by the database", async () => {
    const entry = await newRequest();
    let rejected = false;
    try {
      await query(`UPDATE entries SET status = 'nonsense' WHERE id = $1`, [
        entry.id,
      ]);
    } catch {
      rejected = true;
    }
    check("an unknown status cannot be written", rejected, rejected);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await closePool();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nTest run crashed:", err);
  await closePool();
  process.exit(1);
});
