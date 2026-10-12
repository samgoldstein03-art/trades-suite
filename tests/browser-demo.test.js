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
