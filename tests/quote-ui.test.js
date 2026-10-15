import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { createBrowserDemo } from "../scripts/build-browser-demo.js";

const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").split('document.addEventListener("click"')[0];
const customerFrontend = readFileSync(new URL("../public/quote.js", import.meta.url), "utf8").split('document.addEventListener("click"')[0];
const quote = {
  id: "q1", contact_id: "c1", contact_name: "Avery <Sample>", reference: "Q-001", status: "sent", tax_rate: 13,
  currency: "CAD", subtotal_cents: 1523, tax_cents: 198, total_cents: 1721, expiry_date: "2027-02-10", nudge_count: 0,
  line_items: [{ description: "Faucet <replacement>", quantity: 1.5, unit_price: 10.15, line_total_cents: 1523 }], notes: "Ask before starting. <script>bad</script>",
  business: { name: "Sample Heating", phone: "+14165550123", booking_url: "javascript:bad()", logo_url: "javascript:bad()" }, customer_name: "Avery <Sample>", can_respond: true,
};
const initialState = {
  business: { id: "b1", name: "Sample Heating" }, businesses: [{ id: "b1", name: "Sample Heating" }], config: { sms_mode: "demo" }, contacts: [{ id: "c1", name: "Avery", phone: "+14165550100", email: "avery@example.com", sms_consent: true }],
  requests: [], quotes: [quote], activity: [], dashboard: { quotes_awaiting_response: [quote] },
};
function adminContext(overrides = {}) {
  const context = createContext({ location: { href: "https://example.com/" }, ...overrides });
  new Script(`${frontend}\nstate = ${JSON.stringify(initialState)};`).runInContext(context);
  return context;
}

test("quote lists and dashboard show scoped data, statuses, totals and escaped customer content", () => {
  const context = adminContext();
  const html = new Script("quotesPage();").runInContext(context);
  for (const status of ["draft", "sent", "viewed", "accepted", "declined", "expired"]) assert.ok(html.includes(`value="${status}"`));
  assert.match(html, /Avery &lt;Sample&gt;/);
  assert.match(html, /\$17\.21/);
  assert.match(html, /data-action="view-quote" data-id="q1"/);
  assert.match(new Script("dashboardPage();").runInContext(context), /Quotes awaiting response/);
  assert.equal(new Script('quoteFollowUpText({status:"sent", nudge_count:0, follow_ups_cancelled_at:"2026-10-10"})').runInContext(context), "Reminders stopped");
});

test("draft payload captures selected customer, fractional quantity, dollars, tax and notes", () => {
  const values = { "#quote-contact-id": { value: "c2" }, "#quote-tax-rate": { value: "13" }, "#quote-expiry-date": { value: "2027-01-31" }, "#quote-notes": { value: "Call before arrival" } };
  const row = { querySelector: (selector) => ({ '[data-line="description"]': { value: "Repair" }, '[data-line="quantity"]': { value: "1.5" }, '[data-line="unit_price"]': { value: "10.15" } })[selector] };
  const form = { querySelector: (selector) => values[selector], querySelectorAll: () => [row] };
  const context = adminContext({ form });
  const payload = JSON.parse(new Script("JSON.stringify(quoteFormPayload(form));").runInContext(context));
  assert.deepEqual(payload, { contact_id: "c2", line_items: [{ description: "Repair", quantity: 1.5, unit_price: 10.15 }], tax_rate: 13, expiry_date: "2027-01-31", notes: "Call before arrival", currency: "CAD" });
  assert.deepEqual(JSON.parse(new Script("JSON.stringify(quoteTotals(quoteFormPayload(form).line_items, 13));").runInContext(context)), { subtotal_cents: 1523, tax_cents: 198, total_cents: 1721 });
});

test("quote preview rounds fractional quantities to the same integer cents as saved quotes", () => {
  const context = adminContext();
  assert.equal(new Script('quoteTotals([{ quantity: 0.005, unit_price: 1 }], 0).total_cents;').runInContext(context), 1);
  assert.equal(new Script('quoteTotals([{ quantity: 0.145, unit_price: 1 }], 0).total_cents;').runInContext(context), 15);
});

