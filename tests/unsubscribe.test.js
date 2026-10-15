import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import twilio from "twilio";
import { createApp } from "../src/app.js";

const ORIGIN = "https://quotes.example.test";
const PASSWORD = "synthetic-unsubscribe-admin-password";
const AUTH = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;
const DAY = 86400000;

// Exercise the actual middleware without opening network ports. Forms are sent
// with their real encoding, including the mail receiver's one-click POST.
function http(app, method, path, body, { authenticated = true, form = false, rawBody = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
    socket.remoteAddress = "192.0.2.76";
    const req = new IncomingMessage(socket);
    const input = body === undefined ? null : Buffer.from(rawBody ? body : form ? new URLSearchParams(body).toString() : JSON.stringify(body));
    req.complete = true; req.method = method; req.url = path;
    req.headers = {
      host: "quotes.example.test", ...(authenticated ? { authorization: AUTH } : {}),
      ...(input ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", "content-length": String(input.length) } : {}), ...headers,
    };
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
      setImmediate(() => { resolve({ status: res.statusCode, headers: res.getHeaders(), data, raw }); socket.destroy(); });
    });
    app(req, res); if (input) req.push(input); req.push(null);
  });
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "trades-unsubscribe-"));
  const keys = ["NODE_ENV", "HOST", "RENDER_EXTERNAL_URL", "ADMIN_ORIGIN", "PUBLIC_BASE_URL", "QUOTE_PUBLIC_BASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "TRUST_PROXY_HOPS"];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: "production", ADMIN_ORIGIN: ORIGIN, PUBLIC_BASE_URL: ORIGIN, ADMIN_PASSWORD: PASSWORD });
  const credentials = {};
  for (const key of ["UNSUBA", "UNSUBB"]) {
    credentials[key] = { ACCOUNT_SID: `AC${(key === "UNSUBA" ? "a" : "b").repeat(32)}`, AUTH_TOKEN: `synthetic-${key}-token`, PHONE_NUMBER: key === "UNSUBA" ? "+14165550101" : "+14165550102" };
    for (const [name, value] of Object.entries(credentials[key])) {
      const envKey = `BUSINESS_${key}_${name}`; original.set(envKey, process.env[envKey]); process.env[envKey] = value;
    }
  }
  let current = new Date("2026-10-01T12:00:00Z");
  const sms = []; const emails = [];
  const settings = {
    dbPath: join(directory, "suite.sqlite"), uploadDir: join(directory, "uploads"), smsMode: "twilio", now: () => new Date(current),
    sendSms: async (message) => { sms.push(message); return options.sendSms ? options.sendSms(message, sms.length) : { sid: `SM${sms.length}` }; },
    sendEmail: async (message) => { emails.push(message); return options.sendEmail ? options.sendEmail(message, emails.length) : { messageId: `mail-${emails.length}` }; },
  };
  let suite = createApp(settings);
  t.after(async () => {
    suite?.close();
    for (const [key, value] of original) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });
  const request = (method, path, body, options) => http(suite.app, method, path, body, options);
  async function business(key = "UNSUBA") {
    const result = await request("POST", "/api/businesses", { name: `${key} Heating`, phone: "+14165550999", booking_url: "https://example.test/book", google_review_url: "https://example.test/review", sms_key: key });
    assert.equal(result.status, 201, result.raw); return result.data;
  }
  async function contact(biz, changes = {}) {
    const result = await request("POST", `/api/businesses/${biz.id}/contacts`, { name: "Pat Customer", phone: "+14165550300", email: "pat@example.test", notes: "Private access code 76251", tags: ["customer"], sms_consent: true, ...changes });
    assert.equal(result.status, 201, result.raw); return result.data;
  }
  async function create(biz, person, changes = {}) {
    const result = await request("POST", `/api/businesses/${biz.id}/quotes`, { contact_id: person.id, line_items: [{ description: "Boiler service", quantity: 1, unit_price: 150 }], tax_rate: 13, expiry_date: "2026-11-30", notes: "Includes labour.", ...changes });
    assert.equal(result.status, 201, result.raw); return result.data;
  }
  const quotePath = (q) => `/api/businesses/${q.business_id}/quotes/${q.id}`;
  const send = (q, channels = ["email"]) => request("POST", `${quotePath(q)}/send`, { channels });
  function unsubscribePath(index = emails.length - 1) {
    assert.equal(typeof emails[index]?.unsubscribeUrl, "string", "each initial email includes its unsubscribe URL");
    const url = new URL(emails[index].unsubscribeUrl);
    assert.equal(url.origin, ORIGIN); assert.match(url.pathname, /^\/q\/unsubscribe\/[a-f0-9]{64}$/);
    return url.pathname;
  }
  const unsubscribe = (path = unsubscribePath()) => request("POST", path, { "List-Unsubscribe": "One-Click" }, { authenticated: false, form: true });
  const contacts = async (biz) => (await request("GET", `/api/businesses/${biz.id}/contacts`)).data;
  async function webhook(biz, person, keyword) {
    const credential = credentials[biz.sms_key]; const path = `/webhooks/twilio/${biz.id}`;
    const body = { AccountSid: credential.ACCOUNT_SID, To: credential.PHONE_NUMBER, From: person.phone, Body: keyword };
    const signature = twilio.getExpectedTwilioSignature(credential.AUTH_TOKEN, `${ORIGIN}${path}`, body);
    return request("POST", path, body, { authenticated: false, form: true, headers: { "x-twilio-signature": signature } });
  }
  return {
    get suite() { return suite; }, request, business, contact, create, send, quotePath, unsubscribePath, unsubscribe, contacts, webhook, sms, emails,
    advance(ms) { current = new Date(current.getTime() + ms); },
    restart() { suite.close(); suite = createApp(settings); },
  };
}

