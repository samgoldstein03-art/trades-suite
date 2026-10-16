import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { startNudgeWorker } from "../src/worker.js";

const ORIGIN = "https://quotes.example.test";
const PASSWORD = "synthetic-quote-integration-admin-password";
const AUTH = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;
const DAY = 86400000;

function http(app, method, path, body, { authenticated = true, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
    socket.remoteAddress = "192.0.2.55";
    const req = new IncomingMessage(socket);
    const input = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req.complete = true; req.method = method; req.url = path;
    req.headers = { host: "quotes.example.test", ...(authenticated ? { authorization: AUTH } : {}), ...(input ? { "content-type": "application/json", "content-length": String(input.length) } : {}), ...headers };
    req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new ServerResponse(req); res.assignSocket(socket);
    const chunks = [];
    const write = res.write.bind(res); const end = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Request timed out: ${method} ${path}`)); }, 3000);
    res.on("error", reject);
    res.on("finish", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString();
      let data; try { data = JSON.parse(raw); } catch { data = raw; }
      setImmediate(() => { resolve({ status: res.statusCode, headers: res.getHeaders(), data, raw }); socket.destroy(); });
    });
    app(req, res);
    if (input) req.push(input);
    req.push(null);
  });
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "trades-quote-integration-"));
  const keys = ["NODE_ENV", "HOST", "RENDER_EXTERNAL_URL", "ADMIN_ORIGIN", "PUBLIC_BASE_URL", "QUOTE_PUBLIC_BASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "TRUST_PROXY_HOPS"];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: "production", ADMIN_ORIGIN: ORIGIN, PUBLIC_BASE_URL: ORIGIN, ADMIN_PASSWORD: PASSWORD });
  for (const key of ["QA", "QB"]) {
    for (const [name, value] of Object.entries({ ACCOUNT_SID: `AC${(key === "QA" ? "a" : "b").repeat(32)}`, AUTH_TOKEN: `synthetic-${key}-token`, PHONE_NUMBER: key === "QA" ? "+14165550101" : "+14165550102" })) {
      const envKey = `BUSINESS_${key}_${name}`; original.set(envKey, process.env[envKey]); process.env[envKey] = value;
    }
  }
  let current = new Date("2026-10-01T12:00:00Z");
  const sms = []; const emails = [];
  const settings = { dbPath: join(directory, "suite.sqlite"), uploadDir: join(directory, "uploads"), smsMode: "twilio", now: () => new Date(current), sendSms: async (message) => { sms.push(message); return options.sendSms ? options.sendSms(message, sms.length) : { sid: `SM${sms.length}` }; }, sendEmail: async (message) => { emails.push(message); return { messageId: `mail-${emails.length}` }; } };
  let suite = createApp(settings);
  let worker;
  t.after(async () => {
    await worker?.stop(); suite?.close();
    for (const [key, value] of original) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });
  const request = (method, path, body, options) => http(suite.app, method, path, body, options);
  async function business(key = "QA") {
    const result = await request("POST", "/api/businesses", { name: `${key} Heating`, phone: "+14165550999", booking_url: "https://example.test/book", google_review_url: "https://example.test/review", sms_key: key });
    assert.equal(result.status, 201, result.raw); return result.data;
  }
  async function contact(biz) {
    const result = await request("POST", `/api/businesses/${biz.id}/contacts`, { name: `${biz.sms_key} Customer`, phone: "+14165550300", email: "customer-private@example.test", notes: "Private boiler access code 76251", tags: ["customer"], sms_consent: true });
    assert.equal(result.status, 201, result.raw); return result.data;
  }
  async function create(biz, person, overrides = {}) {
    const result = await request("POST", `/api/businesses/${biz.id}/quotes`, { contact_id: person.id, line_items: [{ description: "Boiler service", quantity: 1, unit_price: 150 }], tax_rate: 13, expiry_date: "2026-11-30", notes: "Parts and labour included.", ...overrides });
    assert.equal(result.status, 201, result.raw); return result.data;
  }
  const quotePath = (q) => `/api/businesses/${q.business_id}/quotes/${q.id}`;
  const send = (q, channels = ["sms"]) => request("POST", `${quotePath(q)}/send`, { channels });
  return { get suite() { return suite; }, directory, settings, request, business, contact, create, send, quotePath, sms, emails,
    advance(ms) { current = new Date(current.getTime() + ms); },
    at(value) { current = new Date(value); },
    async restart() { await worker?.stop(); suite.close(); suite = createApp(settings); },
    async bootWorker() {
      worker = startNudgeWorker({ runNudges: async () => { await suite.runNudges(); await suite.runQuoteNudges(); } });
      await worker.firstCheck; return worker;
    },
  };
}

test("hosted quote journey keeps admin protected and customer viewing and acceptance public", async (t) => {
  const f = await fixture(t);
  const alpha = await f.business(); const person = await f.contact(alpha);
  const beta = await f.business("QB"); const other = await f.contact(beta);
  assert.equal((await f.request("GET", "/api/businesses", undefined, { authenticated: false })).status, 401);
  const draft = await f.create(alpha, person);
  assert.equal((await f.request("GET", f.quotePath(draft), undefined, { authenticated: false })).status, 401);
  assert.equal((await f.request("GET", `/api/businesses/${beta.id}/quotes/${draft.id}`)).status, 404);
  const badCustomer = await f.request("POST", `/api/businesses/${beta.id}/quotes`, { contact_id: person.id, line_items: [{ description: "Work", quantity: 1, unit_price: 1 }], expiry_date: "2026-11-30" });
  assert.equal(badCustomer.status, 404, "module errors survive the app's safe error handler");
  const sent = await f.send(draft, ["sms", "email"]);
  assert.equal(sent.status, 200, sent.raw); assert.equal(sent.data.status, "sent");
  assert.equal(sent.data.total_cents, 16950); assert.equal(f.emails.length, 1);
  const otherSent = (await f.send(await f.create(beta, other))).data;
  assert.equal(otherSent.status, "sent");
  assert.equal(f.sms[0].authToken, "synthetic-QA-token"); assert.equal(f.sms[1].authToken, "synthetic-QB-token");
  assert.equal(f.sms[0].from, "+14165550101"); assert.equal(f.sms[1].from, "+14165550102");
  assert.ok(f.sms.every((message) => message.body.endsWith("Reply STOP to opt out")));
  const customerPath = new URL(sent.data.public_url).pathname;
  const page = await f.request("GET", customerPath, undefined, { authenticated: false });
  assert.equal(page.status, 200); assert.ok(page.raw.includes("/q/assets/quote.js"));
  assert.equal(page.headers["www-authenticate"], undefined);
  const view = await f.request("GET", `${customerPath}/data`, undefined, { authenticated: false });
  assert.equal(view.status, 200); assert.equal(view.data.status, "viewed");
  for (const secret of [person.email, person.phone, person.notes, person.id, "synthetic-QA-token", beta.name]) assert.ok(!view.raw.includes(secret), secret);
  const accepted = await f.request("POST", `${customerPath}/respond`, { decision: "accepted" }, { authenticated: false, headers: { origin: ORIGIN } });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.status, "accepted");
  assert.equal((await f.request("GET", f.quotePath(draft))).data.status, "accepted");
  const dash = await f.request("GET", `/api/businesses/${alpha.id}/dashboard`);
  assert.deepEqual(dash.data.quotes_awaiting_response, []);
  const otherDash = await f.request("GET", `/api/businesses/${beta.id}/dashboard`);
  assert.equal(otherDash.data.quotes_awaiting_response.length, 1);
  const activity = (await f.request("GET", `/api/businesses/${alpha.id}/activity`)).data;
  assert.ok(activity.some((item) => item.quote_id === draft.id && item.label.endsWith("accepted")));
  assert.ok(activity.every((item) => item.business_id === alpha.id));
  assert.equal((await f.request("GET", `/api/businesses/${beta.id}/quotes?status=accepted`)).data.length, 0);
});

test("reopened SQLite catches up quote and review follow-ups on worker boot without duplicating sends", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  const q = (await f.send(await f.create(biz, person))).data;
  const review = await f.request("POST", `/api/businesses/${biz.id}/requests`, { contact_id: person.id });
  assert.equal(review.status, 201); assert.equal(f.sms.length, 2);
  f.advance(6 * DAY);
  await f.restart(); // closes the old connection, then reruns the additive migration
  await f.bootWorker();
  assert.equal(f.sms.length, 4, "one overdue review reminder and one current quote reminder");
  const quote = (await f.request("GET", f.quotePath(q))).data;
  assert.equal(quote.deliveries.find((d) => d.kind === "nudge_2").status, "skipped");
  assert.equal(quote.deliveries.find((d) => d.kind === "nudge_5").status, "sent");
  assert.equal(quote.nudge_count, 1);
  assert.equal(f.suite.db.prepare("SELECT status FROM review_requests WHERE id=?").get(review.data.id).status, "nudged");
  const dash = (await f.request("GET", `/api/businesses/${biz.id}/dashboard`)).data;
  assert.ok(dash.worker_last_checked_at);
  await f.restart(); await f.bootWorker();
  assert.equal(f.sms.length, 4);
  assert.equal(f.suite.db.prepare("SELECT COUNT(*) n FROM contacts").get().n, 1);
});

test("public quote logos use scoped URLs while admin uploads remain protected", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  await writeFile(join(f.settings.uploadDir, "sample.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  f.suite.db.prepare("UPDATE businesses SET logo_url='/uploads/sample.png' WHERE id=?").run(biz.id);
  const q = (await f.send(await f.create(biz, person))).data;
  const view = (await f.request("GET", `${new URL(q.public_url).pathname}/data`, undefined, { authenticated: false })).data;
  assert.match(view.business.logo_url, /^\/q\/[a-f0-9]{64}\/logo$/);
  assert.equal((await f.request("GET", view.business.logo_url, undefined, { authenticated: false })).status, 200);
  assert.equal((await f.request("GET", "/uploads/sample.png", undefined, { authenticated: false })).status, 401);
  assert.equal((await f.request("GET", `/q/${"0".repeat(64)}/logo`, undefined, { authenticated: false })).status, 404);
});

test("a provider acceptance across expiry keeps the customer link usable without reviving the offer", async (t) => {
  let release; let announce;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { announce = resolve; });
  const f = await fixture(t, { async sendSms() { announce(); await gate; return { sid: "SM-expiry-race" }; } });
  const biz = await f.business(); const person = await f.contact(biz);
  const draft = await f.create(biz, person, { expiry_date: "2026-10-01" });
  f.at("2026-10-01T23:59:59Z");
  const pending = f.send(draft);
  await started;
  try {
    assert.equal((await f.send(draft)).status, 409, "in-flight sends cannot duplicate the first send");
    f.at("2026-10-02T00:00:01Z");
    assert.equal((await f.request("GET", f.quotePath(draft))).data.status, "expired");
  } finally { release(); }
  const delivered = await pending;
  assert.equal(delivered.status, 200); assert.equal(delivered.data.status, "expired");
  assert.ok(delivered.data.sent_at);
  const publicPath = new URL(delivered.data.public_url).pathname;
  const view = await f.request("GET", `${publicPath}/data`, undefined, { authenticated: false });
  assert.equal(view.status, 200); assert.equal(view.data.status, "expired"); assert.equal(view.data.can_respond, false);
  assert.equal((await f.request("POST", `${publicPath}/respond`, { decision: "accepted" }, { authenticated: false })).status, 409);
  const activity = (await f.request("GET", `/api/businesses/${biz.id}/activity`)).data;
  assert.equal(activity.filter((item) => item.kind === "quote_status" && item.label.endsWith(" sent")).length, 0);
  assert.equal(f.sms.length, 1);
});

test("invalid public customer documents have a designed HTML error while API error contracts stay JSON", async (t) => {
  const f = await fixture(t);
  for (const path of ["/q/not-a-quote", "/q/unsubscribe/not-a-preference-link"]) {
    const page = await f.request("GET", path, undefined, { authenticated: false, headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" } });
    assert.equal(page.status, 404);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.match(page.raw, /<title>Link unavailable — Tradesuite<\/title>/);
    assert.match(page.raw, /This link couldn’t be opened/);
    assert.match(page.raw, /\/q\/assets\/design-system\.css/);
    assert.match(page.raw, /\/q\/assets\/favicon\.svg/);
    assert.equal(page.headers["www-authenticate"], undefined);
    const head = await f.request("HEAD", path, undefined, { authenticated: false, headers: { accept: "text/html" } });
    assert.equal(head.status, 404); assert.equal(head.raw, ""); assert.match(head.headers["content-type"], /^text\/html/);
    for (const accept of [undefined, "*/*", "application/json", "text/html;q=0,application/json"]) {
      const api = await f.request("GET", path, undefined, { authenticated: false, headers: accept ? { accept } : {} });
      assert.equal(api.status, 404); assert.equal(typeof api.data.error, "string");
      assert.doesNotMatch(api.raw, /<!doctype html>/i, `Original JSON error payload for ${path} with Accept ${accept}`);
    }
  }
  for (const path of ["/q/not-a-quote/data", "/q/unsubscribe/not-a-preference-link/data"]) {
    const data = await f.request("GET", path, undefined, { authenticated: false, headers: { accept: "text/html" } });
    assert.equal(data.status, 404); assert.match(data.headers["content-type"], /^application\/json/);
  }
  const response = await f.request("POST", "/q/not-a-quote/respond", { decision: "accepted" }, { authenticated: false, headers: { accept: "text/html" } });
  assert.equal(response.status, 404); assert.match(response.headers["content-type"], /^application\/json/);
});