test("send modal requires a channel, submits both channels and reports partial failure", async () => {
  let submit;
  const selected = [];
  const button = { disabled: false };
  const form = { querySelector: () => button, querySelectorAll: () => selected.map((value) => ({ value })), addEventListener: (_name, handler) => { submit = handler; } };
  const modal = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const content = { innerHTML: "" };
  const errorBox = { innerHTML: "" };
  const context = adminContext({ document: { querySelector: (selector) => ({ "#dialog-form": form, "#modal": modal, "#modal-content": content, "#dialog-error": errorBox })[selector] }, calls: [], notices: [], refreshed: 0 });
  new Script(`api = async (path, options) => { calls.push({path, options}); return options ? { deliveries: [{ channel: "sms", status: "sent" }, { channel: "email", status: "failed" }] } : { ...state.quotes[0], status:"draft", sendable_channels:["sms","email"] }; };
    refresh = async () => { refreshed++; }; quoteDetail = async () => {}; toast = (message, error) => notices.push({message,error});`).runInContext(context);
  await new Script('quoteSendModal("q1");').runInContext(context);
  assert.match(content.innerHTML, /Text message/);
  assert.match(content.innerHTML, /Email/);
  await submit({ preventDefault() {}, currentTarget: form });
  assert.match(errorBox.innerHTML, /Choose text message, email, or both/);
  assert.equal(context.calls.length, 1, "no channel means no send request");
  selected.push("sms", "email");
  await submit({ preventDefault() {}, currentTarget: form });
  assert.equal(context.calls[1].path, "/api/businesses/b1/quotes/q1/send");
  assert.deepEqual(JSON.parse(context.calls[1].options.body), { channels: ["sms", "email"] });
  assert.equal(context.refreshed, 1);
  assert.equal(context.notices[0].error, true);
  assert.match(context.notices[0].message, /Some messages could not be sent or confirmed/);
});

test("send result reports a channel skipped after unsubscribe and the quote details explain why", async () => {
  let submit;
  const button = { disabled: false };
  const form = { querySelector: () => button, querySelectorAll: () => ["sms", "email"].map((value) => ({ value })), addEventListener: (_name, handler) => { submit = handler; } };
  const modal = { showModal() {}, close() {} };
  const content = { innerHTML: "" };
  const context = adminContext({
    document: { querySelector: (selector) => ({ "#dialog-form": form, "#modal": modal, "#modal-content": content })[selector] },
    shownQuote: { ...quote, status: "draft", sendable_channels: ["sms", "email"], deliveries: [] }, notices: [], releaseSend: null,
  });
  new Script(`api = (path, options) => options ? new Promise(resolve => { releaseSend = resolve; }) : Promise.resolve(shownQuote);
    refresh = async () => {}; toast = (message, error) => notices.push({message,error});`).runInContext(context);
  await new Script('quoteSendModal("q1");').runInContext(context);
  const pending = submit({ preventDefault() {}, currentTarget: form });
  assert.equal(button.disabled, true);
  new Script(`state.contacts[0].quote_email_opted_out = true;
    shownQuote = { ...shownQuote, status: "sent", deliveries: [
      { channel: "sms", kind: "initial", status: "sent" },
      { channel: "email", kind: "initial", status: "skipped", error: "This customer has opted out of messages." }
    ] }; releaseSend(shownQuote);`).runInContext(context);
  await pending;
  assert.equal(context.notices.at(-1).error, true, "a channel skipped after unsubscribe must not produce a success notice");
  assert.match(context.notices.at(-1).message, /Some messages could not be sent or confirmed/);
  assert.match(content.innerHTML, /class="error-box">Email: This customer has opted out of messages\./);

  // A missed day-2 slot is intentionally skipped after downtime. It must not
  // appear as a delivery problem or change the result of a successful send.
  new Script(`shownQuote.deliveries = [
    { channel: "sms", kind: "initial", status: "sent" },
    { channel: "sms", kind: "nudge_2", status: "skipped", error: null }
  ]; state.contacts[0].quote_email_opted_out = false;`).runInContext(context);
  await new Script('quoteSendModal("q1");').runInContext(context);
  const successful = submit({ preventDefault() {}, currentTarget: form });
  new Script('releaseSend(shownQuote);').runInContext(context);
  await successful;
  assert.equal(context.notices.at(-1).error, false);
  assert.ok(!content.innerHTML.includes('class="error-box"'));
});

test("review request picker excludes aggregate SMS opt-outs and the separate email unsubscribe flag", async () => {
  const content = { innerHTML: "" };
  const context = adminContext({ document: { querySelector: (selector) => ({ "#modal-content": content, "#modal": { showModal() {} } })[selector] } });
  new Script(`state.contacts = [
    { id: "sms-stopped", name: "SMS stopped", sms_consent: true, opted_out: true },
    { id: "email-unsubscribed", name: "Email unsubscribed", sms_consent: true, opted_out: false, quote_email_opted_out: true }
  ]; api = async () => { throw new Error("Opted-out customers must not be previewed or sent a request."); };`).runInContext(context);
  await new Script("requestModal();").runInContext(context);
  assert.match(content.innerHTML, /Customers who have opted out/);
  assert.ok(!content.innerHTML.includes('id="contact_id"'));
});

test("customer quote renders accept/decline only while available and never trusts injected HTML or URLs", () => {
  const context = createContext({ location: { href: "https://example.com/q/token", pathname: "/q/token" } });
  new Script(`${customerFrontend}\ncustomerQuoteData = ${JSON.stringify(quote)};`).runInContext(context);
  const html = new Script("quotePublicMarkup(customerQuoteData);").runInContext(context);
  assert.match(html, /data-decision="accepted"/);
  assert.match(html, /data-decision="declined"/);
  assert.match(html, /Faucet &lt;replacement&gt;/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("<script>"));
  for (const status of ["accepted", "declined", "expired"]) {
    const terminal = new Script(`quotePublicMarkup({...customerQuoteData,status:"${status}",can_respond:false});`).runInContext(context);
    assert.ok(!terminal.includes('data-decision="accepted"'));
    assert.ok(!terminal.includes('data-decision="declined"'));
  }
});

