import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { createBrowserDemo, buildBrowserDemo } from "../scripts/build-browser-demo.js";

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}
const post = (body) => ({ method: "POST", body: JSON.stringify(body) });

async function draftQuote(api, base, customer) {
  return api(`${base}/quotes`, post({ contact_id: customer.id, line_items: [{ description: "Replace kitchen tap", quantity: 2, unit_price: 125.25 }], tax_rate: 13, expiry_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), notes: "Parts included." }));
}

test("browser quotes send, open and accept across tabs while preserving business isolation", async () => {
  const saved = storage();
  const api = createBrowserDemo(saved);
  const [business, other] = await api("/api/businesses");
  const base = `/api/businesses/${business.id}`;
  const customer = (await api(`${base}/contacts`))[0];
  const draft = await draftQuote(api, base, customer);
  assert.equal(draft.total_cents, 28307);
  await assert.rejects(api(`/api/businesses/${other.id}/quotes/${draft.id}`), /not found/);
  const sent = await api(`${base}/quotes/${draft.id}/send`, post({ channels: ["sms", "email"] }));
  assert.equal(sent.status, "sent");
  assert.equal(sent.deliveries.length, 2);
  assert.equal((await api(`${base}/dashboard`)).quotes_awaiting_response.length, 1);
  assert.ok((await api(`${base}/activity`)).some((entry) => entry.quote_id === draft.id && entry.kind === "sms_sent" && entry.body.endsWith(`${business.name}\nReply STOP to opt out`)));
  const token = sent.public_url.split("#quote/")[1];
  const customerTab = createBrowserDemo(saved);
  const viewed = await customerTab(`/q/${token}/data`);
  assert.equal(viewed.status, "viewed");
  assert.equal(viewed.customer_name, customer.name);
  assert.equal(viewed.contact_id, undefined);
  await customerTab(`/q/${token}/respond`, post({ decision: "accepted" }));
  assert.equal((await api(`${base}/quotes/${draft.id}`)).status, "accepted");
  assert.equal((await api(`${base}/quotes?status=accepted`)).length, 1);
  assert.equal((await api(`${base}/dashboard`)).quotes_awaiting_response.length, 0);
  assert.equal((await api(`${base}/quotes/demo/advance`, post({ days: 5 }))).sent, 0);
  await assert.rejects(customerTab(`/q/${token}/respond`, post({ decision: "declined" })), /no longer/);
});

test("browser quote reminders run at two and five days once, and cancellation stops them", async () => {
  const api = createBrowserDemo(storage());
  const [business] = await api("/api/businesses");
  const base = `/api/businesses/${business.id}`;
  const customer = (await api(`${base}/contacts`))[0];
  const draft = await draftQuote(api, base, customer);
  await api(`${base}/quotes/${draft.id}/send`, post({ channels: ["sms"] }));
  assert.equal((await api(`${base}/quotes/demo/advance`, post({ days: 2 }))).sent, 1);
  assert.equal((await api(`${base}/quotes/${draft.id}`)).nudge_count, 1);
  assert.equal((await api(`${base}/quotes/demo/advance`, post({ days: 3 }))).sent, 1);
  assert.equal((await api(`${base}/quotes/demo/advance`, post({ days: 5 }))).sent, 0);
  assert.equal((await api(`${base}/quotes/${draft.id}`)).nudge_count, 2);
  const stopped = await draftQuote(api, base, customer);
  await api(`${base}/quotes/${stopped.id}/send`, post({ channels: ["sms"] }));
  await api(`${base}/quotes/${stopped.id}/cancel-follow-ups`, post({}));
  assert.equal((await api(`${base}/quotes/demo/advance`, post({ days: 5 }))).sent, 0);
});