test("initial quote emails include a separate opaque unsubscribe link in their visible footer", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  const sent = await f.send(await f.create(biz, person));
  assert.equal(sent.status, 200, sent.raw); assert.equal(f.emails.length, 1);
  const link = f.unsubscribePath();
  assert.ok(f.emails[0].text.includes(f.emails[0].unsubscribeUrl));
  assert.match(f.emails[0].text, /unsubscribe/i);
  assert.notEqual(link.split("/").at(-1), new URL(sent.data.public_url).pathname.split("/").at(-1));
  for (const secret of [person.email, person.phone, person.id]) assert.ok(!link.includes(secret));
});

test("public GET and HEAD are safe while a cookie-free one-click POST opts out once", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  await f.send(await f.create(biz, person)); const path = f.unsubscribePath();
  assert.equal((await f.request("GET", "/api/businesses", undefined, { authenticated: false })).status, 401);
  const page = await f.request("GET", path, undefined, { authenticated: false });
  assert.equal(page.status, 200, page.raw); assert.match(page.raw, /<form\b/i); assert.match(page.raw, /unsubscribe/i);
  assert.equal(page.headers["www-authenticate"], undefined); assert.equal(page.headers["cache-control"], "no-store");
  assert.equal((await f.request("HEAD", path, undefined, { authenticated: false })).status, 200);
  assert.equal((await f.contacts(biz))[0].quote_email_opted_out, false);
  assert.equal((await f.request("POST", path, { "List-Unsubscribe": "wrong" }, { authenticated: false, form: true })).status, 400);
  assert.equal((await f.contacts(biz))[0].quote_email_opted_out, false);
  const result = await f.unsubscribe(path);
  assert.ok([200, 204].includes(result.status), result.raw); assert.equal(result.headers.location, undefined);
  assert.equal(result.headers["www-authenticate"], undefined); assert.equal(result.headers["set-cookie"], undefined);
  assert.equal((await f.contacts(biz))[0].quote_email_opted_out, true);
  const count = f.suite.db.prepare("SELECT COUNT(*) n FROM activity WHERE business_id=? AND contact_id=? AND kind='opt_out'").get(biz.id, person.id).n;
  assert.equal(count, 1);
  assert.ok([200, 204].includes((await f.unsubscribe(path)).status));
  assert.equal(f.suite.db.prepare("SELECT COUNT(*) n FROM activity WHERE business_id=? AND contact_id=? AND kind='opt_out'").get(biz.id, person.id).n, count);
});

