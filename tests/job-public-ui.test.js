import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(new URL("../public/job.js", import.meta.url), "utf8");
const pureSource = source.split("async function jobPublicRequest")[0];
function renderer(href = "https://shop.example/j/sample-link") {
  const context = vm.createContext({ URL, location: { href } });
  vm.runInContext(`${pureSource}\nglobalThis.render = jobPublicMarkup; globalThis.unavailable = jobPublicUnavailableMarkup; globalThis.loading = jobPublicLoadingMarkup; globalThis.formatDate = jobPublicDate; globalThis.formatTime = jobPublicTime;`, context);
  return context;
}
function sampleJob(overrides = {}) {
  return {
    reference: "J-1001", title: "Furnace service", job_type: "service", status: "scheduled",
    description: "Inspect and service the furnace.", service_address: "10 Example Road",
    scheduled_date: "2026-11-09", arrival_start: "09:00", arrival_end: "11:30", time_zone: "America/Toronto",
    customer_name: "Sample customer", business: { name: "Sample business", phone: "+14165550199", booking_url: "https://shop.example/book", logo_url: "/j/sample-link/logo" },
    mode: "demo", public_updates: [{ id: "update-1", message: "Your visit is booked.", status: "scheduled", created_at: "2026-11-05T15:00:00.000Z" }],
    updated_at: "2026-11-05T15:00:00.000Z", ...overrides,
  };
}
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function pageHarness(fetch) {
  const container = { markup: "Loading", writes: 0, get innerHTML() { return this.markup; }, set innerHTML(value) { this.markup = value; this.writes++; }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const listeners = {};
  const intervals = [];
  const document = { hidden: false, title: "Your job", querySelector: () => container, addEventListener: (name, listener) => { listeners[name] = listener; } };
  const context = vm.createContext({ URL, location: { pathname: "/j/sample-link/", href: "https://shop.example/j/sample-link/" }, fetch, document, setInterval: (callback, delay) => { intervals.push({ callback, delay }); } });
  vm.runInContext(`${source}\nglobalThis.loadJob = jobPublicLoad;`, context);
  return { context, container, document, listeners, intervals };
}

test("customer job page shows only recorded job details and a read-only quote link", () => {
  const html = renderer().render(sampleJob({ quote: { reference: "Q-102", total_cents: 129900, currency: "CAD", public_url: "/q/sample-quote" } }));
  assert.match(html, /Furnace service/);
  assert.match(html, /10 Example Road/);
  assert.match(html, /9:00 am to 11:30 am/);
  assert.match(html, /America\/Toronto/);
  assert.match(html, /Accepted quote/);
  assert.match(html, /\$1,299\.00 CAD/);
  assert.match(html, /href="https:\/\/shop\.example\/q\/sample-quote"/);
  assert.doesNotMatch(html, /<form|<input|<select|<textarea|<button|data-decision|Accept quote|Decline|\d+%|payment/i);
});

test("customer job markup explicitly omits internal fields and private contact details", () => {
  const html = renderer().render(sampleJob({
    private_notes: "PRIVATE JOB NOTE", contact_phone: "PRIVATE PHONE", contact_email: "PRIVATE EMAIL", contact_notes: "PRIVATE CONTACT NOTE", contact_id: "PRIVATE CONTACT ID", business_id: "PRIVATE BUSINESS ID",
    contact: { name: "PRIVATE CONTACT RECORD", phone: "PRIVATE NESTED PHONE" }, public_token: "PRIVATE TOKEN FIELD",
    public_updates: [{ status: "scheduled", message: "Published message", created_at: "2026-11-05T15:00:00.000Z", private_notes: "PRIVATE UPDATE NOTE" }],
  }));
  assert.doesNotMatch(html, /PRIVATE/);
  assert.match(html, /Published message/);
});

test("all customer, business, work and update text is escaped", () => {
  const payload = '<img src=x onerror="bad()">';
  const html = renderer().render(sampleJob({ title: payload, reference: payload, customer_name: payload, description: payload, service_address: payload, business: { name: payload, phone: payload }, public_updates: [{ status: "scheduled", message: payload, created_at: payload }] }));
  assert.doesNotMatch(html, /<img|onerror="bad\(\)"|datetime="<|<script/i);
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
});

test("unsafe URLs and invalid business phone links are never rendered", () => {
  for (const url of ["javascript:alert(1)", "data:image/svg+xml,<svg onload=bad()>", "https://name:secret@shop.example", "file:///C:/private"]) {
    const html = renderer().render(sampleJob({ business: { name: "Sample business", logo_url: url, booking_url: url, phone: "javascript:bad()" }, quote: { public_url: url, reference: "Q-1" } }));
    assert.doesNotMatch(html, /<img|href=|Accepted quote|javascript:|data:image|secret@/);
  }
});

test("explicit local sample preview allows only a same-file quote hash link", () => {
  const href = "file:///C:/previews/Tradesuite%20Demo.html";
  const render = renderer(href);
  const quote = { reference: "Q-102", total_cents: 129900, currency: "CAD", public_url: `${href}#quote/demo-quote_102` };
  assert.doesNotMatch(render.render(sampleJob({ quote })), /Accepted quote|View quote/);
  const html = render.render(sampleJob({ quote }), { localPreview: true });
  assert.match(html, /href="file:\/\/\/C:\/previews\/Tradesuite%20Demo\.html#quote\/demo-quote_102"/);
  assert.match(html, /Accepted quote/);
  assert.doesNotMatch(render.render(sampleJob({ mode: "live", quote }), { localPreview: true }), /Accepted quote|View quote/);
  assert.doesNotMatch(render.render(sampleJob({ quote }), { localPreview: "true" }), /Accepted quote|View quote/);
  for (const public_url of ["file:///C:/other.html#quote/demo-quote_102", `${href}?private=1#quote/demo-quote_102`, `${href}#job/demo-quote_102`, `${href}#quote/demo%2Fquote`, "file://other-host/C:/previews/Tradesuite%20Demo.html#quote/demo-quote_102", "javascript:alert(1)", "data:text/html,bad"]) {
    assert.doesNotMatch(render.render(sampleJob({ quote: { ...quote, public_url } }), { localPreview: true }), /Accepted quote|View quote/);
  }
  const privateAsset = render.render(sampleJob({ quote, business: { name: "Sample business", booking_url: `${href}#quote/demo-quote_102`, logo_url: href } }), { localPreview: true });
  assert.doesNotMatch(privateAsset, /<img|Book a time/);
});

test("unbooked jobs do not invent a visit, arrival window or progress percentage", () => {
  const html = renderer().render(sampleJob({ status: "awaiting_scheduling", scheduled_date: null, arrival_start: "09:00", arrival_end: "11:00", public_updates: [], updated_at: null }));
  assert.match(html, /Waiting for booking/);
  assert.match(html, /No appointment has been booked yet/);
  assert.match(html, /Not booked yet/);
  assert.match(html, /Arrival window<\/dt><dd>Not set yet/);
  assert.match(html, /No updates have been shared yet/);
  assert.doesNotMatch(html, /9:00 am|11:00 am|Last updated|\d+%|estimated|on the way/i);
});

test("date and arrival display preserve local calendar values across extreme browser time zones", () => {
  for (const timeZone of ["Pacific/Honolulu", "Pacific/Kiritimati"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import vm from 'node:vm'; const context = vm.createContext({URL, location: {href: 'https://shop.example/j/link'}}); vm.runInContext(${JSON.stringify(pureSource)} + '\\nglobalThis.result = [jobPublicDate("2026-01-01"),jobPublicTime("00:30"),jobPublicTime("23:45")];', context); process.stdout.write(JSON.stringify(context.result));`], { env: { ...process.env, TZ: timeZone }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const values = JSON.parse(child.stdout);
    assert.match(values[0], /January 1, 2026/);
    assert.equal(values[1], "12:30 am");
    assert.equal(values[2], "11:45 pm");
  }
});

test("invalid date, time and timezone values produce no invalid-date artifacts", () => {
  const render = renderer();
  assert.equal(render.formatDate("2026-02-30"), "");
  assert.equal(render.formatDate("2026-2-5"), "");
  assert.equal(render.formatTime("24:01"), "");
  const html = render.render(sampleJob({ scheduled_date: "bad", time_zone: "<bad>", updated_at: "bad", public_updates: [{ status: "scheduled", created_at: "bad", message: "An actual update" }] }));
  assert.doesNotMatch(html, /Invalid Date|<bad>|datetime="bad"/);
  assert.match(html, /Not booked yet/);
});

test("all job states have plain labels and unknown states are safely handled", () => {
  const render = renderer();
  for (const [status, label] of Object.entries({ awaiting_scheduling: "Waiting for booking", scheduled: "Booked", waiting_parts: "Waiting for parts", in_progress: "Work underway", completed: "Completed", follow_up: "Follow-up needed", cancelled: "Cancelled" })) {
    assert.match(render.render(sampleJob({ status })), new RegExp(`<h2 id="customer-job-status-heading">${label}</h2>`));
  }
  const html = render.render(sampleJob({ status: '__proto__" onclick="bad()' }));
  assert.match(html, /Status unavailable/);
  assert.doesNotMatch(html, /onclick|__proto__/);
});

test("published update history is latest-first and never modified in place", () => {
  const updates = [{ status: "scheduled", created_at: "2026-11-05T15:00:00.000Z", message: "Older published message" }, { status: "in_progress", created_at: "2026-11-06T15:00:00.000Z", message: "Latest published message" }];
  const html = renderer().render(sampleJob({ public_updates: updates }));
  assert.ok(html.indexOf("Latest published message") < html.indexOf("Older published message"));
  assert.equal(updates[0].message, "Older published message");
  assert.match(html, /datetime="2026-11-06T15:00:00.000Z"/);
});

test("sample notice appears only for demo data, with accessible loading and unavailable states", () => {
  const render = renderer();
  assert.match(render.render(sampleJob()), /Sample job · No real texts or emails are sent/);
  assert.doesNotMatch(render.render(sampleJob({ mode: "live" })), /Sample job|No real texts/);
  assert.match(render.loading(), /role="status"/);
  assert.match(render.loading(), /customer-job-skeleton/);
  assert.doesNotMatch(render.unavailable('<script>bad()</script>'), /<script>/);
  assert.match(render.unavailable("Try later", true), /data-job-public-retry/);
});

test("public HTML includes private-link safeguards, shared fonts and visibly draft legal links", () => {
  const html = fs.readFileSync(new URL("../public/job.html", import.meta.url), "utf8");
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /\/q\/assets\/fonts\.css/);
  assert.match(html, /\/q\/assets\/design-system\.css/);
  assert.match(html, /\/j\/assets\/job\.js/);
  assert.match(html, /href="\/terms">Terms draft/);
  assert.match(html, /href="\/privacy">Privacy draft/);
});

test("public job page loads and refreshes read-only data while visible", async () => {
  const calls = [];
  const page = pageHarness(async (path, options) => { calls.push({ path, options }); return response(200, sampleJob()); });
  await flush();
  assert.match(page.container.innerHTML, /Furnace service/);
  assert.equal(page.document.title, "Sample business | Your job");
  assert.equal(page.container.attributes["aria-busy"], "false");
  assert.equal(calls[0].path, "/j/sample-link/data");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.method, undefined);
  assert.equal(page.intervals[0].delay, 30000);
  page.document.hidden = true;
  page.intervals[0].callback();
  await flush();
  assert.equal(calls.length, 1);
  page.document.hidden = false;
  page.listeners.visibilitychange();
  await flush();
  assert.equal(calls.length, 2);
});

test("a revoked link clears previous job details and stops automatic refresh", async () => {
  let calls = 0;
  const page = pageHarness(async () => ++calls === 1 ? response(200, sampleJob()) : response(404, { error: "not available" }));
  await flush();
  assert.match(page.container.innerHTML, /10 Example Road/);
  page.intervals[0].callback();
  await flush();
  assert.match(page.container.innerHTML, /This job link isn’t available/);
  assert.doesNotMatch(page.container.innerHTML, /10 Example Road|Furnace service|Sample customer|data-job-public-retry/);
  assert.equal(page.document.title, "Job link unavailable | Tradesuite");
  page.intervals[0].callback();
  page.listeners.visibilitychange();
  await flush();
  assert.equal(calls, 2);
});

test("unchanged background checks preserve existing DOM links and changed status refreshes the page", async () => {
  let currentJob = sampleJob();
  const page = pageHarness(async () => response(200, currentJob));
  await flush();
  assert.equal(page.container.writes, 1);
  page.intervals[0].callback();
  await flush();
  assert.equal(page.container.writes, 1, "Unchanged job details must retain the DOM and any focused link");
  currentJob = sampleJob({ status: "completed", updated_at: "2026-11-09T17:00:00.000Z" });
  page.intervals[0].callback();
  await flush();
  assert.equal(page.container.writes, 2);
  assert.match(page.container.innerHTML, /id="customer-job-status-heading">Completed/);
});

test("network refresh failures hide stale job details and offer a retry", async () => {
  let calls = 0;
  const page = pageHarness(async () => { if (++calls === 2) throw new Error("network failure"); return response(200, sampleJob()); });
  await flush();
  page.intervals[0].callback();
  await flush();
  assert.doesNotMatch(page.container.innerHTML, /Furnace service|10 Example Road/);
  assert.match(page.container.innerHTML, /We couldn’t refresh/);
  assert.match(page.container.innerHTML, /data-job-public-retry/);
  page.listeners.click({ target: { closest: () => ({}) } });
  await flush();
  assert.match(page.container.innerHTML, /Furnace service/);
});

test("an older in-flight success cannot restore details after a newer revocation", async () => {
  let finishOldRequest;
  let calls = 0;
  const page = pageHarness(() => ++calls === 1 ? new Promise((resolve) => { finishOldRequest = resolve; }) : Promise.resolve(response(404, {})));
  await page.context.loadJob();
  assert.match(page.container.innerHTML, /This job link isn’t available/);
  finishOldRequest(response(200, sampleJob()));
  await flush();
  assert.doesNotMatch(page.container.innerHTML, /Furnace service|10 Example Road/);
  assert.equal(page.container.attributes["aria-busy"], "false");
});