test("browser quotes skip stale reminders after downtime and do not expose unsent drafts", async () => {
  const saved = storage();
  const api = createBrowserDemo(saved);
  const [business] = await api("/api/businesses");
  const base = `/api/businesses/${business.id}`;
  const customer = (await api(`${base}/contacts`))[0];
  const draft = await draftQuote(api, base, customer);
  const stored = JSON.parse(saved.getItem("tradesuite-browser-demo-v1"));
  const token = stored.quotes[0].token;
  await assert.rejects(api(`/q/${token}/data`), /not found/);
  await api(`${base}/quotes/${draft.id}/send`, post({ channels: ["sms"] }));
  assert.equal((await api(`${base}/quotes/demo/advance`, post({ days: 5 }))).sent, 1);
  const delivered = await api(`${base}/quotes/${draft.id}`);
  assert.equal(delivered.deliveries.find((d) => d.kind === "nudge_2").status, "skipped");
  assert.equal(delivered.nudge_count, 1);
});

test("browser quote emails include an unsubscribe link and both channels honor its business-scoped contact choice", async () => {
  const saved = storage();
  const api = createBrowserDemo(saved);
  const [business, other] = await api("/api/businesses");
  const base = `/api/businesses/${business.id}`;
  const otherBase = `/api/businesses/${other.id}`;
  const customer = (await api(`${base}/contacts`)).at(-1);
  const samePhoneCustomer = await api(`${base}/contacts`, post({ name: "Another household member", phone: customer.phone, email: "household@example.com", sms_consent: true }));
  const otherCustomer = await api(`${otherBase}/contacts`, post({ name: customer.name, phone: customer.phone, email: customer.email, sms_consent: true }));
  const draft = await draftQuote(api, base, customer);
  const sent = await api(`${base}/quotes/${draft.id}/send`, post({ channels: ["email"] }));
  const delivery = sent.deliveries[0];
  assert.equal(delivery.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const unsubscribeUrl = delivery.headers["List-Unsubscribe"].slice(1, -1);
  assert.match(unsubscribeUrl, /^https:\/\/demo\.example\.test\/#unsubscribe\//);
  const token = new URL(unsubscribeUrl).hash.slice("#unsubscribe/".length);
  const email = (await api(`${base}/activity`)).find((entry) => entry.quote_id === draft.id && entry.kind === "email_sent");
  assert.ok(email.body.endsWith(`Unsubscribe: ${unsubscribeUrl}`));
  const preferencesPath = `/q/unsubscribe/${token}`;
  assert.deepEqual(await api(`${preferencesPath}/data`), { business_name: business.name, unsubscribed: false });
  assert.equal((await api(`${base}/contacts`)).find((c) => c.id === customer.id).opted_out, false, "link scanners must not unsubscribe on a GET");
  const customerTab = createBrowserDemo(saved);
  assert.equal((await customerTab(preferencesPath, post({ "List-Unsubscribe": "One-Click" }))).unsubscribed, true);
  await customerTab(preferencesPath, post({}));
  const reloaded = createBrowserDemo(saved);
  const opted = (await reloaded(`${base}/contacts`)).find((c) => c.id === customer.id);
  assert.equal(opted.quote_email_opted_out, true);
  assert.equal(opted.opted_out, true);
  assert.equal((await reloaded(`${base}/activity`)).filter((entry) => entry.kind === "contact_unsubscribed").length, 1);
  assert.equal((await reloaded(`${base}/contacts`)).find((c) => c.id === samePhoneCustomer.id).opted_out, false, "an email choice applies to this contact only");
  await assert.rejects(reloaded(`${base}/quotes/${draft.id}/send`, post({ channels: ["sms"] })), /opted out/);
  const futureDraft = await draftQuote(reloaded, base, customer);
  await assert.rejects(reloaded(`${base}/quotes/${futureDraft.id}/send`, post({ channels: ["email"] })), /opted out/);
  await assert.rejects(reloaded(`${base}/requests`, post({ contact_id: customer.id })), /permission/);
  assert.equal((await reloaded(`${base}/quotes/demo/advance`, post({ days: 5 }))).sent, 0);
  const otherDraft = await draftQuote(reloaded, otherBase, otherCustomer);
  assert.equal((await reloaded(`${otherBase}/quotes/${otherDraft.id}/send`, post({ channels: ["email", "sms"] }))).deliveries.length, 2);
  await assert.rejects(reloaded("/q/unsubscribe/unknown/data"), /not found/);
});

test("browser SMS opt-outs also block quote emails and contact edits cannot erase email unsubscribe", async () => {
  const saved = storage();
  const api = createBrowserDemo(saved);
  const [business] = await api("/api/businesses");
  const base = `/api/businesses/${business.id}`;
  const [customer] = await api(`${base}/contacts`);
  const draft = await draftQuote(api, base, customer);
  const stored = JSON.parse(saved.getItem("tradesuite-browser-demo-v1"));
  stored.contacts.find((c) => c.id === customer.id).opted_out = true;
  saved.setItem("tradesuite-browser-demo-v1", JSON.stringify(stored));
  await assert.rejects(api(`${base}/quotes/${draft.id}/send`, post({ channels: ["email"] })), /opted out/);
  const clearedSms = JSON.parse(saved.getItem("tradesuite-browser-demo-v1"));
  const storedCustomer = clearedSms.contacts.find((c) => c.id === customer.id);
  storedCustomer.opted_out = false;
  storedCustomer.quote_email_opted_out = true;
  saved.setItem("tradesuite-browser-demo-v1", JSON.stringify(clearedSms));
  await api(`${base}/contacts/${customer.id}`, { method: "PATCH", body: JSON.stringify({ email: "updated@example.com", phone: "+14165550999", quote_email_opted_out: false, opted_out: false, sms_consent: true }) });
  const updated = (await api(`${base}/contacts`)).find((c) => c.id === customer.id);
  assert.equal(updated.quote_email_opted_out, true);
  assert.equal(updated.opted_out, true);
  await assert.rejects(api(`${base}/quotes/${draft.id}/send`, post({ channels: ["sms", "email"] })), /opted out/);
});

test("standalone browser demo supports business/customer/request/nudge/done and reload", async () => {
  const saved = storage();
  const api = createBrowserDemo(saved);
  const business = await api("/api/businesses", post({ name: "Sample Heating", phone: "+14165550300", google_review_url: "https://example.com/sample/review", sms_key: "SAMPLE" }));
  const base = `/api/businesses/${business.id}`;
  const contact = await api(`${base}/contacts`, post({ name: "Sample Customer", phone: "+14165550301", tags: ["customer"], sms_consent: true }));
  const preview = await api(`${base}/requests/preview`, post({ contact_id: contact.id }));
  assert.ok(preview.body.includes(business.google_review_url));
  assert.ok(preview.body.endsWith("Sample Heating\nReply STOP to opt out"));
  const request = await api(`${base}/requests`, post({ contact_id: contact.id }));
  assert.equal(request.status, "sent");
  assert.equal(new Date(request.nudge_due_at) - new Date(request.sent_at), 72 * 60 * 60 * 1000);
  assert.equal((await api(`${base}/dashboard`)).awaiting_nudge, 1);
  assert.equal((await api(`${base}/demo/advance`, post({ days: 3 }))).nudged, 1);
  assert.equal((await api(`${base}/demo/advance`, post({ days: 3 }))).nudged, 0);
  assert.equal((await api(`${base}/requests`))[0].status, "nudged");
  await api(`${base}/requests/${request.id}/done`, post({}));
  const reloaded = createBrowserDemo(saved);
  assert.equal((await reloaded(`${base}/requests`))[0].status, "done");
  assert.equal((await reloaded(`${base}/dashboard`)).completed, 1);
  const activity = await reloaded(`${base}/activity`);
  assert.equal(activity.filter((entry) => entry.kind === "sms_sent").length, 2);
  assert.equal(activity.filter((entry) => entry.kind === "status_changed").length, 3);
});

test("standalone browser demo keeps businesses separate and stops completed reminders", async () => {
  const api = createBrowserDemo(storage());
  const [harbor, summit] = await api("/api/businesses");
  const harborPath = `/api/businesses/${harbor.id}`;
  const summitPath = `/api/businesses/${summit.id}`;
  const contact = (await api(`${harborPath}/contacts`)).at(-1);
  await assert.rejects(api(`${summitPath}/requests`, post({ contact_id: contact.id })), /for this business/);
  const request = await api(`${harborPath}/requests`, post({ contact_id: contact.id }));
  await api(`${harborPath}/requests/${request.id}/done`, post({}));
  const before = (await api(`${harborPath}/activity`)).filter((x) => x.contact_id === contact.id).length;
  await api(`${harborPath}/demo/advance`, post({ days: 3 }));
  assert.equal((await api(`${harborPath}/activity`)).filter((x) => x.contact_id === contact.id).length, before);
  assert.equal((await api(`${summitPath}/dashboard`)).total_requests, 0);
  assert.equal((await api(`${summitPath}/activity`)).filter((x) => x.kind === "sms_sent").length, 0);
});

test("browser demo works when storage is unavailable and generated frontend requires no network", async () => {
  const api = createBrowserDemo({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  assert.equal((await api("/api/businesses")).length, 2);
  const temporary = mkdtempSync(join(tmpdir(), "tradesuite-browser-demo-test-"));
  try {
    const html = readFileSync(buildBrowserDemo(join(temporary, "demo.html")), "utf8");
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(html.includes("Browser demo · Sample data only."));
    assert.ok(!html.includes("await fetch("));
    assert.ok(!/<script[^>]+src=/.test(html));
    assert.ok(!/<link[^>]+href=/.test(html));
    const embeddedScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Script(embeddedScript));
  } finally { unlinkSync(join(temporary, "demo.html")); rmdirSync(temporary); }
});

test("browser demo reports its latest follow-up check without inventing failed texts", async () => {
  const api = createBrowserDemo(storage());
  const [business] = await api("/api/businesses");
  const path = `/api/businesses/${business.id}`;
  const before = Date.now();
  const dashboard = await api(`${path}/dashboard`);
  assert.ok(Date.parse(dashboard.worker_last_checked_at) >= before);
  assert.ok(Date.parse(dashboard.worker_last_checked_at) <= Date.now());
  assert.deepEqual(dashboard.attention_needed, []);
  const request = (await api(`${path}/requests`)).find((r) => r.status === "sent");
  const activityBefore = (await api(`${path}/activity`)).length;
  await assert.rejects(api(`${path}/requests/${request.id}/retry-nudge`, post({ contact_id: request.contact_id })), /no failed follow-ups/);
  assert.equal((await api(`${path}/activity`)).length, activityBefore);
});

// Run the real render and submit functions without starting the app or opening
// a socket. The stub only supplies the dialog controls that these functions use.
const frontendFunctions = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
  .split('document.addEventListener("click"')[0];
const frontendState = {
  business: { id: "business-1", name: "Sample Heating" },
  businesses: [{ id: "business-1", name: "Sample Heating" }],
  config: { sms_mode: "live" }, contacts: [], requests: [], activity: [],
  dashboard: {
    worker_last_checked_at: "2026-10-12T12:00:00.000Z",
    attention_needed: [
      { id: "failed-1", contact_name: "Casey", nudge_error: "The text was rejected.", retry_allowed: true },
      { id: "unknown-1", contact_name: "Jamie", nudge_error: "Delivery could not be confirmed.", retry_allowed: false, retry_blocked_reason: "Check Twilio before sending again. <No duplicate>" },
    ],
  },
};

test("quote send dialog disables both channels when the customer unsubscribed", async () => {
  const content = { innerHTML: "" };
  const modal = { showModal() {} };
  const form = { addEventListener() {} };
  const context = {
    document: { querySelector: (selector) => ({ "#modal": modal, "#modal-content": content, "#dialog-form": form })[selector] },
    quoted: { id: "q1", status: "draft", contact_id: "c1", contact_name: "Jamie", total_cents: 10000, currency: "CAD", sendable_channels: ["sms", "email"] },
  };
  new Script(`${frontendFunctions}\nstate = ${JSON.stringify(frontendState)};
    state.contacts = [{ id: "c1", phone: "+14165550123", email: "jamie@example.com", sms_consent: true, opted_out: false, quote_email_opted_out: true }];
    api = async () => quoted;`).runInNewContext(context);
  await new Script('quoteSendModal("q1");').runInNewContext(context);
  assert.match(content.innerHTML, /value="sms" disabled/);
  assert.match(content.innerHTML, /value="email" disabled/);
  assert.equal((content.innerHTML.match(/This customer has opted out of messages\./g) || []).length, 2);
  assert.match(content.innerHTML, /Every quote email includes an unsubscribe link/);
});

test("browser unsubscribe page waits for confirmation, then shows the immediate result", async () => {
  const main = { innerHTML: "" };
  const context = {
    document: { querySelector: () => main }, location: { hash: "#unsubscribe/token" }, calls: [],
  };
  new Script(`${frontendFunctions}\napi = async (path, options) => { calls.push({ path, options }); return { business_name: "Business <sample>", unsubscribed: options.method === "POST" }; };`).runInNewContext(context);
  await new Script('renderBrowserUnsubscribe("token");').runInNewContext(context);
  assert.equal(context.calls[0].path, "/q/unsubscribe/token/data");
  assert.equal(context.calls[0].options.method, undefined);
  assert.match(main.innerHTML, /Stop messages from Business &lt;sample&gt;\?/);
  assert.match(main.innerHTML, /data-action="confirm-email-unsubscribe"/);
  await new Script('renderBrowserUnsubscribe("token", true);').runInNewContext(context);
  assert.equal(context.calls[1].path, "/q/unsubscribe/token");
  assert.equal(context.calls[1].options.method, "POST");
  assert.match(main.innerHTML, /You’re unsubscribed/);
  assert.match(main.innerHTML, /Texts and quote emails from Business &lt;sample&gt; are paused/);
  assert.ok(!main.innerHTML.includes('data-action="confirm-email-unsubscribe"'));
});

test("dashboard keeps failed nudges visible and disables uncertain retries with a reason", () => {
  const html = new Script(`${frontendFunctions}\nstate = ${JSON.stringify(frontendState)}; dashboardPage();`).runInNewContext({});
  assert.match(html, /Attention needed/);
  assert.match(html, /The text was rejected\./);
  assert.match(html, /data-action="retry-nudge" data-id="failed-1" >Retry nudge/);
  assert.match(html, /data-action="retry-nudge" data-id="unknown-1" disabled>Retry nudge/);
  assert.ok(html.includes("Check Twilio before sending again. &lt;No duplicate&gt;"));
  assert.match(html, /Follow-ups last checked at <time datetime="2026-10-12T12:00:00.000Z">/);
  const demoHtml = new Script(`${frontendFunctions}\nstate = ${JSON.stringify(frontendState)}; state.dashboard.worker_last_checked_at = null; state.config.browser_demo = true; dashboardPage();`).runInNewContext({});
  assert.match(demoHtml, /Follow-ups have not been checked yet\./);
  assert.match(demoHtml, /Checks run while this page is open\./);
});

test("retry confirmation refreshes the dashboard and activity even when sending fails", async () => {
  const button = { disabled: false };
  let submit;
  const form = { querySelector: () => button, addEventListener: (_name, handler) => { submit = handler; } };
  const modal = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const content = { innerHTML: "" };
  const context = { document: { querySelector: (selector) => ({ "#modal": modal, "#modal-content": content, "#dialog-form": form })[selector] }, calls: [], notices: [], refreshCount: 0 };
  new Script(`${frontendFunctions}\nstate = ${JSON.stringify(frontendState)};
    api = async (path, options) => { calls.push({ path, options }); throw new Error("Delivery could not be confirmed."); };
    refresh = async () => { refreshCount++; state.dashboard.attention_needed[0].retry_allowed = false; };
    toast = (message, error) => notices.push({ message, error });
    retryNudgeModal("unknown-1");`).runInNewContext(context);
  assert.equal(modal.open, false, "blocked requests must not open a send confirmation");
  new Script('retryNudgeModal("failed-1");').runInNewContext(context);
  assert.equal(modal.open, true);
  assert.match(content.innerHTML, /Casey/);
  await submit({ preventDefault() {}, currentTarget: form });
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].path, "/api/businesses/business-1/requests/failed-1/retry-nudge");
  assert.equal(context.calls[0].options.method, "POST");
  assert.equal(context.calls[0].options.body, "{}");
  assert.equal(context.refreshCount, 1, "refresh reloads dashboard and activity after rejection");
  assert.equal(modal.open, false, "stale confirmation must close after rejection");
  assert.equal(context.notices[0].message, "Delivery could not be confirmed.");
  assert.equal(context.notices[0].error, true);
  new Script('retryNudgeModal("failed-1");').runInNewContext(context);
  assert.equal(modal.open, false, "updated retry eligibility must be honored");
});
