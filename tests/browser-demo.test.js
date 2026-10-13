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
