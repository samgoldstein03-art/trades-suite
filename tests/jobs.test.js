import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdtempSync, rmSync, rmdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { createJobModule } from "../src/jobs.js";
import { createQuoteModule } from "../src/quotes.js";
import { createApp } from "../src/app.js";

const ORIGIN = "https://jobs.example.test";
// Real Express requests without listening on a TCP port or calling providers.
function request(app, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
    socket.remoteAddress = "192.0.2.11";
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error(`Request timed out: ${method} ${url}`)); }, 3000);
    const req = new IncomingMessage(socket);
    const input = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req.method = method; req.url = url; req.complete = true;
    req.headers = { host: "jobs.example.test", ...(input ? { "content-type": "application/json", "content-length": String(input.length) } : {}), ...headers };
    req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new ServerResponse(req); res.assignSocket(socket);
    const chunks = [], write = res.write.bind(res), end = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
    res.on("error", reject);
    res.on("finish", () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString();
      let data; try { data = JSON.parse(raw); } catch { data = raw; }
      resolve({ status: res.statusCode, headers: res.getHeaders(), data, raw }); socket.destroy();
    });
    app(req, res); if (input) req.push(input); req.push(null);
  });
}
function seed(db, when) {
  for (const business of ["ALPHA", "BETA"]) {
    db.prepare("INSERT INTO businesses (id,name,phone,booking_url,sms_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(business, `${business} Heating`, "+14165550999", "https://example.test/book", business, when, when);
    for (const suffix of ["customer", "other"]) db.prepare("INSERT INTO contacts (id,business_id,name,phone,email,notes,sms_consent,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)")
      .run(`${business}-${suffix}`, business, `${business} ${suffix}`, "+14165550300", `${suffix}@example.test`, "Private customer note", when, when);
  }
}
function fixture(t, options = {}) {
  const db = options.db || openDatabase(":memory:");
  let current = new Date("2026-11-05T12:00:00Z");
  const now = () => new Date(current);
  seed(db, now().toISOString());
  let providerCalls = 0;
  const config = { db, now, smsMode: options.smsMode || "demo", publicOrigin: options.origin || ORIGIN, uploadDir: options.uploadDir, sendSms: async () => { providerCalls++; throw new Error("Jobs must not send texts."); }, sendEmail: async () => { providerCalls++; throw new Error("Jobs must not send emails."); } };
  const jobs = createJobModule(config), quotes = createQuoteModule(config);
  const app = express(); app.use(express.json());
  app.use("/api/businesses/:businessId/jobs", jobs.adminRouter);
  app.use("/api/businesses/:businessId/quotes", quotes.adminRouter);
  app.use("/j", jobs.publicRouter); app.use("/q", quotes.publicRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const req = (method, url, body, headers) => request(app, method, url, body, headers);
  const base = (business = "ALPHA") => `/api/businesses/${business}/jobs`;
  const create = async (overrides = {}, business = "ALPHA") => {
    const result = await req("POST", base(business), { contact_id: `${business}-customer`, title: "Furnace service", service_address: "10 Example Street", ...overrides });
    assert.equal(result.status, 201, result.raw); return result.data;
  };
  const share = async (job) => {
    const result = await req("POST", `${base(job.business_id)}/${job.id}/share`, {});
    assert.equal(result.status, 200, result.raw); return result.data;
  };
  const quote = async (status = "accepted", business = "ALPHA") => {
    const quoteBase = `/api/businesses/${business}/quotes`;
    const made = await req("POST", quoteBase, { contact_id: `${business}-customer`, line_items: [{ description: "Replace furnace", quantity: 1, unit_price: 4500 }], tax_rate: 13, expiry_date: "2026-11-30", notes: "Agreed installation terms." });
    assert.equal(made.status, 201, made.raw);
    if (status === "draft") return made.data;
    const sent = await req("POST", `${quoteBase}/${made.data.id}/send`, { channels: ["sms"] });
    assert.equal(sent.status, 200, sent.raw);
    if (["accepted", "declined"].includes(status)) {
      assert.equal((await req("POST", `${new URL(sent.data.public_url).pathname}/respond`, { decision: status }, { origin: ORIGIN })).status, 200);
    }
    return (await req("GET", `${quoteBase}/${made.data.id}`)).data;
  };
  t.after(() => { if (!options.db) db.close(); });
  return { db, req, base, create, share, quote, now, advance(ms = 60000) { current = new Date(current.getTime() + ms); }, providerCalls: () => providerCalls };
}

test("jobs reuse scoped customers and existing activity without sending messages", async (t) => {
  const f = fixture(t), job = await f.create({ description: "Check ignition and airflow.", private_notes: "Owner-only diagnosis" });
  assert.equal(job.status, "awaiting_scheduling"); assert.equal(job.job_type, "service");
  assert.equal(job.contact_name, "ALPHA customer"); assert.equal(job.private_notes, "Owner-only diagnosis");
  assert.equal(job.public_url, null); assert.equal(job.link_enabled, false); assert.ok(!("public_token" in job));
  assert.equal(job.scheduled_date, ""); assert.equal(job.time_zone, "America/Toronto");
  assert.match(job.reference, /^J-[0-9A-F]{8}$/);
  assert.equal(job.public_updates[0].message, "Job created.");
  assert.equal((await f.req("GET", f.base())).data.length, 1);
  assert.deepEqual((await f.req("GET", f.base("BETA"))).data, []);
  assert.equal((await f.req("GET", `${f.base("BETA")}/${job.id}`)).status, 404);
  assert.equal((await f.req("POST", f.base("BETA"), { contact_id: job.contact_id, title: "Leak", service_address: "Site" })).status, 404);
  assert.equal((await f.req("POST", "/api/businesses/missing/jobs", {})).status, 404);
  const log = f.db.prepare("SELECT * FROM activity WHERE job_id=?").all(job.id);
  assert.equal(log.length, 1); assert.equal(log[0].kind, "job_created"); assert.equal(log[0].business_id, "ALPHA");
  assert.equal(log[0].body, null); assert.equal(f.providerCalls(), 0);
});

test("job validation preserves local dates and enforces complete same-day arrival windows", async (t) => {
  const f = fixture(t);
  const booked = { status: "scheduled", scheduled_date: "2028-02-29", arrival_start: "08:00", arrival_end: "10:00", time_zone: "America/Vancouver" };
  const job = await f.create(booked);
  for (const key of Object.keys(booked)) assert.equal(job[key], booked[key]);
  for (const overrides of [
    { title: "" }, { title: "x".repeat(161) }, { service_address: "" }, { description: "x".repeat(5001) },
    { job_type: "invoice" }, { status: "paid" }, { time_zone: "Mars/Olympus" }, { time_zone: "+01:00" },
    { status: "scheduled" }, { scheduled_date: "2026-11-10" }, { arrival_start: "08:00" },
    { ...booked, scheduled_date: "2027-02-29" }, { ...booked, arrival_start: "8:00" },
    { ...booked, arrival_start: "24:00" }, { ...booked, arrival_end: "08:00" },
    { ...booked, arrival_start: "23:00", arrival_end: "01:00" }, { ...booked, status: "awaiting_scheduling" },
  ]) {
    const result = await f.req("POST", f.base(), { contact_id: "ALPHA-customer", title: "Service", service_address: "10 Example Street", ...overrides });
    assert.equal(result.status, 400, JSON.stringify(overrides));
  }
  assert.equal((await f.req("PATCH", `${f.base()}/${job.id}`, { status: "awaiting_scheduling" })).status, 400);
  const cleared = await f.req("PATCH", `${f.base()}/${job.id}`, { status: "awaiting_scheduling", scheduled_date: "", arrival_start: "", arrival_end: "" });
  assert.equal(cleared.status, 200); assert.equal(cleared.data.scheduled_date, "");
});

test("job status, schedule and customer messages append history while private edits stay private", async (t) => {
  const f = fixture(t), job = await f.share(await f.create()), url = new URL(job.public_url).pathname;
  const before = (await f.req("GET", `${url}/data`)).data;
  const path = `${f.base()}/${job.id}`;
  f.advance();
  const privateEdit = (await f.req("PATCH", path, { private_notes: "Gate code 7890" })).data;
  assert.notEqual(privateEdit.updated_at, job.updated_at);
  assert.equal(privateEdit.public_updated_at, job.public_updated_at);
  assert.deepEqual((await f.req("GET", `${url}/data`)).data, before);
  assert.equal(privateEdit.public_updates.length, 1);
  const logs = () => f.db.prepare("SELECT COUNT(*) n FROM activity WHERE job_id=?").get(job.id).n;
  const count = logs();
  assert.equal((await f.req("PATCH", path, { private_notes: "Gate code 7890" })).status, 200);
  assert.equal(logs(), count);
  f.advance();
  const scheduled = (await f.req("PATCH", path, { status: "scheduled", scheduled_date: "2026-11-10", arrival_start: "09:00", arrival_end: "11:00" })).data;
  assert.equal(scheduled.public_updates.length, 2); assert.equal(scheduled.public_updates[1].status, "scheduled");
  assert.notEqual(scheduled.public_updated_at, before.updated_at);
  f.advance();
  const waiting = (await f.req("PATCH", path, { status: "waiting_parts", customer_update: "  The replacement part is on order.  " })).data;
  assert.equal(waiting.public_updates.length, 3); assert.equal(waiting.public_updates[2].message, "The replacement part is on order.");
  assert.equal(waiting.scheduled_date, "2026-11-10");
  f.advance();
  const rescheduled = (await f.req("PATCH", path, { scheduled_date: "2026-11-12" })).data;
  assert.equal(rescheduled.public_updates.at(-1).message, "Appointment updated.");
  assert.equal((await f.req("PATCH", path, { contact_id: "ALPHA-other" })).status, 400);
  assert.equal((await f.req("PATCH", path, { quote_id: "other" })).status, 400);
  assert.equal((await f.req("PATCH", path, { customer_update: "x".repeat(5001) })).status, 400);
  const rawLog = JSON.stringify(f.db.prepare("SELECT * FROM activity WHERE job_id=?").all(job.id));
  assert.ok(!rawLog.includes("7890")); assert.ok(!rawLog.includes("replacement part"));
  assert.equal(f.providerCalls(), 0);
});

test("quote conversion is accepted-only, scoped to its customer and idempotent", async (t) => {
  const f = fixture(t), accepted = await f.quote();
  for (const status of ["draft", "sent", "declined"]) {
    const q = await f.quote(status);
    assert.equal((await f.req("POST", f.base(), { quote_id: q.id, title: "Installation", service_address: "Site" })).status, 409);
  }
  assert.equal((await f.req("POST", f.base("BETA"), { quote_id: accepted.id, title: "Installation", service_address: "Site" })).status, 404);
  assert.equal((await f.req("POST", f.base(), { quote_id: accepted.id, contact_id: "ALPHA-other", title: "Installation", service_address: "Site" })).status, 400);
  const result = await f.req("POST", f.base(), { quote_id: accepted.id, title: "Furnace installation", job_type: "installation", service_address: "20 Example Street" });
  assert.equal(result.status, 201, result.raw);
  const job = result.data;
  assert.equal(job.contact_id, accepted.contact_id); assert.equal(job.quote.reference, accepted.reference);
  assert.equal(job.quote.total_cents, accepted.total_cents); assert.equal(job.quote.status, "accepted");
  const again = await f.req("POST", f.base(), { quote_id: accepted.id });
  assert.equal(again.status, 200, again.raw); assert.equal(again.data.id, job.id);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE quote_id=?").get(accepted.id).n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity WHERE job_id=? AND kind='job_created'").get(job.id).n, 1);
  assert.throws(() => f.db.prepare("UPDATE jobs SET contact_id='ALPHA-other' WHERE id=?").run(job.id), /FOREIGN KEY/);
});

