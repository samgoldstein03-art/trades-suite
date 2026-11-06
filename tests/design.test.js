import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";

const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").split('document.addEventListener("click"')[0];
function run(expression, values = {}) {
  const context = createContext(values);
  new Script(frontend).runInContext(context);
  return JSON.parse(new Script(`JSON.stringify(${expression})`).runInContext(context));
}
function metrics(requests = [], quotes = []) {
  return run("dashboardMetrics(requests, quotes)", { requests, quotes });
}

test("empty dashboard metrics show recorded counts without rates or trend claims", () => {
  const result = metrics();
  assert.deepEqual(Object.keys(result), ["reviews", "awaiting", "nudges", "done"]);
  for (const metric of Object.values(result)) {
    assert.equal(metric.value, 0);
    assert.equal(Object.hasOwn(metric, "delta"), false);
    assert.ok(metric.label);
    assert.doesNotMatch(metric.label, /%|previous|ago|conversion|review received/i);
  }
});

test("review nudge totals retain reminders after the owner marks a request done", () => {
  const result = metrics([
    { status: "done", sent_at: "2026-10-10T12:00:00Z", nudged_at: "2026-10-13T12:00:00Z" },
    { status: "nudged", sent_at: "2026-10-02T12:00:00Z", nudged_at: "2026-10-05T12:00:00Z" },
    { status: "sent", sent_at: "2026-10-10T12:00:00Z", nudge_attempted_at: "2026-10-13T12:00:00Z", nudge_error: "Rejected" },
  ]);
  assert.equal(result.reviews.value, 3);
  assert.equal(result.nudges.value, 2, "failed attempts are not counted as sent reminders");
  assert.equal(result.done.value, 1, "manual completion stays separate from reminder sending");
});

test("quote nudge totals count successful channel messages and exclude failed or skipped attempts", () => {
  const result = metrics([], [{ status: "sent", deliveries: [
    { channel: "sms", kind: "initial", status: "sent" },
    { channel: "sms", kind: "nudge_2", status: "sent" },
    { channel: "email", kind: "nudge_2", status: "simulated" },
    ...["failed", "uncertain", "sending", "skipped", "unknown"].map((status) => ({ channel: "email", kind: "nudge_5", status })),
  ] }]);
  assert.equal(result.nudges.value, 2, "two channels in one reminder round are two recorded messages");
});

test("record timestamps do not create historical trends or inferred performance", () => {
  const result = metrics([
    { status: "sent", sent_at: "2026-10-16T12:00:00Z" },
    { status: "sent", sent_at: "2026-10-09T12:00:00Z" },
    { status: "done", sent_at: "2026-10-17T12:00:00Z", done_at: "invalid" },
  ]);
  assert.equal(result.reviews.value, 3);
  assert.equal(result.done.value, 1, "the saved status is counted without inferring a review from its date");
  assert.ok(Object.values(result).every((metric) => !Object.hasOwn(metric, "delta")));
  assert.equal(Object.hasOwn(result, "conversion"), false);
});

test("quotes awaiting a response count current sent and viewed records only", () => {
  const result = metrics([], [
    { status: "sent" }, { status: "viewed" }, { status: "draft" },
    { status: "accepted" }, { status: "declined" }, { status: "expired" },
  ]);
  assert.equal(result.awaiting.value, 2);
  assert.equal(result.awaiting.label, "Sent or viewed quotes");
  assert.equal(Object.hasOwn(result.awaiting, "delta"), false, "no prior backlog is reconstructed");
});

test("the dashboard labels manual completion honestly and has no review or conversion percentage", () => {
  const html = run(`(() => {
    state.business = { id: "b1", name: "Sample Plumbing" };
    state.businesses = [state.business];
    state.requests = [{ id: "r1", status: "done", contact_name: "Sample customer", sent_at: "2026-10-10T12:00:00Z" }];
    state.quotes = [{ id: "q1", status: "accepted", total_cents: 10000 }];
    state.activity = [];
    state.contacts = [];
    return dashboardPage();
  })()`);
  assert.match(html, /Requests marked done/);
  assert.match(html, /Marked manually by you/);
  assert.match(html, /A little word of mouth/);
  assert.match(html, /Just one reminder\. Never a string of texts/);
  assert.doesNotMatch(html, /conversion|review received|reviews received|%|vs previous|vs 7 days/i);
  assert.equal((html.match(/class="kpi-card"/g) || []).length, 4, "the existing four-card layout is preserved");
  assert.match(html, /data-action="add-quote"/, "the primary quote action remains available");
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
