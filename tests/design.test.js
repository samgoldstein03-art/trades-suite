import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";

const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").split('document.addEventListener("click"')[0];
const now = "2026-10-16T12:00:00.000Z";
function run(expression, values = {}) {
  const context = createContext(values);
  new Script(frontend).runInContext(context);
  return JSON.parse(new Script(`JSON.stringify(${expression})`).runInContext(context));
}
function metrics(requests = [], quotes = []) {
  return run("dashboardMetrics(requests, quotes, now)", { requests, quotes, now });
}

test("empty dashboard metrics have honest zero counts and zero deltas", () => {
  const result = metrics();
  assert.deepEqual(Object.keys(result), ["reviews", "awaiting", "nudges", "conversion"]);
  for (const metric of Object.values(result)) {
    assert.equal(metric.value, 0);
    assert.equal(metric.delta, 0);
    assert.ok(metric.label, "the comparison period is visible rather than an unexplained trend");
  }
});

test("review nudge totals retain reminders after the owner marks a request done", () => {
  const result = metrics([
    { status: "done", sent_at: "2026-10-10T12:00:00Z", nudged_at: "2026-10-13T12:00:00Z" },
    { status: "nudged", sent_at: "2026-10-02T12:00:00Z", nudged_at: "2026-10-05T12:00:00Z" },
    { status: "sent", sent_at: "2026-10-10T12:00:00Z", nudge_attempted_at: "2026-10-13T12:00:00Z", nudge_error: "Rejected" },
  ]);
  assert.equal(result.reviews.value, 3);
  assert.equal(result.nudges.value, 2, "failed attempts are not counted as sent nudges");
  assert.equal(result.nudges.delta, 0, "one successful reminder in each comparison period");
});

test("quote nudge totals count successful channel messages and exclude failed or skipped attempts", () => {
  const date = "2026-10-14T12:00:00Z";
  const result = metrics([], [{ status: "sent", sent_at: "2026-10-12T12:00:00Z", deliveries: [
    { channel: "sms", kind: "initial", status: "sent", updated_at: date },
    { channel: "sms", kind: "nudge_2", status: "sent", updated_at: date },
    { channel: "email", kind: "nudge_2", status: "simulated", created_at: date },
    ...["failed", "uncertain", "sending", "skipped", "unknown"].map((status) => ({ channel: "email", kind: "nudge_5", status, updated_at: date })),
  ] }]);
  assert.equal(result.nudges.value, 2, "two channels in one reminder round are two messages");
  assert.equal(result.nudges.delta, 2);
});

test("trend windows are trailing seven days, with no overlap at the boundary or future events", () => {
  const dates = [
    "2026-10-16T12:00:00Z", // Included in the current period.
    "2026-10-09T12:00:00.001Z", // Just inside the current period.
    "2026-10-09T12:00:00Z", // Included only in the prior period.
    "2026-10-02T12:00:00Z", // Outside both periods.
    "2026-10-17T12:00:00Z", // Future timestamps do not invent an upward trend.
    "invalid",
  ];
  const result = metrics(dates.map((sent_at) => ({ sent_at })));
  assert.equal(result.reviews.delta, 1);
  assert.equal(result.reviews.label, "vs previous 7 days");

  const nudges = metrics([], [{ deliveries: [{ kind: "nudge_2", status: "sent", created_at: "2026-10-05T12:00:00Z", updated_at: "2026-10-14T12:00:00Z" }] }]);
  assert.equal(nudges.nudges.delta, 1, "a message is dated by its successful update rather than its earlier claim");
});

test("awaiting-response deltas reconstruct prior open quotes across acceptance, decline and expiry", () => {
  const expiry_date = "2026-12-31";
  const result = metrics([], [
    { status: "sent", sent_at: "2026-09-30T12:00:00Z", expiry_date },
    { status: "accepted", sent_at: "2026-10-01T12:00:00Z", responded_at: "2026-10-12T12:00:00Z", expiry_date },
    { status: "declined", sent_at: "2026-10-01T12:00:00Z", responded_at: "2026-10-13T12:00:00Z", expiry_date },
    { status: "expired", sent_at: "2026-10-03T12:00:00Z", expiry_date: "2026-10-11" },
    { status: "viewed", sent_at: "2026-10-12T12:00:00Z", expiry_date },
    { status: "draft", expiry_date },
  ]);
  assert.equal(result.awaiting.value, 2);
  assert.equal(result.awaiting.delta, -2, "four were open seven days ago and two remain open now");
  assert.equal(result.awaiting.label, "vs 7 days ago");

  assert.equal(metrics([], [{ status: "accepted", sent_at: "2026-09-30T12:00:00Z", expiry_date }]).awaiting.delta, 0, "a missing response time must not invent a prior open state");
});