test("customer acceptance prevents duplicate submissions and renders the immediate response", async () => {
  const buttons = [{ disabled: false }, { disabled: false }];
  const main = { innerHTML: "" };
  const context = createContext({ location: { href: "https://example.com/q/token", pathname: "/q/token" }, document: { querySelectorAll: () => buttons, querySelector: () => main }, calls: [], resolveSend: null });
  new Script(`${customerFrontend}\ncustomerQuoteData = ${JSON.stringify(quote)};
    quotePublicRequest = (path, options) => { calls.push({path,options}); return new Promise(resolve => { resolveSend = resolve; }); };`).runInContext(context);
  const sent = new Script('submitCustomerQuote("accepted");').runInContext(context);
  await new Script('submitCustomerQuote("declined");').runInContext(context);
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].path, "/q/token/respond");
  assert.deepEqual(JSON.parse(context.calls[0].options.body), { decision: "accepted" });
  assert.ok(buttons.every((button) => button.disabled));
  context.resolveSend({ ...quote, status: "accepted", can_respond: false });
  await sent;
  assert.match(main.innerHTML, /You’re all set/);
  assert.ok(!main.innerHTML.includes('data-decision="accepted"'));
});

test("browser customer hash hides the admin shell and persists one acceptance through the real demo adapter", async () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const adapter = createBrowserDemo(storage);
  const post = (body) => ({ method: "POST", body: JSON.stringify(body) });
  const [business] = await adapter("/api/businesses");
  const base = `/api/businesses/${business.id}`;
  const [contact] = await adapter(`${base}/contacts`);
  const draft = await adapter(`${base}/quotes`, post({ contact_id: contact.id, line_items: [{ description: "Repair customer tap", quantity: 1, unit_price: 99 }], tax_rate: 13, expiry_date: "2099-12-31", notes: "Afternoon visit", currency: "CAD" }));
  const sent = await adapter(`${base}/quotes/${draft.id}/send`, post({ channels: ["sms"] }));
  const customerUrl = new URL(sent.public_url);
  const classes = new Set();
  const main = { innerHTML: "" };
  const buttons = [{ disabled: false }, { disabled: false }];
  const calls = [];
  let releaseResponse;
  const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
  const customerRenderer = readFileSync(new URL("../public/quote.js", import.meta.url), "utf8").split("async function quotePublicRequest")[0];
  const context = adminContext({
    URL,
    location: { href: customerUrl.href, hash: customerUrl.hash, pathname: customerUrl.pathname },
    document: {
      body: { classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } },
      querySelector(selector) { assert.equal(selector, "#main", "customer route must not render admin controls"); return main; },
      querySelectorAll(selector) { assert.equal(selector, "[data-decision]"); return buttons; },
    },
    browserApi: async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith("/respond")) await responseGate;
      return adapter(path, options);
    },
  });
  new Script(`${customerRenderer}\nstate.config.browser_demo = true; api = browserApi; render();`).runInContext(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(classes.has("customer-quote-view"), true);
  assert.match(main.innerHTML, /class="browser-customer-quote"/);
  assert.match(main.innerHTML, /Repair customer tap/);
  assert.match(main.innerHTML, /data-decision="accepted"/);
  assert.ok(!main.innerHTML.includes('class="page-heading"'));
  assert.equal((await adapter(`${base}/quotes/${draft.id}`)).status, "viewed");
  const accepting = new Script('respondBrowserCustomerQuote("accepted");').runInContext(context);
  await new Script('respondBrowserCustomerQuote("declined");').runInContext(context);
  const writes = calls.filter((call) => call.path.endsWith("/respond"));
  assert.equal(writes.length, 1, "a second click cannot send a second answer while accepting");
  assert.deepEqual(JSON.parse(writes[0].options.body), { decision: "accepted" });
  assert.ok(buttons.every((button) => button.disabled));
  releaseResponse();
  await accepting;
  assert.match(main.innerHTML, /You’re all set/);
  assert.ok(!main.innerHTML.includes('data-decision="accepted"'));
  const reloadedAdapter = createBrowserDemo(storage);
  assert.equal((await reloadedAdapter(`${base}/quotes/${draft.id}`)).status, "accepted", "acceptance survives a reload");
  assert.equal((await reloadedAdapter(`${base}/dashboard`)).quotes_awaiting_response.length, 0);
  const activity = await reloadedAdapter(`${base}/activity`);
  assert.equal(activity.filter((entry) => entry.quote_id === draft.id && entry.label.endsWith(" accepted")).length, 1);
});
