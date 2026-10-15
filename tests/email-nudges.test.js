import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { createQuoteModule } from "../src/quotes.js";
import { startNudgeWorker } from "../src/worker.js";

const DAY = 86400000;
const ORIGIN = "https://quotes.example.test";

// Exercise Express's real JSON middleware without opening a network port.
function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
    const req = new IncomingMessage(socket);
    const input = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req.complete = true; req.method = method; req.url = path;
    req.headers = { host: "quotes.example.test", ...(input ? { "content-type": "application/json", "content-length": String(input.length) } : {}) };
    req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new ServerResponse(req); res.assignSocket(socket);
    const chunks = []; const write = res.write.bind(res); const end = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Request timed out: ${method} ${path}`)); }, 3000);
    res.on("error", reject);
    res.on("finish", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString();
      let data; try { data = JSON.parse(raw); } catch { data = raw; }
      resolve({ status: res.statusCode, data, raw }); socket.destroy();
    });
    app(req, res); if (input) req.push(input); req.push(null);
  });
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "trades-email-nudges-"));
  const dbPath = join(directory, "suite.sqlite");
  const db = openDatabase(dbPath); const databases = [db];
  const env = new Map();
  let current = new Date("2026-10-01T12:00:00.000Z");
  let mailReady = true;
  const now = () => new Date(current);
  const sms = []; const emails = [];
  for (const key of ["MAILA", "MAILB"]) {
    for (const [name, value] of Object.entries({ ACCOUNT_SID: `AC${(key === "MAILA" ? "a" : "b").repeat(32)}`, AUTH_TOKEN: `synthetic-${key}-token`, PHONE_NUMBER: key === "MAILA" ? "+14165550101" : "+14165550102" })) {
      const envKey = `BUSINESS_${key}_${name}`; env.set(envKey, process.env[envKey]); process.env[envKey] = value;
    }
    db.prepare("INSERT INTO businesses (id,name,phone,booking_url,sms_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(key, `${key} Plumbing`, "+14165550999", "https://example.test/book", key, now().toISOString(), now().toISOString());
    db.prepare("INSERT INTO contacts (id,business_id,name,phone,email,sms_consent,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)")
      .run(`${key}-customer`, key, `${key} Customer`, "+14165550300", "customer@example.test", now().toISOString(), now().toISOString());
  }
  const config = {
    db, smsMode: options.smsMode || "twilio", now, publicOrigin: ORIGIN, emailReady: () => mailReady,
    sendSms: async (message) => { sms.push(message); return options.sendSms ? options.sendSms(message, sms.length) : { sid: `SM${sms.length}` }; },
    sendEmail: async (message) => { emails.push(message); return options.sendEmail ? options.sendEmail(message, emails.length) : { messageId: `mail-${emails.length}` }; },
  };
  const module = createQuoteModule(config);
  const app = express(); app.use(express.json());
  app.use("/api/businesses/:businessId/quotes", module.adminRouter);
  app.use("/q", module.publicRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const req = (method, path, body) => request(app, method, path, body);
  const base = (business = "MAILA") => `/api/businesses/${business}/quotes`;
  const path = (q) => `${base(q.business_id)}/${q.id}`;
  const create = async (changes = {}, business = "MAILA") => {
    const response = await req("POST", base(business), {
      contact_id: `${business}-customer`, line_items: [{ description: "Repair tap", quantity: 1, unit_price: 150 }],
      tax_rate: 13, expiry_date: "2026-11-30", notes: "Includes cleanup.", ...changes,
    });
    assert.equal(response.status, 201, response.raw); return response.data;
  };
  const send = async (q, channels = ["email"]) => {
    const response = await req("POST", `${path(q)}/send`, { channels });
    assert.equal(response.status, 200, response.raw); return response.data;
  };
  const rows = (q, channel) => db.prepare(`SELECT * FROM quote_deliveries WHERE business_id=? AND quote_id=? ${channel ? "AND channel=?" : ""} ORDER BY rowid`)
    .all(q.business_id, q.id, ...(channel ? [channel] : []));
  t.after(() => {
    for (const connection of databases) connection.close();
    for (const [key, value] of env) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...module, db, config, req, base, path, create, send, rows, sms, emails, now,
    advance(ms) { current = new Date(current.getTime() + ms); },
    emailReady(value) { mailReady = value; },
    otherWorker() { const connection = openDatabase(dbPath); databases.push(connection); return createQuoteModule({ ...config, db: connection }); },
    respond(q, decision) { return req("POST", `${new URL(q.public_url).pathname}/respond`, { decision }); },
  };
}

test("email-only quotes receive each 48-hour and 120-hour reminder exactly once, with an unsubscribe footer", async (t) => {
  const f = fixture(t); f.db.prepare("UPDATE contacts SET sms_consent=0 WHERE business_id='MAILA'").run();
  const q = await f.send(await f.create());
  await f.req("GET", `${new URL(q.public_url).pathname}/data`);
  f.advance(2 * DAY - 1); await f.runQuoteNudges(); assert.equal(f.emails.length, 1);
  f.advance(1); assert.equal((await f.runQuoteNudges()).sent, 1);
  await f.runQuoteNudges(); assert.equal(f.emails.length, 2);
  f.advance(3 * DAY - 1); await f.runQuoteNudges(); assert.equal(f.emails.length, 2);
  f.advance(1); assert.equal((await f.runQuoteNudges()).sent, 1);
  f.advance(10 * DAY); await f.runQuoteNudges(); await f.otherWorker().runQuoteNudges();
  assert.equal(f.emails.length, 3); assert.equal(f.sms.length, 0);
  assert.deepEqual(f.rows(q).map((d) => [d.channel, d.kind, d.status]), [["email", "initial", "sent"], ["email", "nudge_2", "sent"], ["email", "nudge_5", "sent"]]);
  for (const message of f.emails.slice(1)) {
    assert.ok(message.text.includes(q.public_url));
    assert.match(message.unsubscribeUrl, /^https:\/\/quotes\.example\.test\/q\/unsubscribe\/[a-f0-9]{64}$/);
    assert.ok(message.text.includes(message.unsubscribeUrl)); assert.match(message.text, /stop quote emails and texts/i);
    assert.equal(message.to, "customer@example.test"); assert.equal(message.business.sms_key, "MAILA");
  }
  assert.notEqual(f.emails[1].text, f.emails[0].text, "a reminder should read as a follow-up");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity WHERE quote_id=? AND kind='email_sent'").get(q.id).n, 3);
});

test("quotes sent on both channels receive one reminder per channel at both scheduled ages", async (t) => {
  const f = fixture(t); const q = await f.send(await f.create(), ["sms", "email"]);
  f.advance(2 * DAY); assert.equal((await f.runQuoteNudges()).sent, 2); await f.runQuoteNudges();
  assert.equal(f.sms.length, 2); assert.equal(f.emails.length, 2);
  f.advance(3 * DAY); assert.equal((await f.runQuoteNudges()).sent, 2); await f.runQuoteNudges();
  assert.equal(f.sms.length, 3); assert.equal(f.emails.length, 3);
  assert.deepEqual(f.rows(q, "sms").map((d) => d.kind), ["initial", "nudge_2", "nudge_5"]);
  assert.deepEqual(f.rows(q, "email").map((d) => d.kind), ["initial", "nudge_2", "nudge_5"]);
  assert.ok(f.sms.every((message) => message.body.endsWith("MAILA Plumbing\nReply STOP to opt out")));
});

test("SMS-only quotes keep their existing schedule and never acquire email reminder deliveries", async (t) => {
  const f = fixture(t); const q = await f.send(await f.create(), ["sms"]);
  f.advance(2 * DAY); await f.runQuoteNudges(); f.advance(3 * DAY); await f.runQuoteNudges();
  assert.equal(f.sms.length, 3); assert.equal(f.emails.length, 0);
  assert.equal(f.rows(q, "email").length, 0);
});

test("email reminders stop on a response, expiry, either opt-out, phone STOP, or owner cancellation", async (t) => {
  for (const condition of ["accepted", "declined", "expired", "opted_out", "quote_email_opted_out", "phone_stop", "cancelled"]) {
    await t.test(condition, async (t) => {
      const f = fixture(t); const q = await f.send(await f.create(condition === "expired" ? { expiry_date: "2026-10-02" } : {}), ["sms", "email"]);
      if (["accepted", "declined"].includes(condition)) assert.equal((await f.respond(q, condition)).status, 200);
      if (["opted_out", "quote_email_opted_out"].includes(condition)) f.db.prepare(`UPDATE contacts SET ${condition}=1 WHERE business_id='MAILA'`).run();
      if (condition === "phone_stop") f.db.prepare("INSERT INTO phone_opt_outs (business_id,phone,created_at) VALUES ('MAILA','+14165550300',?)").run(f.now().toISOString());
      if (condition === "cancelled") assert.equal((await f.req("POST", `${f.path(q)}/cancel-follow-ups`, {})).status, 200);
      f.advance(2 * DAY); await f.runQuoteNudges(); f.advance(3 * DAY); await f.runQuoteNudges();
      assert.equal(f.emails.length, 1); assert.equal(f.sms.length, 1);
      assert.equal(f.rows(q).filter((d) => d.kind !== "initial" && ["sending", "sent", "simulated"].includes(d.status)).length, 0);
    });
  }
});

test("stopping a sequence after the first email reminder prevents the day-five reminder", async (t) => {
  for (const condition of ["accepted", "declined", "opted_out", "cancelled"]) {
    await t.test(condition, async (t) => {
      const f = fixture(t); const q = await f.send(await f.create());
      f.advance(2 * DAY); await f.runQuoteNudges(); assert.equal(f.emails.length, 2);
      if (["accepted", "declined"].includes(condition)) assert.equal((await f.respond(q, condition)).status, 200);
      if (condition === "opted_out") f.db.prepare("UPDATE contacts SET quote_email_opted_out=1 WHERE business_id='MAILA'").run();
      if (condition === "cancelled") await f.req("POST", `${f.path(q)}/cancel-follow-ups`, {});
      f.advance(3 * DAY); await f.runQuoteNudges(); assert.equal(f.emails.length, 2);
    });
  }
});

test("invalid or changed email addresses stop only email follow-ups and never redirect a quote", async (t) => {
  for (const email of ["not-an-address", "replacement@example.test", ""]) {
    await t.test(email || "removed address", async (t) => {
      const f = fixture(t); const q = await f.send(await f.create(), ["sms", "email"]);
      f.db.prepare("UPDATE contacts SET email=? WHERE business_id='MAILA'").run(email);
      f.advance(2 * DAY); await f.runQuoteNudges(); f.advance(3 * DAY); await f.runQuoteNudges();
      assert.equal(f.emails.length, 1); assert.equal(f.sms.length, 3);
      assert.equal(f.rows(q, "email").filter((d) => ["sending", "sent"].includes(d.status) && d.kind !== "initial").length, 0);
    });
  }
});

test("revoked text permission or a changed phone does not cancel an eligible email follow-up sequence", async (t) => {
  for (const condition of ["permission", "phone"]) {
    await t.test(condition, async (t) => {
      const f = fixture(t); await f.send(await f.create(), ["sms", "email"]);
      if (condition === "permission") f.db.prepare("UPDATE contacts SET sms_consent=0 WHERE business_id='MAILA'").run();
      else f.db.prepare("UPDATE contacts SET phone='+14165550888' WHERE business_id='MAILA'").run();
      f.advance(2 * DAY); await f.runQuoteNudges(); f.advance(3 * DAY); await f.runQuoteNudges();
      assert.equal(f.sms.length, 1); assert.equal(f.emails.length, 3);
    });
  }
});

test("changing only an email address's letter case keeps its original recipient eligible", async (t) => {
  const f = fixture(t); await f.send(await f.create());
  f.db.prepare("UPDATE contacts SET email='CUSTOMER@EXAMPLE.TEST' WHERE business_id='MAILA'").run();
  f.advance(2 * DAY); await f.runQuoteNudges(); f.advance(3 * DAY); await f.runQuoteNudges();
  assert.equal(f.emails.length, 3);
  assert.ok(f.emails.every((message) => message.to === "customer@example.test"), "reminders retain the confirmed initial recipient");
});

test("a permanent email recipient rejection consumes its slot and suppresses later email nudges without stopping SMS", async (t) => {
  for (const failure of [{ code: "EEMAILREJECTED" }, { code: "EENVELOPE", responseCode: 550, command: "RCPT TO" }]) {
    await t.test(failure.code, async (t) => {
      const f = fixture(t, { sendEmail(message, count) { if (count > 1) throw { ...failure, message: "private SMTP recipient detail" }; return { messageId: "initial-mail" }; } });
      const q = await f.send(await f.create(), ["sms", "email"]);
      f.advance(2 * DAY); await f.runQuoteNudges(); await f.runQuoteNudges();
      assert.equal(f.emails.length, 2);
      f.advance(3 * DAY); await f.runQuoteNudges(); await f.runQuoteNudges();
      assert.equal(f.emails.length, 2); assert.equal(f.sms.length, 3);
      const failed = f.rows(q, "email").find((d) => d.kind === "nudge_2");
      assert.equal(failed.status, "failed"); assert.ok(!failed.error.includes("private SMTP"));
      assert.ok(!f.rows(q, "email").some((d) => d.kind === "nudge_5" && ["sent", "sending"].includes(d.status)));
    });
  }
});

test("an SMTP authentication failure consumes day two but does not misclassify the contact as bounced", async (t) => {
  const f = fixture(t, { sendEmail(message, count) { if (count === 2) throw { code: "EAUTH", responseCode: 535, message: "secret credentials" }; return { messageId: `mail-${count}` }; } });
  const q = await f.send(await f.create());
  f.advance(2 * DAY); assert.equal((await f.runQuoteNudges()).failed, 1); await f.runQuoteNudges();
  assert.equal(f.emails.length, 2);
  f.advance(3 * DAY); await f.runQuoteNudges(); await f.runQuoteNudges();
  assert.equal(f.emails.length, 3);
  assert.deepEqual(f.rows(q, "email").map((d) => [d.kind, d.status]), [["initial", "sent"], ["nudge_2", "failed"], ["nudge_5", "sent"]]);
});

test("failed or unconfirmed initial email attempts never qualify a quote for email follow-ups", async (t) => {
  for (const failure of [{ code: "EAUTH" }, new Error("ambiguous network error")]) {
    await t.test(failure.code || "unconfirmed", async (t) => {
      const f = fixture(t, { sendEmail() { throw failure; } });
      const q = await f.send(await f.create(), ["sms", "email"]);
      assert.equal(q.status, "sent");
      f.advance(2 * DAY); await f.runQuoteNudges(); f.advance(3 * DAY); await f.runQuoteNudges();
      assert.equal(f.emails.length, 1); assert.equal(f.sms.length, 3);
      assert.equal(f.rows(q, "email").length, 1);
    });
  }
});

test("missing email configuration pauses only that channel and a later check can reserve its current slot", async (t) => {
  const f = fixture(t); const q = await f.send(await f.create(), ["sms", "email"]);
  f.emailReady(false); f.advance(2 * DAY); await f.runQuoteNudges();
  assert.equal(f.emails.length, 1); assert.equal(f.sms.length, 2);
  assert.equal(f.rows(q, "email").length, 1, "no reservation is consumed before email configuration is ready");
  f.emailReady(true); f.advance(DAY); await f.runQuoteNudges(); await f.runQuoteNudges();
  assert.equal(f.emails.length, 2); assert.equal(f.sms.length, 2);
  f.advance(2 * DAY); await f.runQuoteNudges();
  assert.equal(f.emails.length, 3); assert.equal(f.sms.length, 3);
});

test("a restarted worker catches up after day five once per initial channel and durably skips stale day-two slots", async (t) => {
  const f = fixture(t); const q = await f.send(await f.create(), ["sms", "email"]);
  f.advance(6 * DAY);
  const restarted = f.otherWorker();
  const worker = startNudgeWorker({ runNudges: restarted.runQuoteNudges, intervalMs: 60000 });
  await worker.firstCheck; await worker.stop();
  await f.runQuoteNudges();
  assert.equal(f.emails.length, 2); assert.equal(f.sms.length, 2);
  for (const channel of ["sms", "email"]) assert.deepEqual(f.rows(q, channel).map((d) => [d.kind, d.status]), [["initial", "sent"], ["nudge_2", "skipped"], ["nudge_5", "sent"]]);
});

test("workers with separate SQLite connections reserve each email reminder before contacting its provider", { timeout: 10000 }, async (t) => {
  let release; let announce;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { announce = resolve; });
  const f = fixture(t, { async sendEmail(message, count) { if (count === 2) { announce(); await gate; } return { messageId: `mail-${count}` }; } });
  const q = await f.send(await f.create()); const second = f.otherWorker(); f.advance(2 * DAY);
  const pending = f.runQuoteNudges();
  await started;
  try { await second.runQuoteNudges(); assert.equal(f.emails.length, 2); }
  finally { release(); }
  await pending; await second.runQuoteNudges();
  assert.equal(f.rows(q, "email").filter((d) => d.kind === "nudge_2").length, 1);
  assert.equal(f.emails.length, 2);
});

test("an opt-out during a combined follow-up prevents the remaining email provider call", { timeout: 10000 }, async (t) => {
  let release; let announce;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { announce = resolve; });
  const f = fixture(t, { async sendSms(message, count) { if (count === 2) { announce(); await gate; } return { sid: `SM${count}` }; } });
  await f.send(await f.create(), ["sms", "email"]); f.advance(2 * DAY);
  const pending = f.runQuoteNudges(); await started;
  try { f.db.prepare("UPDATE contacts SET quote_email_opted_out=1 WHERE business_id='MAILA'").run(); }
  finally { release(); }
  await pending;
  assert.equal(f.sms.length, 2); assert.equal(f.emails.length, 1);
  f.advance(3 * DAY); await f.runQuoteNudges(); assert.equal(f.emails.length, 1);
});

test("email nudge delivery and cancellation stay scoped to the original business and contact", async (t) => {
  const f = fixture(t); const alpha = await f.send(await f.create()); const beta = await f.send(await f.create({}, "MAILB"));
  f.db.prepare("UPDATE contacts SET quote_email_opted_out=1 WHERE business_id='MAILA'").run();
  f.advance(2 * DAY); await f.runQuoteNudges("MAILA"); assert.equal(f.emails.length, 2);
  await f.runQuoteNudges("MAILB"); assert.equal(f.emails.length, 3);
  f.advance(3 * DAY); await f.runQuoteNudges();
  assert.equal(f.emails.length, 4); assert.equal(f.emails.at(-1).business.id, "MAILB");
  assert.equal(f.rows(alpha, "email").filter((d) => d.kind !== "initial" && d.status === "sent").length, 0);
  assert.equal(f.rows(beta, "email").filter((d) => d.kind !== "initial" && d.status === "sent").length, 2);
});

test("demo mode records email reminders as simulated and a live worker cannot pick them up", async (t) => {
  const f = fixture(t, { smsMode: "demo" }); const q = await f.send(await f.create(), ["email"]);
  f.advance(2 * DAY); await createQuoteModule({ ...f.config, smsMode: "twilio" }).runQuoteNudges();
  assert.equal(f.rows(q).length, 1);
  await f.runQuoteNudges(); f.advance(3 * DAY); await f.runQuoteNudges(); await f.runQuoteNudges();
  assert.equal(f.emails.length, 0); assert.equal(f.sms.length, 0);
  assert.deepEqual(f.rows(q).map((d) => [d.channel, d.kind, d.status]), [["email", "initial", "simulated"], ["email", "nudge_2", "simulated"], ["email", "nudge_5", "simulated"]]);
});
