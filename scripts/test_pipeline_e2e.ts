/**
 * End-to-end test of the real graphic worker process.
 *
 *   DATABASE_URL=postgresql://... npm run test:e2e
 *
 * Spawns dist/worker/run.js against a stub xAI endpoint and a stub SMTP
 * server, then checks what the worker actually did to the database and how
 * many emails really left. The stub SMTP counts message bodies, so a duplicate
 * delivery cannot pass unnoticed.
 *
 * Run `npm run build` first.
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import net from "net";
import { closePool, query } from "../src/db/pool";
import { migrate } from "../src/db/migrate";

const WORKER_PORT_XAI = 8791;
const WORKER_PORT_SMTP = 8792;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 1x1 JPEG, enough for the worker to treat as real artwork. */
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwcJC4nICIsIxwcKDcpLDA xNDQ0Hyc5PTgyPDQ0NP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAAB" +
  "BQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFB" +
  "BhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RV" +
  "VldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrC" +
  "w8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A/v4oooo" +
  "A//Z";

interface XaiStub {
  server: http.Server;
  calls: () => number;
}

async function startXaiStub(): Promise<XaiStub> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ b64_json: TINY_JPEG_B64.replace(/\s+/g, "") }],
        })
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(WORKER_PORT_XAI, "127.0.0.1", resolve)
  );
  return { server, calls: () => calls };
}

/**
 * accept      answer 250 straight away
 * hang        take the message and never answer (a relay slower than our timeout)
 * accept_slow answer 250 late, which opens the window where the message is
 *             already delivered but the worker has not been told yet
 */
type SmtpMode = "accept" | "hang" | "accept_slow";

interface SmtpMessage {
  to: string[];
  body: string;
}

interface SmtpStub {
  server: net.Server;
  messages: () => SmtpMessage[];
  /** Message bodies addressed to one recipient, ignoring alert mail. */
  messagesTo: (address: string) => SmtpMessage[];
  setMode: (mode: SmtpMode) => void;
  /** Resolves the next time a message for this address is taken in. */
  nextDeliveryTo: (address: string) => Promise<void>;
}

/**
 * Minimal SMTP sink. In "hang" mode it accepts the message body and then never
 * answers, which is exactly the shape of a relay that takes longer than
 * SMTP_TIMEOUT_MS while still delivering.
 */
async function startSmtpStub(initial: SmtpMode): Promise<SmtpStub> {
  let mode: SmtpMode = initial;
  const messages: SmtpMessage[] = [];
  const waiters = new Map<string, () => void>();

  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    let body = "";
    let recipients: string[] = [];

    socket.write("220 localhost ESMTP stub\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      if (inData) {
        body += buffer;
        buffer = "";
        const terminator = body.indexOf("\r\n.\r\n");
        if (terminator !== -1) {
          const taken = { to: recipients.slice(), body: body.slice(0, terminator) };
          messages.push(taken);
          for (const address of taken.to) {
            const waiter = waiters.get(address);
            if (waiter) {
              waiters.delete(address);
              waiter();
            }
          }
          recipients = [];
          body = "";
          inData = false;
          if (mode === "accept") {
            socket.write("250 2.0.0 Ok: queued as stub\r\n");
          } else if (mode === "accept_slow") {
            setTimeout(() => {
              try {
                socket.write("250 2.0.0 Ok: queued as stub\r\n");
              } catch {
                /* the worker may already be gone */
              }
            }, 6000);
          }
          // "hang": the body is taken in and kept, but never acknowledged.
        }
        return;
      }

      let newline = buffer.indexOf("\r\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const upper = line.toUpperCase();

        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          socket.write("250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 52428800\r\n");
        } else if (upper.startsWith("AUTH LOGIN")) {
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("AUTH PLAIN")) {
          socket.write("235 2.7.0 Authentication successful\r\n");
        } else if (upper.startsWith("MAIL FROM")) {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (upper.startsWith("RCPT TO")) {
          const match = line.match(/<([^>]*)>/);
          if (match) recipients.push(match[1].toLowerCase());
          socket.write("250 2.1.5 Ok\r\n");
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else if (upper === "RSET") {
          socket.write("250 2.0.0 Ok\r\n");
        } else {
          // Base64 credential lines during AUTH LOGIN land here.
          socket.write("235 2.7.0 Authentication successful\r\n");
        }
        newline = buffer.indexOf("\r\n");
      }
    });

    socket.on("error", () => {
      /* clients disconnect on timeout; nothing to do */
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(WORKER_PORT_SMTP, "127.0.0.1", resolve)
  );
  return {
    server,
    messages: () => messages.slice(),
    messagesTo: (address) =>
      messages.filter((m) => m.to.includes(address.toLowerCase())),
    setMode: (next) => {
      mode = next;
    },
    nextDeliveryTo: (address) =>
      new Promise<void>((resolve) =>
        waiters.set(address.toLowerCase(), resolve)
      ),
  };
}