test("quote conversion uses delivered quotes and reports a percentage-point change", () => {
  const result = metrics([], [
    { status: "accepted", sent_at: "2026-09-01T12:00:00Z", responded_at: "2026-10-01T12:00:00Z" },
    { status: "accepted", sent_at: "2026-10-05T12:00:00Z", responded_at: "2026-10-14T12:00:00Z" },
    { status: "declined", sent_at: "2026-10-02T12:00:00Z", responded_at: "2026-10-03T12:00:00Z" },
    { status: "sent", sent_at: "2026-10-12T12:00:00Z" },
    { status: "draft" },
  ]);
  assert.equal(result.conversion.value, 50);
  assert.equal(result.conversion.delta, 16.7, "50% now minus 33.3% seven days ago");
  assert.equal(result.conversion.label, "pts vs 7 days ago");
});

test("responsive rows keep actions and amount alignment while escaping their mobile labels", () => {
  const html = '<table><thead><tr><th>Name</th><th>Total</th></tr></thead><tbody><tr><td>Avery &lt;Sample&gt;</td><td class="quote-amount" title="CAD"><button data-action="view-quote" data-id="q1">$25.00</button></td></tr><tr><td>Jordan</td><td class="quote-amount">$40.00</td></tr></tbody></table>';
  const result = run("responsiveTable(html, labels)", { html, labels: ["Customer", 'Total "CAD" & tax'] });
  assert.match(result, /^<table class="data-table">/);
  assert.equal((result.match(/data-label="Customer"/g) || []).length, 2, "each body row restarts its label sequence");
  assert.equal((result.match(/data-label="Total &quot;CAD&quot; &amp; tax"/g) || []).length, 2);
  assert.match(result, /class="quote-amount" title="CAD" data-label=/);
  assert.match(result, /data-action="view-quote" data-id="q1"/);
  assert.ok(result.includes("Avery &lt;Sample&gt;"));
  assert.ok(result.includes("<th>Name</th>"), "desktop table headings retain their semantics");
});

function pendingQuoteDialog() {
  const content = { innerHTML: "" };
  const modal = { open: false, shows: 0, showModal() { this.open = true; this.shows++; }, close() { this.open = false; } };
  const context = createContext({
    document: { querySelector: (selector) => ({ "#modal": modal, "#modal-content": content })[selector] },
    location: { href: "https://example.test/" },
    release: null,
    reject: null,
  });
  new Script(`${frontend}
    state.business = {id: "b1", name: "Sample Plumbing"};
    api = () => new Promise((resolve, reject) => { globalThis.release = resolve; globalThis.reject = reject; });
  `).runInContext(context);
  return { context, modal, content };
}

test("dismissed quote loading dialogs stay closed when their pending request resolves or fails", async (t) => {
  for (const name of ["quoteDetail", "quoteSendModal"]) {
    for (const result of ["success", "failure"]) {
      await t.test(`${name}: ${result}`, async () => {
        const { context, modal } = pendingQuoteDialog();
        const pending = new Script(`${name}("q1")`).runInContext(context);
        assert.equal(modal.open, true);
        new Script("closeModal()").runInContext(context);
        if (result === "success") context.release({ status: "sent" });
        else context.reject(new Error("A late network error"));
        await pending;
        assert.equal(modal.open, false);
        assert.equal(modal.shows, 1, "a late response cannot reopen the dismissed dialog");
      });
    }
  }
});

test("a stale quote response cannot replace a newer dialog", async () => {
  const { context, modal, content } = pendingQuoteDialog();
  const pending = new Script('quoteDetail("q1")').runInContext(context);
  new Script('openModal("Customer details", "A newer task", "<p>Keep this form.</p>")').runInContext(context);
  context.release({ status: "sent" });
  await pending;
  assert.equal(modal.open, true);
  assert.match(content.innerHTML, /Customer details/);
  assert.match(content.innerHTML, /Keep this form/);
  assert.ok(!content.innerHTML.includes("quote-detail-meta"));
});

test("a quote answered while the send dialog loads cannot leave a permanent loading dialog", async () => {
  const { context, modal } = pendingQuoteDialog();
  const pending = new Script('quoteSendModal("q1")').runInContext(context);
  assert.equal(modal.open, true);
  context.release({ status: "accepted" });
  await pending;
  assert.equal(modal.open, false);
});
