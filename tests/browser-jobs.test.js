import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserDemo } from "../scripts/build-browser-demo.js";

const post = (body = {}) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body) => ({ method: "PATCH", body: JSON.stringify(body) });
async function fixture() {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const api = createBrowserDemo(storage);
  const [business, other] = await api("/api/businesses");
  const base = `/api/businesses/${business.id}`;
  const customer = (await api(`${base}/contacts`))[0];
  const input = { contact_id: customer.id, title: "Sample service visit", service_address: "Demo service address", private_notes: "Internal access note", time_zone: "America/Toronto" };
  return { api, storage, base, other, customer, input };
}

test("sample jobs persist across tabs, stay business-scoped and share only public fields", async () => {
  const f = await fixture();
  assert.deepEqual(await f.api(`${f.base}/jobs`), []);
  const job = await f.api(`${f.base}/jobs`, post(f.input));
  assert.equal(job.link_enabled, false);
  assert.equal(job.public_url, null);
  assert.equal(job.private_notes, f.input.private_notes);
  await assert.rejects(f.api(`/api/businesses/${f.other.id}/jobs/${job.id}`), /not found/);
  assert.deepEqual(await f.api(`/api/businesses/${f.other.id}/jobs`), []);
  const shared = await f.api(`${f.base}/jobs/${job.id}/share`, post());
  const token = new URL(shared.public_url).hash.slice("#job/".length);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(shared.public_token, undefined);
  const customerTab = createBrowserDemo(f.storage);
  const visible = await customerTab(`/j/${token}/data`);
  assert.equal(visible.title, job.title);
  assert.equal(visible.mode, "demo");
  for (const key of ["private_notes", "contact_id", "business_id", "public_token", "public_url", "id"]) assert.equal(visible[key], undefined, key);
  assert.ok(!JSON.stringify(visible).includes(f.input.private_notes));
  const privateEdit = await f.api(`${f.base}/jobs/${job.id}`, patch({ private_notes: "Changed internal note" }));
  assert.equal(privateEdit.public_updated_at, job.public_updated_at);
  assert.equal(privateEdit.public_updates.length, 1);
  await assert.rejects(customerTab(`/j/${token}/data`, post({ status: "completed" })), /unavailable/);
  const changed = await f.api(`${f.base}/jobs/${job.id}`, patch({ status: "in_progress", customer_update: "Sample work update" }));
  assert.equal(changed.public_updates.at(-1).message, "Sample work update");
  assert.equal((await customerTab(`/j/${token}/data`)).status, "in_progress");
  const renewed = await f.api(`${f.base}/jobs/${job.id}/rotate-link`, post());
  assert.notEqual(renewed.public_url, shared.public_url);
  await assert.rejects(customerTab(`/j/${token}/data`), /unavailable/);
  const currentToken = new URL(renewed.public_url).hash.slice("#job/".length);
  await f.api(`${f.base}/jobs/${job.id}/revoke-link`, post());
  await assert.rejects(customerTab(`/j/${currentToken}/data`), /unavailable/);
  const restored = await f.api(`${f.base}/jobs/${job.id}/share`, post());
  assert.notEqual(restored.public_url, renewed.public_url);
  const activity = (await f.api(`${f.base}/activity`)).filter((entry) => entry.job_id === job.id);
  assert.ok(activity.length >= 5);
  assert.ok(activity.every((entry) => !JSON.stringify(entry).includes(token) && !entry.body));
});

test("sample appointment windows validate local dates and job filters", async () => {
  const f = await fixture();
  const scheduled = { ...f.input, job_type: "installation", status: "scheduled", scheduled_date: "2026-11-12", arrival_start: "09:00", arrival_end: "11:00" };
  for (const invalid of [
    { scheduled_date: "2026-02-30" }, { arrival_end: "08:00" }, { arrival_end: "" }, { status: "awaiting_scheduling" },
    { time_zone: "Invalid/Zone" }, { scheduled_date: null }, { job_type: "other" }, { status: "invented" },
  ]) await assert.rejects(f.api(`${f.base}/jobs`, post({ ...scheduled, ...invalid })));
  for (const invalid of [{ quote_id: false }, { quote_id: 0 }, { customer_update: null }]) await assert.rejects(f.api(`${f.base}/jobs`, post({ ...f.input, ...invalid })));
  const job = await f.api(`${f.base}/jobs`, post(scheduled));
  assert.equal(job.scheduled_date, "2026-11-12");
  assert.equal((await f.api(`${f.base}/jobs?status=scheduled&job_type=installation`)).length, 1);
  assert.deepEqual(await f.api(`${f.base}/jobs?status=completed`), []);
  await assert.rejects(f.api(`${f.base}/jobs?status=invalid`));
  await assert.rejects(f.api(`${f.base}/jobs/${job.id}`, patch({ contact_id: "another" })), /customer/);
  await assert.rejects(f.api(`${f.base}/jobs/${job.id}`, patch({ status: "awaiting_scheduling" })));
  const cleared = await f.api(`${f.base}/jobs/${job.id}`, patch({ status: "awaiting_scheduling", scheduled_date: "", arrival_start: "", arrival_end: "" }));
  assert.equal(cleared.scheduled_date, "");
});

test("sample accepted-quote conversion is idempotent and leaves delivered terms unchanged", async () => {
  const f = await fixture();
  const quote = await f.api(`${f.base}/quotes`, post({ contact_id: f.customer.id, line_items: [{ description: "Sample repair", quantity: 1, unit_price: 100 }], tax_rate: 13, expiry_date: "2099-01-01", notes: "Sample scope" }));
  await assert.rejects(f.api(`${f.base}/jobs`, post({ ...f.input, quote_id: quote.id })), /accepted/);
  const sent = await f.api(`${f.base}/quotes/${quote.id}/send`, post({ channels: ["sms"] }));
  const token = new URL(sent.public_url).hash.slice("#quote/".length);
  await f.api(`/q/${token}/respond`, post({ decision: "accepted" }));
  const accepted = await f.api(`${f.base}/quotes/${quote.id}`);
  const first = await f.api(`${f.base}/jobs`, post({ ...f.input, quote_id: quote.id }));
  const derivedCustomer = await f.api(`${f.base}/jobs`, post({ quote_id: quote.id }));
  assert.equal(derivedCustomer.contact_id, f.customer.id);
  const repeated = await f.api(`${f.base}/jobs`, post({ ...f.input, quote_id: quote.id }));
  assert.equal(first.id, repeated.id);
  assert.equal((await f.api(`${f.base}/jobs`)).length, 1);
  assert.equal(first.quote.total_cents, accepted.total_cents);
  assert.deepEqual(await f.api(`${f.base}/quotes/${quote.id}`), accepted);
  const customer = (await f.api(`${f.base}/contacts`))[1];
  await assert.rejects(f.api(`${f.base}/jobs`, post({ ...f.input, contact_id: customer.id, quote_id: quote.id })), /customer/);
});
