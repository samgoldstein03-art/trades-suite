import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { startNudgeWorker } from "../src/worker.js";

test("startup catches up an overdue request from disk once after downtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "trades-worker-test-"));
  const settings = {
    BUSINESS_BOOT_ACCOUNT_SID: `AC${"b".repeat(32)}`,
    BUSINESS_BOOT_AUTH_TOKEN: "synthetic-worker-test-token",
    BUSINESS_BOOT_PHONE_NUMBER: "+14165550101",
  };
  const original = Object.fromEntries(
    Object.keys(settings).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, settings);
  let suite;
  let worker;
  t.after(async () => {
    await worker?.stop();
    suite?.close();
    for (const [key, value] of Object.entries(original))
      value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });

  let currentTime = new Date("2026-10-01T12:00:00.000Z");
  const sentAt = currentTime.toISOString();
  const dueAt = "2026-10-04T12:00:00.000Z";
  const deliveries = [];
  const open = () => createApp({
    dbPath: join(directory, "suite.sqlite"),
    uploadDir: join(directory, "uploads"),
    smsMode: "twilio",
    now: () => new Date(currentTime),
    sendSms: async (message) => {
      deliveries.push(message);
      return { sid: `SM${"b".repeat(32)}` };
    },
  });
  suite = open();
  suite.db.prepare(`INSERT INTO businesses
    (id,name,phone,google_review_url,sms_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    "business", "Boot Heating", "+14165550100", "https://example.test/review",
    "BOOT", sentAt, sentAt,
  );
  suite.db.prepare(`INSERT INTO contacts
    (id,business_id,name,phone,sms_consent,consent_at,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?,?)`).run(
    "customer", "business", "Sam Customer", "+14165550200", sentAt, sentAt, sentAt,
  );
  suite.db.prepare(`INSERT INTO review_requests
    (id,business_id,contact_id,status,mode,sent_at,nudge_due_at)
    VALUES (?,?,?,'sent','twilio',?,?)`).run(
    "request", "business", "customer", sentAt, dueAt,
  );
  suite.db.prepare(`INSERT INTO sms_messages
    (id,business_id,contact_id,request_id,kind,mode,body,to_phone,delivery_status,created_at,updated_at)
    VALUES (?,?,?,?,'initial','twilio',?,?,'sent',?,?)`).run(
    "initial", "business", "customer", "request", "Synthetic initial SMS",
    "+14165550200", sentAt, sentAt,
  );

  worker = startNudgeWorker({ runNudges: suite.runNudges });
  await worker.firstCheck;
  assert.equal(deliveries.length, 0, "the first boot does not send before 72 hours");
  await worker.stop();
  suite.close();
  suite = null;

  // The process is gone while the saved request crosses its due time.
  currentTime = new Date("2026-10-05T12:00:00.000Z");
  suite = open();
  assert.equal(suite.db.prepare("SELECT status FROM review_requests").get().status, "sent");
  worker = startNudgeWorker({ runNudges: suite.runNudges });
  await worker.firstCheck; // No interval tick or HTTP request is needed to catch up.
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].kind, "nudge");
  assert.equal(deliveries[0].to, "+14165550200");
  assert.match(deliveries[0].body, /Boot Heating\nReply STOP to opt out$/);
  const completed = suite.db.prepare("SELECT * FROM review_requests").get();
  assert.equal(completed.status, "nudged");
  assert.equal(completed.nudged_at, currentTime.toISOString());
  assert.equal(suite.db.prepare("SELECT count(*) AS count FROM sms_messages WHERE kind='nudge'").get().count, 1);
  assert.equal(suite.db.prepare("SELECT count(*) AS count FROM activity WHERE kind='sms_sent'").get().count, 1);
  await worker.tick();
  await worker.stop();
  suite.close();
  suite = null;

  suite = open();
  worker = startNudgeWorker({ runNudges: suite.runNudges });
  await worker.firstCheck;
  assert.equal(deliveries.length, 1, "later checks and another boot do not duplicate the nudge");
});

test("worker skips overlapping ticks and shutdown waits for the active check", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finish;
  let checks = 0;
  const worker = startNudgeWorker({
    intervalMs: 1000,
    runNudges: () => {
      checks++;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  await Promise.resolve();
  assert.equal(checks, 1);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(checks, 1, "timer checks never overlap a pending provider call");
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, "shutdown must wait before the database closes");
  finish();
  await stopping;
  t.mock.timers.tick(5000);
  await worker.tick();
  assert.equal(checks, 1, "no new check begins after shutdown");
});

test("worker recovers from a check error on the next interval without logging secrets", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const logged = [];
  t.mock.method(console, "error", (...values) => logged.push(values.join(" ")));
  let checks = 0;
  const worker = startNudgeWorker({
    intervalMs: 1000,
    runNudges: async () => {
      if (++checks === 1) throw new Error("synthetic-sensitive-upstream-detail");
    },
  });
  t.after(() => worker.stop());
  await worker.firstCheck;
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0], /synthetic-sensitive/);
  t.mock.timers.tick(1000);
  await worker.tick();
  assert.equal(checks, 2, "a failed check does not kill the interval worker");
});