test("job edits never rewrite accepted quote terms or its frozen customer name", async (t) => {
  const f = fixture(t), quote = await f.quote();
  const before = f.db.prepare("SELECT * FROM quotes WHERE id=?").get(quote.id);
  f.db.prepare("UPDATE contacts SET name='Updated contact', notes='Another private note' WHERE id=?").run(quote.contact_id);
  const job = await f.share(await f.create({ quote_id: quote.id, job_type: "installation" }));
  assert.equal(job.contact_name, "ALPHA customer");
  f.advance();
  await f.req("PATCH", `${f.base()}/${job.id}`, { title: "Installation progress", description: "Ductwork connected.", status: "in_progress", private_notes: "Private work estimate" });
  assert.deepEqual(f.db.prepare("SELECT * FROM quotes WHERE id=?").get(quote.id), before);
  const data = (await f.req("GET", `${new URL(job.public_url).pathname}/data`)).data;
  assert.equal(data.customer_name, "ALPHA customer"); assert.equal(data.quote.reference, quote.reference);
  assert.equal(data.quote.public_url, quote.public_url); assert.equal(data.quote.total_cents, quote.total_cents);
  assert.deepEqual(Object.keys(data.quote).sort(), ["currency", "public_url", "reference", "total_cents"]);
});

test("public job data is explicitly whitelisted and reads create no tracking or status changes", async (t) => {
  const f = fixture(t), job = await f.share(await f.create({ description: "Shared work details", private_notes: "PRIVATE-WORK-NOTE" }));
  f.db.prepare("UPDATE businesses SET logo_url='/uploads/alpha.png' WHERE id='ALPHA'").run();
  const path = new URL(job.public_url).pathname, before = f.db.prepare("SELECT COUNT(*) n FROM activity").get().n;
  const first = await f.req("GET", `${path}/data`), second = await f.req("GET", `${path}/data`);
  assert.equal(first.status, 200); assert.deepEqual(first.data, second.data);
  assert.deepEqual(Object.keys(first.data).sort(), ["arrival_end", "arrival_start", "business", "customer_name", "description", "job_type", "mode", "public_updates", "quote", "reference", "scheduled_date", "service_address", "status", "time_zone", "title", "updated_at"]);
  assert.deepEqual(Object.keys(first.data.business).sort(), ["booking_url", "logo_url", "name", "phone"]);
  assert.equal(first.data.business.logo_url, `${path}/logo`); assert.equal(first.data.mode, "demo");
  for (const secret of ["PRIVATE-WORK-NOTE", "Private customer note", "customer@example.test", "+14165550300", "ALPHA-customer", '"business_id"', '"contact_id"', '"private_notes"', '"public_token"']) assert.ok(!first.raw.includes(secret), secret);
  assert.equal(first.headers["cache-control"], "no-store"); assert.equal(first.headers["referrer-policy"], "no-referrer");
  assert.equal(first.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity").get().n, before);
  const head = await f.req("HEAD", `${path}/data`);
  assert.equal(head.status, 200); assert.equal(head.raw, "");
});

test("customer job links allow reads only and cannot edit, accept or guess jobs", async (t) => {
  const f = fixture(t), job = await f.share(await f.create()), path = new URL(job.public_url).pathname;
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    assert.equal((await f.req(method, path, { status: "completed" })).status, 404);
    assert.equal((await f.req(method, `${path}/data`, { private_notes: "exfiltrate" })).status, 404);
  }
  assert.equal((await f.req("POST", `${path}/respond`, { decision: "accepted" })).status, 404);
  assert.equal((await f.req("GET", `/j/${"a".repeat(64)}/data`)).status, 404);
  assert.equal((await f.req("GET", "/j/not-a-token/data")).status, 404);
  assert.equal((await f.req("GET", `/j/${job.id}/data`)).status, 404);
  const owner = (await f.req("GET", `${f.base()}/${job.id}`)).data;
  assert.equal(owner.status, "awaiting_scheduling"); assert.equal(owner.private_notes, "");
});