function startWorker(): ChildProcess {
  const child = spawn("node", ["dist/worker/run.js"], {
    env: {
      ...process.env,
      XAI_API_KEY: "stub-key",
      XAI_BASE_URL: `http://127.0.0.1:${WORKER_PORT_XAI}/v1`,
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(WORKER_PORT_SMTP),
      SMTP_USER: "stub",
      SMTP_PASS: "stub",
      SMTP_FROM: "Stub <stub@example.test>",
      SMTP_TIMEOUT_MS: "5000",
      FAILURE_ALERT_EMAIL: "alerts@example.test",
      POLL_SECONDS: "2",
      WORKER_MIN_CREATED_AT: new Date(Date.now() - 3600_000).toISOString(),
      DELIVERY_REVIEW_MINUTES: "5",
      UPLOAD_DIR: "/tmp/aag-e2e-uploads",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.env.E2E_VERBOSE && console.log(`    worker | ${d}`.trimEnd()));
  child.stderr?.on("data", (d) => process.env.E2E_VERBOSE && console.log(`    worker | ${d}`.trimEnd()));
  return child;
}

async function insertRequest(angel: string, email: string): Promise<string> {
  const result = await query(
    `INSERT INTO entries (real_name, angel_name, email, graphic_code, status)
     VALUES ('E2E Customer', $1, $2, 'cover-photo', 'pending')
     RETURNING id`,
    [angel, email]
  );
  return String(result.rows[0].id);
}

async function statusOf(id: string): Promise<{ status: string; version: number; meta: Record<string, unknown> }> {
  const result = await query(
    `SELECT status, version, metadata FROM entries WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  return {
    status: String(row.status),
    version: Number(row.version),
    meta: (row.metadata as Record<string, unknown>) ?? {},
  };
}

async function waitForStatus(
  id: string,
  wanted: string[],
  timeoutMs = 40_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const { status } = await statusOf(id);
    last = status;
    if (wanted.includes(status)) return status;
    await sleep(500);
  }
  return last;
}

async function main(): Promise<void> {
  const xai = await startXaiStub();
  const smtp = await startSmtpStub("accept");

  // Works against an empty database, not just an already-migrated one.
  await migrate();

  // Start clean so claims are unambiguous.
  await query(
    `UPDATE entries SET archived_at = NOW() WHERE archived_at IS NULL AND status <> 'processed'`
  );
  await query(`DELETE FROM graphic_deliveries`);

  let worker = startWorker();
  await sleep(3000);

  try {
    console.log("\nThe happy path delivers exactly one email");
    const happyId = await insertRequest("E2E Delivered", "happy@example.test");
    const happyStatus = await waitForStatus(happyId, ["processed", "failed", "escalated"]);
    check("request reaches processed", happyStatus === "processed", happyStatus);

    const happy = await statusOf(happyId);
    check("version was bumped once", happy.version === 2, happy.version);
    check("marked as sent", happy.meta.photo_sent === "true", happy.meta.photo_sent);
    const happyMail = smtp.messagesTo("happy@example.test");
    check("exactly one email reached the customer", happyMail.length === 1, happyMail.length);
    check(
      "the email carries the angel name",
      (happyMail[0]?.body || "").includes("E2E Delivered"),
      (happyMail[0]?.body || "").slice(0, 120)
    );
    check("xAI was called once", xai.calls() === 1, xai.calls());

    const delivery = await query(
      `SELECT state FROM graphic_deliveries WHERE entry_id = $1`,
      [happyId]
    );
    check(
      "delivery key is closed as sent",
      delivery.rows[0]?.state === "sent",
      delivery.rows[0]?.state
    );

    console.log("\nA send the mail server never confirms is not repeated");
    smtp.setMode("hang");
    const xaiBefore = xai.calls();

    const hangId = await insertRequest("E2E Unconfirmed", "hang@example.test");
    const hangStatus = await waitForStatus(hangId, ["escalated", "processed"], 60_000);
    check("request stops as escalated", hangStatus === "escalated", hangStatus);

    const hang = await statusOf(hangId);
    check(
      "the reason is recorded as unconfirmed",
      hang.meta.escalation_reason === "delivery_outcome_unconfirmed",
      hang.meta.escalation_reason
    );
    check("version was not bumped", hang.version === 1, hang.version);
    check(
      "the customer body reached the mail server once",
      smtp.messagesTo("hang@example.test").length === 1,
      smtp.messagesTo("hang@example.test").length
    );

    const hangDelivery = await query(
      `SELECT state, attempt_count FROM graphic_deliveries WHERE entry_id = $1`,
      [hangId]
    );
    check(
      "delivery key stays blocked",
      hangDelivery.rows[0]?.state === "attempted",
      hangDelivery.rows[0]?.state
    );

    // Let the worker poll many more times. Nothing may be sent again.
    console.log("\n  (letting the worker keep polling for 15s)");
    await sleep(15_000);

    check(
      "no second customer email after repeated polls",
      smtp.messagesTo("hang@example.test").length === 1,
      smtp.messagesTo("hang@example.test").length
    );
    const alerts = smtp.messagesTo("alerts@example.test");
    check("Audrey was alerted", alerts.length >= 1, alerts.length);
    // Subjects arrive MIME-encoded, so match on the plain-text body instead.
    check(
      "the alert names the request",
      alerts.some((m) => m.body.includes(hangId)),
      alerts.map((m) => m.body.slice(0, 80))
    );
    check(
      "the alert says automation has stopped",
      alerts.some((m) => m.body.includes("Automation has stopped")),
      alerts.map((m) => m.body.slice(-200))
    );
    check(
      "no second xAI call after repeated polls",
      xai.calls() === xaiBefore + 1,
      xai.calls() - xaiBefore
    );
    const stillEscalated = await statusOf(hangId);
    check(
      "the request stays escalated",
      stillEscalated.status === "escalated",
      stillEscalated.status
    );

    console.log("\nA requeue of that request still refuses to send");
    smtp.setMode("accept");
    await query(
      `UPDATE entries SET status = 'validated', updated_at = NOW() WHERE id = $1`,
      [hangId]
    );
    await sleep(8000);
    const afterRequeue = await statusOf(hangId);
    check(
      "it is held for review again",
      afterRequeue.status === "escalated",
      afterRequeue.status
    );
    check(
      "the customer still has only one copy",
      smtp.messagesTo("hang@example.test").length === 1,
      smtp.messagesTo("hang@example.test").length
    );

    console.log("\nA repeat of an already-delivered request costs nothing");
    const xaiBeforeRepeat = xai.calls();
    await insertRequest("E2E Delivered", "happy@example.test");
    await sleep(8000);
    check(
      "the customer still has only one copy",
      smtp.messagesTo("happy@example.test").length === 1,
      smtp.messagesTo("happy@example.test").length
    );
    check(
      "no new xAI call for the repeat",
      xai.calls() === xaiBeforeRepeat,
      xai.calls() - xaiBeforeRepeat
    );

    check("the worker is still running", worker.exitCode === null, worker.exitCode);

    // The original bug: the email is delivered, then the worker dies before it
    // can write that down, and the stuck-job sweeper sends the whole thing
    // again. On the pre-split pipeline this produced two copies.
    console.log("\nA worker killed after delivery does not send a second copy");
    smtp.setMode("accept_slow");
    const killId = await insertRequest("E2E Killed Worker", "killed@example.test");
    const arrived = smtp.nextDeliveryTo("killed@example.test");
    await Promise.race([arrived, sleep(45_000)]);
    await sleep(300);
    worker.kill("SIGKILL");
    await sleep(500);

    const midKill = await statusOf(killId);
    check(
      "the customer has one copy and the row says a send was attempted",
      smtp.messagesTo("killed@example.test").length === 1 &&
        midKill.status === "applied",
      { copies: smtp.messagesTo("killed@example.test").length, status: midKill.status }
    );

    // Age the abandoned row so the sweeper picks it up, then bring the worker back.
    smtp.setMode("accept");
    await query(
      `UPDATE entries SET updated_at = NOW() - interval '30 minutes' WHERE id = $1`,
      [killId]
    );
    worker = startWorker();
    await sleep(20_000);

    const afterKill = await statusOf(killId);
    check(
      "the customer still has exactly one copy",
      smtp.messagesTo("killed@example.test").length === 1,
      smtp.messagesTo("killed@example.test").length
    );
    check(
      "the abandoned request is escalated, not resent",
      afterKill.status === "escalated",
      afterKill.status
    );
    check(
      "the reason points at the unconfirmed delivery",
      afterKill.meta.escalation_reason === "delivery_outcome_unconfirmed",
      afterKill.meta.escalation_reason
    );
  } finally {
    worker.kill("SIGKILL");
    xai.server.close();
    smtp.server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await closePool();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nTest run crashed:", err);
  await closePool();
  process.exit(1);
});
