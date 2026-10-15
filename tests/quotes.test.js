import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { openDatabase } from "../src/db.js";
import { createQuoteModule } from "../src/quotes.js";
import { startNudgeWorker } from "../src/worker.js";

const DAY = 86400000;
const ORIGIN = "https://quotes.example.test";
// Real Express middleware with in-memory HTTP streams: no network/provider.
function request(app, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error(`Request timed out: ${method} ${url}`)); }, 3000);
    const req = new IncomingMessage(socket);
    const input = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req.method = method; req.url = url;
    req.complete = true;
    req.headers = { host: "quotes.example.test", ...(input ? { "content-type": "application/json", "content-length": String(input.length) } : {}), ...headers };
    req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    const chunks = [];
    const write = res.write.bind(res); const end = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
    res.on("error", reject);
    res.on("finish", () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString();
      let data; try { data = JSON.parse(raw); } catch { data = raw; }
      resolve({ status: res.statusCode, headers: res.getHeaders(), data, raw }); socket.destroy();
    });
    app(req, res);
    if (input) req.push(input);
    req.push(null);
  });
}
function fixture(t, options = {}) {
  const db = openDatabase(":memory:");
  let current = new Date("2026-10-01T12:00:00.000Z");
  const now = () => new Date(current);
  const sms = []; const email = [];
  const env = {};
  for (const key of ["ALPHA", "BETA"]) {
    for (const [name, value] of Object.entries({ ACCOUNT_SID: `AC${(key === "ALPHA" ? "1" : "2").repeat(32)}`, AUTH_TOKEN: `synthetic-${key}-token`, PHONE_NUMBER: key === "ALPHA" ? "+14165550101" : "+14165550102" })) {
      const envKey = `BUSINESS_${key}_${name}`; env[envKey] = process.env[envKey]; process.env[envKey] = value;
    }
    db.prepare("INSERT INTO businesses (id,name,phone,booking_url,sms_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(key, `${key} Plumbing`, "+14165550999", "https://example.test/book", key, now().toISOString(), now().toISOString());
    db.prepare("INSERT INTO contacts (id,business_id,name,phone,email,notes,sms_consent,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)").run(`${key}-customer`, key, `${key} Customer`, "+14165550300", `${key.toLowerCase()}@example.test`, "Private customer note", now().toISOString(), now().toISOString());
  }
  const config = { db, smsMode: options.smsMode || "twilio", now, publicOrigin: ORIGIN, emailReady: () => true, sendSms: async (message) => { sms.push(message); return options.sendSms ? options.sendSms(message, sms.length) : { sid: `SM${sms.length}` }; }, sendEmail: async (message) => { email.push(message); return options.sendEmail ? options.sendEmail(message, email.length) : { messageId: `mail-${email.length}` }; } };
  const module = createQuoteModule(config);
  const app = express(); app.use(express.json());
  app.use("/api/businesses/:businessId/quotes", module.adminRouter);
  app.use("/q", module.publicRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const req = (method, url, body, headers) => request(app, method, url, body, headers);
  const base = (business = "ALPHA") => `/api/businesses/${business}/quotes`;
  const create = async (overrides = {}, business = "ALPHA") => {
    const result = await req("POST", base(business), { contact_id: `${business}-customer`, line_items: [{ description: "Repair tap", quantity: 2, unit_price: 19.99 }], tax_rate: 13, expiry_date: "2026-11-30", notes: "Includes cleanup.", ...overrides });
    assert.equal(result.status, 201, result.raw); return result.data;
  };
  const send = (q, channels = ["sms"]) => req("POST", `${base(q.business_id)}/${q.id}/send`, { channels });
  const publicPath = (q) => new URL(q.public_url).pathname;
  t.after(() => { db.close(); for (const [key, value] of Object.entries(env)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  return { ...module, config, db, req, base, create, send, publicPath, sms, email, now, advance(ms) { current = new Date(current.getTime() + ms); }, at(value) { current = new Date(value); } };
}

test("quotes use existing customers and composite business isolation with exact cent totals", async (t) => {
  const f = fixture(t); const q = await f.create();
  assert.equal(q.subtotal_cents, 3998); assert.equal(q.tax_cents, 520); assert.equal(q.total_cents, 4518);
  assert.equal(q.status, "draft"); assert.equal(q.line_items[0].line_total_cents, 3998);
  assert.equal((await f.req("GET", `${f.base("BETA")}/${q.id}`)).status, 404);
  assert.deepEqual((await f.req("GET", f.base("BETA"))).data, []);
  assert.equal((await f.req("POST", f.base("BETA"), { ...q, contact_id: "ALPHA-customer" })).status, 404);
  assert.throws(() => f.db.prepare("UPDATE quotes SET contact_id='BETA-customer' WHERE id=?").run(q.id), /FOREIGN KEY/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE business_id='BETA'").get().n, 0);
  assert.equal(f.db.prepare("PRAGMA user_version").get().user_version, 3);
});

test("quote validation rejects unsafe money, malformed dates and customer records", async (t) => {
  const f = fixture(t); const q = await f.create({ line_items: [{ description: "Quarter hour", quantity: 0.125, unit_price: 9.99 }], tax_rate: 0 });
  assert.equal(q.total_cents, 125);
  const valid = { contact_id: "ALPHA-customer", line_items: [{ description: "Work", quantity: 1, unit_price: 1 }], expiry_date: "2026-11-30", tax_rate: 13 };
  for (const override of [ { line_items: [] }, { line_items: [{ description: "Work", quantity: 0, unit_price: 1 }] }, { line_items: [{ description: "Work", quantity: 1, unit_price: 1.005 }] }, { line_items: [{ description: "Work", quantity: 100000, unit_price: 1000000 }] }, { tax_rate: -1 }, { tax_rate: 101 }, { expiry_date: "2026-02-30" }, { expiry_date: "2026-09-30" }, { currency: "ZZZ" } ]) {
    assert.equal((await f.req("POST", f.base(), { ...valid, ...override })).status, 400, JSON.stringify(override));
  }
});

test("quote workflow sends scoped SMS, exposes a private-free snapshot and logs view and acceptance", async (t) => {
  const f = fixture(t); const draft = await f.create();
  const token = f.db.prepare("SELECT public_token FROM quotes WHERE id=?").get(draft.id).public_token;
  assert.equal(token.length, 64);
  assert.equal((await f.req("GET", `/q/${token}/data`)).status, 404);
  const sent = (await f.send(draft)).data;
  assert.equal(sent.status, "sent"); assert.equal(f.sms.length, 1);
  assert.equal(f.sms[0].authToken, "synthetic-ALPHA-token");
  assert.equal(f.sms[0].from, "+14165550101");
  assert.ok(f.sms[0].body.includes(sent.public_url));
  assert.ok(f.sms[0].body.endsWith("ALPHA Plumbing\nReply STOP to opt out"));
  f.db.prepare("UPDATE businesses SET name='Changed business' WHERE id='ALPHA'").run();
  f.db.prepare("UPDATE contacts SET name='Changed customer' WHERE id='ALPHA-customer'").run();
  const viewed = await f.req("GET", `${f.publicPath(sent)}/data`);
  assert.equal(viewed.data.status, "viewed"); assert.equal(viewed.data.customer_name, "ALPHA Customer");
  assert.equal(viewed.data.business.name, "ALPHA Plumbing");
  assert.equal(viewed.headers["cache-control"], "no-store"); assert.equal(viewed.headers["referrer-policy"], "no-referrer");
  for (const privateValue of ["Private customer note", "synthetic-ALPHA-token", "alpha@example.test", "+14165550300", "ALPHA-customer"]) assert.ok(!viewed.raw.includes(privateValue));
  assert.equal(f.dashboard("ALPHA").quotes_awaiting_response.length, 1);
  assert.equal((await f.req("PATCH", `${f.base()}/${sent.id}`, { notes: "Changed offer" })).status, 409);
  const accepted = await f.req("POST", `${f.publicPath(sent)}/respond`, { decision: "accepted" }, { origin: ORIGIN });
  assert.equal(accepted.data.status, "accepted"); assert.equal(accepted.data.can_respond, false);
  assert.equal(f.dashboard("ALPHA").quotes_awaiting_response.length, 0);
  assert.equal((await f.req("POST", `${f.publicPath(sent)}/respond`, { decision: "accepted" })).status, 200);
  assert.equal((await f.req("POST", `${f.publicPath(sent)}/respond`, { decision: "declined" })).status, 409);
  const activity = f.db.prepare("SELECT * FROM activity WHERE quote_id=?").all(sent.id);
  assert.equal(activity.filter((a) => a.label.endsWith("accepted")).length, 1);
  assert.equal(activity.filter((a) => a.label.endsWith("viewed")).length, 1);
  assert.ok(activity.every((a) => a.business_id === "ALPHA"));
});

test("public quote response rejects guessed tokens, wrong origins and cross-site submissions", async (t) => {
  const f = fixture(t); const q = (await f.send(await f.create())).data;
  assert.equal((await f.req("GET", `/q/${"a".repeat(64)}/data`)).status, 404);
  for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }]) {
    assert.equal((await f.req("POST", `${f.publicPath(q)}/respond`, { decision: "accepted" }, headers)).status, 403);
  }
  assert.equal((await f.req("POST", `${f.publicPath(q)}/respond`, { decision: "accepted" }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await f.req("POST", `${f.publicPath(q)}/respond`, { decision: "draft" })).status, 400);
  assert.equal((await f.req("GET", `${f.base()}/${q.id}`)).data.status, "sent");
});

test("expiry uses the selected UTC day's end and expired quotes cannot be sent or answered", async (t) => {
  const f = fixture(t); const q = (await f.send(await f.create({ expiry_date: "2026-10-01" }))).data;
  f.at("2026-10-01T23:59:59.999Z");
  assert.equal((await f.req("GET", `${f.publicPath(q)}/data`)).data.can_respond, true);
  f.advance(1);
  const expired = await f.req("GET", `${f.publicPath(q)}/data`);
  assert.equal(expired.data.status, "expired"); assert.equal(expired.data.can_respond, false);
  assert.equal((await f.send(q)).status, 409);
  assert.equal((await f.req("POST", `${f.publicPath(q)}/respond`, { decision: "accepted" })).status, 409);
  assert.equal((await f.req("GET", `${f.base()}?status=expired`)).data.length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity WHERE quote_id=? AND label LIKE '% expired'").get(q.id).n, 1);
});

test("quote texts require consent and share the existing phone-level STOP records", async (t) => {
  const f = fixture(t); const q = await f.create();
  f.db.prepare("UPDATE contacts SET sms_consent=0 WHERE id='ALPHA-customer'").run();
  assert.equal((await f.send(q)).status, 400);
  f.db.prepare("UPDATE contacts SET sms_consent=1 WHERE id='ALPHA-customer'").run();
  f.db.prepare("INSERT INTO phone_opt_outs VALUES ('ALPHA','+14165550300',?)").run(f.now().toISOString());
  assert.equal((await f.send(q)).status, 400);
  assert.equal(f.sms.length, 0);
  const beta = (await f.send(await f.create({}, "BETA"))).data;
  assert.equal(beta.status, "sent"); assert.equal(f.sms[0].authToken, "synthetic-BETA-token");
});

test("provider STOP failures suppress every later quote text for that business and phone", async (t) => {
  const f = fixture(t, { sendSms() { throw { code: 21610, status: 400, message: "secret" }; } });
  const first = (await f.send(await f.create())).data;
  assert.equal(first.status, "draft"); assert.equal(first.deliveries[0].status, "failed");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM phone_opt_outs WHERE business_id='ALPHA'").get().n, 1);
  assert.equal((await f.send(await f.create())).status, 400);
  assert.ok(!JSON.stringify(first).includes("secret"));
});

test("unanswered quotes get exactly one reminder at 48 and 120 hours, including viewed quotes", async (t) => {
  const f = fixture(t); const q = (await f.send(await f.create())).data;
  await f.req("GET", `${f.publicPath(q)}/data`);
  f.advance(2 * DAY - 1); assert.deepEqual(await f.runQuoteNudges(), { sent: 0, failed: 0 });
  f.advance(1); assert.equal((await f.runQuoteNudges()).sent, 1);
  await f.runQuoteNudges(); assert.equal(f.sms.length, 2);
  f.advance(3 * DAY - 1); await f.runQuoteNudges(); assert.equal(f.sms.length, 2);
  f.advance(1); assert.equal((await f.runQuoteNudges()).sent, 1);
  f.advance(10 * DAY); await f.runQuoteNudges(); assert.equal(f.sms.length, 3);
  assert.ok(f.sms.every((s) => s.body.endsWith("ALPHA Plumbing\nReply STOP to opt out")));
  const latest = (await f.req("GET", `${f.base()}/${q.id}`)).data;
  assert.equal(latest.nudge_count, 2);
  assert.deepEqual(latest.deliveries.map((d) => d.kind), ["initial", "nudge_2", "nudge_5"]);
});

test("accepted, declined, expired and owner-cancelled quotes stop follow-ups", async (t) => {
  const f = fixture(t);
  const accepted = (await f.send(await f.create())).data;
  const declined = (await f.send(await f.create())).data;
  await f.send(await f.create({ expiry_date: "2026-10-01" }));
  const cancelled = (await f.send(await f.create())).data;
  await f.req("POST", `${f.publicPath(accepted)}/respond`, { decision: "accepted" });
  await f.req("POST", `${f.publicPath(declined)}/respond`, { decision: "declined" });
  await f.req("POST", `${f.base()}/${cancelled.id}/cancel-follow-ups`, {});
  f.advance(6 * DAY); await f.runQuoteNudges();
  assert.equal(f.sms.length, 4);
  assert.equal((await f.req("GET", `${f.base()}?status=declined`)).data.length, 1);
});

test("changed numbers and revoked consent stop quote follow-ups instead of texting a new recipient", async (t) => {
  const f = fixture(t); await f.send(await f.create());
  f.db.prepare("UPDATE contacts SET phone='+14165550900' WHERE id='ALPHA-customer'").run();
  f.advance(2 * DAY); await f.runQuoteNudges(); assert.equal(f.sms.length, 1);
  await f.send(await f.create());
  f.db.prepare("UPDATE contacts SET sms_consent=0 WHERE id='ALPHA-customer'").run();
  f.advance(2 * DAY); await f.runQuoteNudges(); assert.equal(f.sms.length, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM quotes WHERE follow_ups_cancelled_at IS NOT NULL").get().n, 2);
});

test("worker catches up on boot after day five with one reminder and durable skipped slots", async (t) => {
  const f = fixture(t); const q = (await f.send(await f.create())).data;
  f.advance(6 * DAY);
  const restarted = createQuoteModule(f.config);
  const worker = startNudgeWorker({ runNudges: restarted.runQuoteNudges, intervalMs: 60000 });
  await worker.firstCheck; await worker.stop();
  assert.equal(f.sms.length, 2);
  const delivery = f.db.prepare("SELECT kind,status FROM quote_deliveries WHERE quote_id=? ORDER BY rowid").all(q.id);
  assert.equal(delivery.find((d) => d.kind === "nudge_2").status, "skipped");
  assert.equal(delivery.find((d) => d.kind === "nudge_5").status, "sent");
  await createQuoteModule(f.config).runQuoteNudges(); assert.equal(f.sms.length, 2);
});

test("concurrent nudge workers reserve each reminder before provider I/O", async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { async sendSms(message, count) { if (count > 1) await gate; return { sid: `SM${count}` }; } });
  await f.send(await f.create()); f.advance(2 * DAY);
  const first = f.runQuoteNudges();
  await createQuoteModule(f.config).runQuoteNudges();
  assert.equal(f.sms.length, 2); release(); await first;
  await f.runQuoteNudges(); assert.equal(f.sms.length, 2);
});

test("partial delivery failure is visible and retry sends only the failed channel", async (t) => {
  const f = fixture(t, { sendEmail(message, count) { if (count === 1) throw { code: "EAUTH", message: "password=secret" }; return { messageId: "success" }; } });
  const q = (await f.send(await f.create(), ["sms", "email"])).data;
  assert.equal(q.status, "sent"); assert.deepEqual(q.sendable_channels, ["email"]);
  assert.equal(q.deliveries.find((d) => d.channel === "email").status, "failed");
  assert.ok(!JSON.stringify(q).includes("secret"));
  f.advance(DAY);
  const retried = (await f.send(q, ["email"])).data;
  assert.equal(retried.sent_at, q.sent_at); assert.equal(f.sms.length, 1); assert.equal(f.email.length, 2);
  assert.equal(retried.deliveries.find((d) => d.channel === "email").attempts, 2);
  assert.equal((await f.send(q, ["sms"])).status, 409);
});

test("ambiguous initial sends and follow-ups never resend automatically or via Send", async (t) => {
  const f = fixture(t, { sendSms() { throw new Error("secret token in network failure"); } });
  const q = (await f.send(await f.create())).data;
  assert.equal(q.status, "draft"); assert.equal(q.deliveries[0].status, "uncertain");
  assert.equal((await f.send(q)).status, 409); assert.equal(f.sms.length, 1);
  assert.equal((await f.req("GET", `${f.publicPath(q)}/data`)).status, 404);
  assert.ok(!JSON.stringify(q).includes("secret token"));
  f.advance(6 * DAY); await f.runQuoteNudges(); assert.equal(f.sms.length, 1);
});

test("failed follow-ups remain in delivery history and consume only their scheduled slot", async (t) => {
  const f = fixture(t, { sendSms(message, count) { if (count > 1) throw { status: 400, code: 21211 }; return { sid: "SM1" }; } });
  const q = (await f.send(await f.create())).data;
  f.advance(2 * DAY); assert.equal((await f.runQuoteNudges()).failed, 1);
  await f.runQuoteNudges(); assert.equal(f.sms.length, 2);
  f.advance(3 * DAY); assert.equal((await f.runQuoteNudges()).failed, 1);
  await f.runQuoteNudges(); assert.equal(f.sms.length, 3);
  const shown = (await f.req("GET", `${f.base()}/${q.id}`)).data;
  assert.equal(shown.deliveries.filter((d) => d.status === "failed").length, 2);
  assert.equal(shown.status, "sent");
});

test("email-only quote sending does not require SMS consent and never nudges without it", async (t) => {
  const f = fixture(t); f.db.prepare("UPDATE contacts SET sms_consent=0 WHERE id='ALPHA-customer'").run();
  const q = (await f.send(await f.create(), ["email"])).data;
  assert.equal(q.status, "sent"); assert.equal(f.email.length, 1); assert.equal(f.sms.length, 0);
  assert.ok(f.email[0].text.includes(q.public_url));
  f.advance(6 * DAY); await f.runQuoteNudges(); assert.equal(f.sms.length, 0);
});

test("demo quotes simulate messages and cannot be picked up by a live worker", async (t) => {
  const f = fixture(t, { smsMode: "demo" }); const q = (await f.send(await f.create(), ["sms", "email"])).data;
  assert.equal(q.status, "sent"); assert.ok(q.deliveries.every((d) => d.status === "simulated"));
  assert.equal(f.sms.length + f.email.length, 0);
  assert.equal((await f.req("GET", `${f.publicPath(q)}/data`)).data.mode, "demo");
  f.advance(5 * DAY);
  await createQuoteModule({ ...f.config, smsMode: "twilio" }).runQuoteNudges();
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM quote_deliveries WHERE kind!='initial'").get().n, 0);
  await f.runQuoteNudges(); assert.equal(f.sms.length, 0);
});