test("customer logo reads are scoped to a valid job capability and cannot traverse uploads", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "trades-job-logo-test-"));
  const alpha = join(directory, "alpha.png"), beta = join(directory, "beta.png");
  writeFileSync(alpha, "ALPHA logo image"); writeFileSync(beta, "BETA logo image");
  t.after(() => { rmSync(alpha); rmSync(beta); rmdirSync(directory); });
  const f = fixture(t, { uploadDir: directory });
  f.db.prepare("UPDATE businesses SET logo_url=? WHERE id=?").run("/uploads/alpha.png", "ALPHA");
  f.db.prepare("UPDATE businesses SET logo_url=? WHERE id=?").run("/uploads/beta.png", "BETA");
  const job = await f.share(await f.create()), path = new URL(job.public_url).pathname;
  const response = await f.req("GET", `${path}/logo`);
  assert.equal(response.status, 200); assert.match(response.headers["content-type"], /image\/png/);
  assert.equal(response.raw, "ALPHA logo image"); assert.ok(!response.raw.includes("BETA"));
  assert.equal((await f.req("GET", `/j/${"a".repeat(64)}/logo`)).status, 404);
  f.db.prepare("UPDATE businesses SET logo_url='/uploads/../outside.png' WHERE id='ALPHA'").run();
  assert.equal((await f.req("GET", `${path}/logo`)).status, 404);
  await f.req("POST", `${f.base()}/${job.id}/revoke-link`, {});
  assert.equal((await f.req("GET", `${path}/logo`)).status, 404);
});