test("manual footer form unsubscribes without login and guessed tokens cannot affect contacts", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  const sent = (await f.send(await f.create(biz, person))).data; const path = f.unsubscribePath();
  for (const invalid of ["not-a-token", "0".repeat(64)]) {
    assert.equal((await f.request("GET", `/q/unsubscribe/${invalid}`, undefined, { authenticated: false })).status, 404);
    assert.equal((await f.unsubscribe(`/q/unsubscribe/${invalid}`)).status, 404);
  }
  const quoteToken = new URL(sent.public_url).pathname.split("/").at(-1);
  assert.equal((await f.request("GET", `/q/unsubscribe/${quoteToken}`, undefined, { authenticated: false })).status, 404, "the customer quote token cannot change contact preferences");
  assert.equal((await f.unsubscribe(`/q/unsubscribe/${quoteToken}`)).status, 404);
  assert.equal((await f.contacts(biz))[0].quote_email_opted_out, false);
  const result = await f.request("POST", path, { action: "unsubscribe" }, { authenticated: false, form: true });
  assert.ok([200, 204].includes(result.status), result.raw);
  assert.equal((await f.contacts(biz))[0].quote_email_opted_out, true);
});

test("a mail receiver can unsubscribe with an RFC 8058 multipart form POST", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  await f.send(await f.create(biz, person)); const path = f.unsubscribePath();
  const boundary = "UnsubscribeTestBoundary";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`;
  const result = await f.request("POST", path, body, { authenticated: false, rawBody: true, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
  assert.ok([200, 204].includes(result.status), result.raw);
  assert.equal(result.headers.location, undefined); assert.equal(result.headers["www-authenticate"], undefined);
  assert.equal((await f.contacts(biz))[0].quote_email_opted_out, true);
});

test("email unsubscribe stays scoped to one contact and one business, including duplicate addresses and phones", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  const duplicate = await f.contact(biz, { name: "Separate household contact" });
  const otherBiz = await f.business("UNSUBB"); const otherPerson = await f.contact(otherBiz);
  await f.send(await f.create(biz, person)); const path = f.unsubscribePath();
  assert.ok([200, 204].includes((await f.unsubscribe(path)).status));
  const current = await f.contacts(biz);
  assert.equal(current.find((c) => c.id === person.id).quote_email_opted_out, true);
  assert.equal(current.find((c) => c.id === duplicate.id).quote_email_opted_out, false);
  assert.equal((await f.contacts(otherBiz))[0].quote_email_opted_out, false);
  assert.equal(f.suite.db.prepare("SELECT COUNT(*) n FROM phone_opt_outs").get().n, 0, "email unsubscribe must not suppress unrelated contacts sharing this phone");
  for (const channels of [["email"], ["sms"], ["sms", "email"]]) {
    const blocked = await f.send(await f.create(biz, person), channels);
    assert.equal(blocked.status, 400, blocked.raw);
  }
  assert.equal((await f.send(await f.create(biz, duplicate), ["sms", "email"])).status, 200);
  assert.equal((await f.send(await f.create(otherBiz, otherPerson), ["sms", "email"])).status, 200);
});

test("email unsubscribe stops existing review and quote nudges as well as new review texts", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  const q = (await f.send(await f.create(biz, person), ["sms", "email"])).data;
  const review = await f.request("POST", `/api/businesses/${biz.id}/requests`, { contact_id: person.id });
  assert.equal(review.status, 201, review.raw); assert.equal(f.sms.length, 2);
  assert.ok([200, 204].includes((await f.unsubscribe()).status));
  assert.equal((await f.request("POST", `/api/businesses/${biz.id}/requests/preview`, { contact_id: person.id })).status, 200, "read-only previews retain their existing behavior");
  assert.equal((await f.request("POST", `/api/businesses/${biz.id}/requests`, { contact_id: person.id })).status, 400);
  const dash = (await f.request("GET", `/api/businesses/${biz.id}/dashboard`)).data;
  assert.equal(dash.upcoming_nudges.length, 0);
  f.advance(3 * DAY); await f.suite.runNudges(); await f.suite.runQuoteNudges();
  f.advance(3 * DAY); await f.suite.runNudges(); await f.suite.runQuoteNudges();
  assert.equal(f.sms.length, 2, "neither reminder worker sends after the contact unsubscribes");
  assert.ok((await f.request("GET", f.quotePath(q))).data.follow_ups_cancelled_at);
});

test("SMS STOP blocks quote emails and SMS START cannot clear an email unsubscribe", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  await f.send(await f.create(biz, person)); const path = f.unsubscribePath();
  assert.equal((await f.webhook(biz, person, "STOP")).status, 200);
  assert.equal((await f.send(await f.create(biz, person), ["email"])).status, 400);
  assert.equal(f.emails.length, 1);
  assert.equal((await f.webhook(biz, person, "START")).status, 200);
  assert.equal((await f.send(await f.create(biz, person), ["email"])).status, 200);
  assert.ok([200, 204].includes((await f.unsubscribe(path)).status));
  assert.equal((await f.webhook(biz, person, "STOP")).status, 200);
  assert.equal((await f.webhook(biz, person, "START")).status, 200);
  const saved = (await f.contacts(biz))[0];
  assert.equal(saved.quote_email_opted_out, true); assert.equal(saved.opted_out, true);
  for (const channels of [["sms"], ["email"]]) assert.equal((await f.send(await f.create(biz, person), channels)).status, 400);
});

test("unsubscribe persists through restart, contact edits, and quote expiry", async (t) => {
  const f = await fixture(t); const biz = await f.business(); const person = await f.contact(biz);
  await f.send(await f.create(biz, person, { expiry_date: "2026-10-02" })); const path = f.unsubscribePath();
  f.advance(5 * DAY); f.restart();
  assert.ok([200, 204].includes((await f.unsubscribe(path)).status), "the unsubscribe capability outlives an expired quote");
  f.restart();
  const edit = await f.request("PATCH", `/api/businesses/${biz.id}/contacts/${person.id}`, { phone: "+14165550444", email: "new-pat@example.test", notes: "Updated", sms_consent: true });
  assert.equal(edit.status, 200, edit.raw); assert.equal(edit.data.quote_email_opted_out, true);
  const bypass = await f.request("PATCH", `/api/businesses/${biz.id}/contacts/${person.id}`, { opted_out: false, quote_email_opted_out: false });
  assert.equal(bypass.status, 400, bypass.raw);
  f.restart();
  assert.equal((await f.contacts(biz))[0].quote_email_opted_out, true);
  for (const channels of [["email"], ["sms"]]) assert.equal((await f.send(await f.create(biz, person), channels)).status, 400);
});

test("unsubscribe arriving during a combined send prevents its remaining provider call", async (t) => {
  let release; let announce;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { announce = resolve; });
  const f = await fixture(t, { async sendSms() { announce(); await gate; return { sid: "SM-unsubscribe-race" }; } });
  const biz = await f.business(); const person = await f.contact(biz);
  await f.send(await f.create(biz, person), ["email"]); const path = f.unsubscribePath();
  const pending = f.send(await f.create(biz, person), ["sms", "email"]);
  await started;
  try { assert.ok([200, 204].includes((await f.unsubscribe(path)).status)); }
  finally { release(); }
  const result = await pending;
  assert.equal(result.status, 200, result.raw);
  assert.equal(f.sms.length, 1, "the already submitted SMS can finish");
  assert.equal(f.emails.length, 1, "the second channel is suppressed before contacting its provider");
  assert.ok(result.data.deliveries.some((d) => d.channel === "email" && d.status === "skipped"));
});