test("link sharing is deliberate, idempotent, revocable and renewable with safe activity", async (t) => {
  const f = fixture(t), job = await f.create({ private_notes: "Secret private note" }), path = `${f.base()}/${job.id}`;
  const storedBefore = f.db.prepare("SELECT public_token FROM jobs WHERE id=?").get(job.id);
  assert.equal(storedBefore.public_token, null);
  let shared = await f.share(job), first = shared.public_url;
  assert.match(new URL(first).pathname, /^\/j\/[a-f0-9]{64}$/);
  assert.equal((await f.share(job)).public_url, first);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity WHERE job_id=? AND kind='job_link'").get(job.id).n, 1);
  assert.equal((await f.req("POST", `${f.base("BETA")}/${job.id}/revoke-link`, {})).status, 404);
  const revoked = await f.req("POST", `${path}/revoke-link`, {});
  assert.equal(revoked.data.public_url, null); assert.equal(revoked.data.link_enabled, false);
  assert.equal((await f.req("GET", `${new URL(first).pathname}/data`)).status, 404);
  await f.req("POST", `${path}/revoke-link`, {});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity WHERE job_id=? AND kind='job_link'").get(job.id).n, 2);
  shared = await f.share(job); assert.notEqual(shared.public_url, first);
  const rotated = (await f.req("POST", `${path}/rotate-link`, {})).data;
  assert.notEqual(rotated.public_url, shared.public_url);
  assert.equal((await f.req("GET", `${new URL(shared.public_url).pathname}/data`)).status, 404);
  assert.equal((await f.req("GET", `${new URL(rotated.public_url).pathname}/data`)).status, 200);
  const log = JSON.stringify(f.db.prepare("SELECT * FROM activity WHERE job_id=?").all(job.id));
  for (const secret of [new URL(first).pathname.split("/").pop(), rotated.public_url, "Secret private note"]) assert.ok(!log.includes(secret));
  assert.equal(rotated.public_updated_at, job.public_updated_at);
});

test("job filters stay within the business and reject unsupported statuses or types", async (t) => {
  const f = fixture(t);
  await f.create(); await f.create({ job_type: "installation", status: "in_progress" }); await f.create({}, "BETA");
  assert.equal((await f.req("GET", `${f.base()}?job_type=installation`)).data.length, 1);
  assert.equal((await f.req("GET", `${f.base()}?status=awaiting_scheduling`)).data.length, 1);
  assert.equal((await f.req("GET", `${f.base()}?status=in_progress&job_type=service`)).data.length, 0);
  assert.equal((await f.req("GET", `${f.base()}?status=paid`)).status, 400);
  assert.equal((await f.req("GET", `${f.base()}?job_type=invoice`)).status, 400);
});

test("sharing rejects unsafe origins and live customer links require HTTPS", async (t) => {
  for (const origin of ["http://jobs.example.test", "https://user:password@jobs.example.test", "https://jobs.example.test/path", "https://jobs.example.test?token=private"]) {
    const f = fixture(t, { origin }), job = await f.create();
    assert.equal((await f.req("POST", `${f.base()}/${job.id}/share`, {})).status, 503, origin);
    assert.equal(f.db.prepare("SELECT public_token FROM jobs WHERE id=?").get(job.id).public_token, null);
  }
  const local = fixture(t, { origin: "http://127.0.0.1:3000" });
  assert.ok((await local.share(await local.create())).public_url.startsWith("http://127.0.0.1:3000/j/"));
  const live = fixture(t, { origin: "http://127.0.0.1:3000", smsMode: "twilio" }), job = await live.create();
  assert.equal((await live.req("POST", `${live.base()}/${job.id}/share`, {})).status, 503);
});

test("jobs and public update history persist through additive database reopen", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "trades-jobs-test-")), path = join(directory, "suite.sqlite");
  let db = openDatabase(path);
  t.after(() => {
    db.close();
    // Only these explicit test-created files are removed, without recursion.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) rmSync(file);
    rmdirSync(directory);
  });
  const f = fixture(t, { db }), job = await f.share(await f.create());
  await f.req("PATCH", `${f.base()}/${job.id}`, { status: "in_progress", customer_update: "Work has started.", private_notes: "Private test" });
  db.close(); db = openDatabase(path);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
  assert.equal(db.prepare("SELECT private_notes FROM jobs WHERE business_id='ALPHA' AND id=?").get(job.id).private_notes, "Private test");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM job_updates WHERE business_id='ALPHA' AND job_id=?").get(job.id).n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM contacts").get().n, 4);
  assert.throws(() => db.prepare("UPDATE jobs SET business_id='BETA' WHERE id=?").run(job.id), /FOREIGN KEY/);
});

test("actual app protects job admin routes and keeps shared job data public and read-only", async (t) => {
  const keys = ["NODE_ENV", "HOST", "RENDER_EXTERNAL_URL", "ADMIN_ORIGIN", "PUBLIC_BASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "TRUST_PROXY_HOPS"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.ADMIN_PASSWORD = "synthetic-jobs-admin-password";
  const suite = createApp({ dbPath: ":memory:", smsMode: "demo", quotePublicOrigin: ORIGIN });
  t.after(() => { suite.close(); for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  seed(suite.db, new Date().toISOString());
  const headers = { host: "localhost", authorization: `Basic ${Buffer.from(`admin:${process.env.ADMIN_PASSWORD}`).toString("base64")}` };
  const base = "/api/businesses/ALPHA/jobs";
  assert.equal((await request(suite.app, "GET", base)).status, 401);
  const made = await request(suite.app, "POST", base, { contact_id: "ALPHA-customer", title: "Furnace repair", service_address: "10 Example Street" }, headers);
  assert.equal(made.status, 201, made.raw);
  assert.equal((await request(suite.app, "PATCH", `${base}/${made.data.id}`, { status: "completed" }, { ...headers, origin: "https://evil.example" })).status, 403);
  assert.equal((await request(suite.app, "PATCH", `${base}/${made.data.id}`, [], headers)).status, 400);
  const shared = await request(suite.app, "POST", `${base}/${made.data.id}/share`, {}, headers);
  assert.equal(shared.status, 200, shared.raw);
  const path = new URL(shared.data.public_url).pathname;
  assert.equal((await request(suite.app, "GET", `${path}/data`)).status, 200);
  assert.equal((await request(suite.app, "POST", `${path}/data`, { status: "completed" })).status, 404);
  const unavailable = await request(suite.app, "GET", `/j/${"f".repeat(64)}`, undefined, { accept: "text/html" });
  assert.equal(unavailable.status, 404); assert.match(unavailable.headers["content-type"], /text\/html/);
  assert.match(unavailable.raw, /Terms draft/); assert.match(unavailable.raw, /Privacy draft/);
  const apiError = await request(suite.app, "GET", `/j/${"f".repeat(64)}/data`);
  assert.equal(apiError.status, 404); assert.match(apiError.headers["content-type"], /application\/json/);
});
