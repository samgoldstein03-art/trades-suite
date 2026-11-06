const $ = (s, el = document) => el.querySelector(s);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
// Small functional marks only. Navigation and content use their written labels.
const controlPaths = {
  plus: "M12 5v14 M5 12h14",
  close: "M6 6l12 12 M18 6 6 18",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
};
const icon = (name) => controlPaths[name]
  ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${controlPaths[name]}"/></svg>`
  : "";
const nav = [
  ["dashboard", "Overview"],
  ["contacts", "Customers"],
  ["requests", "Review requests"],
  ["quotes", "Quotes"],
  ["jobs", "Jobs & schedule"],
  ["activity", "Activity"],
  ["settings", "Business settings"],
];
let state = {
  businesses: [],
  config: { sms_mode: "demo" },
  business: null,
  contacts: [],
  requests: [],
  quotes: [],
  jobs: [],
  activity: [],
  dashboard: {},
  page: "dashboard",
};
let generation = 0, modalGeneration = 0,
  toastTimer;
const initials = (name) =>
  escape(
    String(name || "?")
      .split(/\s+/)
      .slice(0, 2)
      .map((x) => x[0])
      .join("")
      .toUpperCase(),
  );
const date = (value) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "Not set";
const fullDate = (value) => (value ? new Date(value).toLocaleString() : "");
const ago = (value) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value)) / 60000),
  );
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : date(value);
};
const isDemo = () => state.config.sms_mode === "demo";
const base = () => `/api/businesses/${encodeURIComponent(state.business.id)}`;
const badge = (status) =>
  `<span class="badge ${escape(status)}">${{ sent: "Sent", nudged: "Nudged", done: "Done", lead: "Lead", customer: "Customer", "opted-out": "Opted out", draft: "Draft", viewed: "Viewed", accepted: "Accepted", declined: "Declined", expired: "Expired" }[status] || escape(status)}</span>`;
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });
  const data = await res
    .json()
    .catch(() => ({ error: "Something went wrong. Please try again." }));
  if (!res.ok) throw new Error(data.error || "Could not save your changes.");
  return data;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const toastElement = $("#toast");
  const host = $("#modal").open ? $("#modal") : document.body;
  if (host.appendChild && toastElement.parentNode !== host) host.appendChild(toastElement);
  toastElement.textContent = message;
  $("#toast").className = `toast visible${error ? " error" : ""}`;
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 5000);
}
function options(list, value, key = "id", label = "name") {
  return list
    .map(
      (x) =>
        `<option value="${escape(x[key])}" ${String(value) === String(x[key]) ? "selected" : ""}>${escape(x[label])}</option>`,
    )
    .join("");
}
function mobileSwitcher() {
  return `<select class="mobile-business" aria-label="Choose business">${options(state.businesses, state.business?.id)}</select>`;
}
function heading(title, subtitle, action = "") {
  return `${mobileSwitcher()}<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
function empty(title, subtitle, button = "") {
  return `<div class="empty"><strong>${title}</strong><p>${subtitle}</p>${button}</div>`;
}
function loadingMarkup(label = "Getting things ready") {
  return `<div class="loading-skeleton" role="status" aria-label="${escape(label)}"><span class="sr-only">${escape(label)}…</span><div class="skeleton skeleton-heading"></div><div class="skeleton-panel"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div></div>`;
}
function responsiveTable(html, labels) {
  return html.replace("<table>", '<table class="data-table">').replace(/<tr>([\s\S]*?)<\/tr>/g, (row, content) => {
    let column = 0;
    return `<tr>${content.replace(/<td(\s[^>]*)?>/g, (_, attrs = "") => `<td${attrs} data-label="${escape(labels[column++] || "")}">`)}</tr>`;
  });
}
function dashboardMetrics(requests, quotes) {
  const reviewNudges = requests.filter((request) => request.nudged_at).length;
  const quoteNudges = quotes.reduce((count, quote) => count + (quote.deliveries || []).filter((delivery) =>
    ["nudge_2", "nudge_5"].includes(delivery.kind) && ["sent", "simulated"].includes(delivery.status),
  ).length, 0);
  return {
    reviews: { value: requests.length, label: "Includes requests marked done" },
    awaiting: { value: quotes.filter((quote) => ["sent", "viewed"].includes(quote.status)).length, label: "Sent or viewed quotes" },
    nudges: { value: reviewNudges + quoteNudges, label: "Review and quote reminders" },
    done: { value: requests.filter((request) => request.status === "done").length, label: "Marked manually by you" },
  };
}
function kpiCard(label, metric) {
  return `<article class="kpi-card"><div class="kpi-label">${escape(label)}</div><div class="kpi-value">${metric.value.toLocaleString()}</div><div class="kpi-meta">${escape(metric.label)}</div></article>`;
}
function customerInfo(contact) {
  return `<div class="customer-info"><span class="avatar">${initials(contact.name || contact.contact_name)}</span><span><strong>${escape(contact.name || contact.contact_name)}</strong><small>${escape(contact.phone || contact.contact_phone || "")}</small></span></div>`;
}
function requestButton(label = "Request a review", secondary = false) {
  return `<button class="button${secondary ? " secondary" : ""}" data-action="request">${icon("plus")}${label}</button>`;
}
async function refresh() {
  const run = ++generation;
  const saved =
    state.business?.id || localStorage.getItem("tradesuite-business");
  const [businesses, config] = await Promise.all([
    api("/api/businesses"),
    api("/api/config"),
  ]);
  if (run !== generation) return;
  state.businesses = businesses;
  state.config = config;
  state.business =
    businesses.find((x) => String(x.id) === String(saved)) ||
    businesses[0] ||
    null;
  if (state.business) {
    localStorage.setItem("tradesuite-business", state.business.id);
    const [contacts, requests, activity, dashboard, quotes, jobs] = await Promise.all([
      api(`${base()}/contacts`),
      api(`${base()}/requests`),
      api(`${base()}/activity`),
      api(`${base()}/dashboard`),
      api(`${base()}/quotes`),
      api(`${base()}/jobs`),
    ]);
    if (run !== generation) return;
    Object.assign(state, { contacts, requests, activity, dashboard, quotes, jobs });
  }
  render();
}
function render() {
  state.page = location.hash.slice(1) || "dashboard";
  const customerRoute = state.config.browser_demo && /^quote\/([A-Za-z0-9_-]+)$/.exec(state.page);
  const customerJobRoute = state.config.browser_demo && /^job\/([A-Za-z0-9_-]+)$/.exec(state.page);
  const unsubscribeRoute = state.config.browser_demo && /^unsubscribe\/([A-Za-z0-9_-]+)$/.exec(state.page);
  const legalRoute = state.config.browser_demo && ["terms", "privacy"].includes(state.page);
  document.body.classList.toggle("customer-quote-view", Boolean(customerRoute || customerJobRoute || unsubscribeRoute || legalRoute));
  if (customerJobRoute) {
    renderBrowserCustomerJob(customerJobRoute[1]);
    return;
  }
  if (legalRoute) {
    renderBrowserLegal(state.page);
    return;
  }
  if (unsubscribeRoute) {
    renderBrowserUnsubscribe(unsubscribeRoute[1]);
    return;
  }
  if (customerRoute) {
    renderBrowserCustomerQuote(customerRoute[1]);
    return;
  }
  if (!nav.some((x) => x[0] === state.page)) state.page = "dashboard";
  $("#main-nav").innerHTML = nav
    .map(
      ([id, label]) =>
        `<a class="nav-link ${state.page === id ? "active" : ""}" ${state.page === id ? 'aria-current="page"' : ""} href="#${id}"><span>${label}</span></a>`,
    )
    .join("");
  if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 850px)").matches) {
    const navigation = $("#main-nav"), active = navigation.querySelector(".active");
    if (active) navigation.scrollLeft = Math.max(0, active.offsetLeft - navigation.offsetLeft - (navigation.clientWidth - active.offsetWidth) / 2);
  }
  $("#business-select").innerHTML = state.business
    ? options(state.businesses, state.business.id)
    : "<option>No business yet</option>";
  $("#mode-label").textContent = isDemo()
    ? "Demo · no real texts"
    : "Live text messages";
  $("#public-demo-notice").hidden = !state.config.public_demo;
  $("#public-demo-notice").textContent = state.config.public_demo
    ? "Public demo · Use sample details only. Anyone with this link can see changes. No real texts are sent."
    : "";
  const pageName = nav.find((x) => x[0] === state.page)[1];
  $("#page-name").textContent = pageName;
  document.title = `${pageName} · ${state.business?.name || "Tradesuite"}`;
  if ($("#business-identity")) $("#business-identity").innerHTML = `${state.business?.logo_url ? `<img class="business-logo" src="${escape(state.business.logo_url)}" alt="">` : `<span class="business-monogram">${initials(state.business?.name || "Tradesuite")}</span>`}<div><span class="business-name">${escape(state.business?.name || "Your business")}</span><span class="business-caption">Business workspace</span></div>`;
  if (!state.business) {
    $("#main").innerHTML =
      `<div class="welcome"><span class="brand-mark">t<span>↗</span></span><h1>Make room for your next job.</h1><p>Keep your customers, reviews, and quotes in one simple workspace. Start with your business details.</p><button class="button" data-action="add-business">${icon("plus")}Add your business</button><p class="note">${isDemo() ? "You’re in demo mode. No real messages will be sent." : ""}</p></div>`;
    return;
  }
  $("#main").innerHTML = {
    dashboard: dashboardPage,
    contacts: contactsPage,
    requests: requestsPage,
    quotes: quotesPage,
    jobs: jobsPage,
    activity: activityPage,
    settings: settingsPage,
  }[state.page]();
  if (state.page === "settings") bindSettings();
  if (state.page === "contacts" || state.page === "requests") bindFilters();
  if (state.page === "quotes") bindQuoteFilters();
  if (state.page === "jobs") bindJobFilters();
}
function activityRows(items, full = false) {
  return items
    .map((a) => {
      return `<div class="activity-row"><div class="activity-copy"><strong>${escape(a.label || a.kind)}</strong><small>${escape(a.contact_name || state.business.name)}${a.mode === "demo" ? " · Demo" : ""}</small>${full && a.body ? `<div class="activity-message">${escape(a.body)}</div>` : ""}</div><time datetime="${escape(a.created_at)}" title="${escape(fullDate(a.created_at))}">${full ? escape(fullDate(a.created_at)) : ago(a.created_at)}</time></div>`;
    })
    .join("");
}
function requestTable(requests, limited = false) {
  if (!requests.length && !limited && state.requests.length) return empty("No matching requests", "Try another customer name or status.");
  if (!requests.length)
    return empty(
      "No review requests yet",
      "Pick a happy customer and ask for a review.",
      requestButton("Request a review", true),
    );
  return responsiveTable(`<table><thead><tr><th>Customer</th><th>Status</th><th>Requested</th><th>${limited ? "Next step" : "Follow-up"}</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${requests.map((r) => `<tr><td>${customerInfo(r)}${r.mode === "demo" ? '<small class="subtle">Demo request</small>' : ""}</td><td>${badge(r.status)}</td><td title="${escape(fullDate(r.sent_at))}">${date(r.sent_at)}</td><td>${r.status === "done" ? "All wrapped up" : r.status === "nudged" ? "No more follow-ups" : r.nudge_attempted_at ? "Follow-up attempted" : `One nudge ${date(r.nudge_due_at)}`}</td><td>${r.status !== "done" ? `<button class="text-button table-action" data-action="done" data-id="${escape(r.id)}">Mark done </button>` : '<span class="subtle">Completed</span>'}</td></tr>`).join("")}</tbody></table>`, ["Customer","Status","Requested","Follow-up","Actions"]);
}
function attentionNeeded(requests) {
  if (!requests.length) return "";
  return `<section class="panel attention-panel" aria-labelledby="attention-heading"><div class="panel-heading"><div><h2 id="attention-heading">Attention needed</h2><p>These follow-ups need a hand.</p></div></div><div class="attention-list">${requests.map((r) => `<div class="attention-row"><div>${customerInfo(r)}<p class="attention-error">${escape(r.nudge_error || "The follow-up could not be sent.")}</p>${!r.retry_allowed ? `<p class="note">${escape(r.retry_blocked_reason || "Check the activity log before trying again.")}</p>` : ""}</div><button class="button secondary" data-action="retry-nudge" data-id="${escape(r.id)}" ${r.retry_allowed ? "" : "disabled"}>Retry nudge</button></div>`).join("")}</div></section>`;
}
function workerStatus() {
  const checked = state.dashboard.worker_last_checked_at;
  return `<p class="worker-status"><span>${checked ? `Follow-ups last checked at <time datetime="${escape(checked)}">${escape(fullDate(checked))}</time>.` : "Follow-ups have not been checked yet."}${state.config.browser_demo ? " Checks run while this page is open." : ""}</span></p>`;
}
function dashboardPage() {
  const d = state.dashboard;
  const upcoming = d.upcoming_nudges || state.requests.filter((r) => r.status === "sent" && !r.nudge_attempted_at && r.mode === state.config.sms_mode).sort((a, b) => new Date(a.nudge_due_at) - new Date(b.nudge_due_at));
  const recent = d.recent_activity || state.activity;
  const metrics = dashboardMetrics(state.requests, state.quotes || []);
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const primary = (state.quotes || []).length ? '<button class="button" data-action="add-quote">' + icon("plus") + 'Create quote</button>' : state.contacts.length ? requestButton() : '<button class="button" data-action="add-contact">' + icon("plus") + 'Add your first customer</button>';
  return `${mobileSwitcher()}<div class="page-heading dashboard-heading"><div><p class="date-label">${escape(today)}</p><h1>A little word of mouth.</h1><p>Here’s what’s happening at ${escape(state.business.name)}.</p></div>${primary}</div><section class="kpi-grid" aria-label="Your business at a glance">${kpiCard("Review requests sent", metrics.reviews)}${kpiCard("Quotes awaiting response", metrics.awaiting)}${kpiCard("Follow-up messages sent", metrics.nudges)}${kpiCard("Requests marked done", metrics.done)}</section>${attentionNeeded(d.attention_needed || [])}<div class="dashboard-content"><div>${quotesAwaitingResponse()}<section class="panel"><div class="panel-heading"><div><h2>Review follow-ups</h2><p>Just one reminder. Never a string of texts.</p></div><a href="#requests" class="text-button">All requests </a></div><div class="nudge-list">${upcoming.length ? upcoming.slice(0, 3).map((r) => `<div class="nudge-row"><span class="avatar small">${initials(r.contact_name)}</span><span><strong>${escape(r.contact_name)}</strong><small>Review requested ${date(r.sent_at)}</small></span><span class="nudge-time">${new Date(r.nudge_due_at) <= new Date() ? "Due now" : date(r.nudge_due_at)}</span></div>`).join("") : empty("You’re all caught up", "Review follow-ups will appear here when they’re scheduled.")}</div></section></div><section class="panel"><div class="panel-heading"><div><h2>Recent activity</h2><p>The latest from your business.</p></div><a href="#activity" class="text-button" aria-label="View all activity">View all</a></div><div class="activity-list">${recent.length ? activityRows(recent.slice(0, 6)) : empty("A fresh start", "Messages and customer updates will appear here.")}</div></section></div>${workerStatus()}${dashboardJobs()}<h2 class="section-heading">Recent review requests</h2><section class="panel table-panel">${requestTable(state.requests.slice(0, 4), true)}</section>${demoBanner()}`;
}
function demoBanner() {
  return isDemo()
    ? `<div class="demo-banner"><span><strong>Demo workspace.</strong> These texts are simulated. Nothing is sent to a phone.</span><button class="text-button" data-action="demo-nudge">Test the 3-day nudge </button></div>`
    : "";
}
function contactsPage() {
  return `${heading("Customers", "The people behind every job. Keep their details close.", `<button class="button" data-action="add-contact">${icon("plus")}Add customer</button>`)}<div class="toolbar"><div class="search-field">${icon("search")}<input id="search" placeholder="Find a customer…" aria-label="Find a customer"></div><select id="filter" class="filter-select" aria-label="Filter customers"><option value="all">Everyone</option><option value="customer">Customers</option><option value="lead">Leads</option></select></div><section class="panel table-panel" id="results">${contactsTable(state.contacts)}</section>`;
}
function contactsTable(contacts) {
  if (!contacts.length && state.contacts.length) return empty("No matching customers", "Try another name or relationship.");
  return contacts.length
    ? responsiveTable(`<table><thead><tr><th>Name & phone</th><th>Email</th><th>Relationship</th><th>Message permission</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${contacts.map((c) => `<tr><td>${customerInfo(c)}</td><td>${escape(c.email || "No email")}</td><td>${(Array.isArray(c.tags) ? c.tags : [c.tags]).filter(Boolean).map(badge).join(" ")}</td><td>${c.opted_out ? badge("opted-out") : c.sms_consent ? '<span class="success-text">Text permission recorded</span>' : '<span class="subtle">No text permission yet</span>'}</td><td><button class="text-button table-action" data-action="edit-contact" data-id="${escape(c.id)}">Edit </button><button class="text-button table-action" data-action="customer-jobs" data-id="${escape(c.id)}">View jobs</button></td></tr>`).join("")}</tbody></table>`, ["Customer","Email","Relationship","Message permission","Actions"])
    : empty(
        "No customers here yet",
        "Add a customer to start building your list.",
        '<button class="button secondary" data-action="add-contact">Add customer</button>',
      );
}
function requestsPage() {
  return `${heading("Review requests", "A simple ask. One friendly follow-up. More word of mouth.", requestButton())}<div class="toolbar"><div class="search-field">${icon("search")}<input id="search" placeholder="Find a request…" aria-label="Find a request"></div><select id="filter" class="filter-select" aria-label="Filter requests"><option value="all">All requests</option><option value="sent">Sent</option><option value="nudged">Nudged</option><option value="done">Done</option></select></div><section class="panel table-panel" id="results">${requestTable(state.requests)}</section><p class="note">Seen a customer’s review? Mark their request done to stop the follow-up. “Sent” means accepted for sending; it doesn’t confirm phone delivery. Reviews aren’t checked automatically.</p>${demoBanner()}`;
}
const quoteStatuses = ["draft", "sent", "viewed", "accepted", "declined", "expired"];
const money = (cents, currency = "CAD") => new Intl.NumberFormat("en-CA", { style: "currency", currency }).format((Number(cents) || 0) / 100);
const quoteDate = (value) => value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Not set";
function quoteNudgeCount(q) {
  if (Number.isFinite(q.nudge_count)) return q.nudge_count;
  return new Set((q.deliveries || []).filter((delivery) => ["nudge_2", "nudge_5"].includes(delivery.kind) && ["sent", "simulated"].includes(delivery.status)).map((delivery) => delivery.kind)).size;
}
function quoteFollowUpChannels(q) {
  const channels = q.follow_up_channels || (q.deliveries || []).filter((delivery) => delivery.kind === "initial" && ["sent", "simulated"].includes(delivery.status)).map((delivery) => delivery.channel);
  if (channels.includes("sms") && channels.includes("email")) return "Reminders by text and email.";
  if (channels.includes("email")) return "Reminders by email.";
  if (channels.includes("sms")) return "Reminders by text.";
  return "";
}
function quoteFollowUpsPending(q) {
  if (typeof q.follow_ups_pending === "boolean") return q.follow_ups_pending;
  const channels = q.follow_up_channels || [...new Set((q.deliveries || []).filter((delivery) => delivery.kind === "initial" && ["sent", "simulated"].includes(delivery.status)).map((delivery) => delivery.channel))];
  return channels.length ? channels.some((channel) => !(q.deliveries || []).some((delivery) => delivery.channel === channel && delivery.kind === "nudge_5")) : quoteNudgeCount(q) < 2;
}
function quoteFollowUpText(q) {
  if (["accepted", "declined", "expired"].includes(q.status)) return "No more reminders";
  if (q.follow_ups_cancelled_at) return "Reminders stopped";
  if (q.status === "draft") return "Starts after sending";
  if (quoteNudgeCount(q) >= 2) return quoteFollowUpsPending(q) ? "Some reminders still waiting" : "Both reminders sent";
  if (!quoteFollowUpsPending(q)) return "Reminders finished";
  return quoteNudgeCount(q) === 1 ? "Final reminder at day 5" : "Reminders at day 2 and day 5";
}
function quotesTable(quotes, dashboard = false) {
  if (!quotes.length && !dashboard && (state.quotes || []).length) return empty("No matching quotes", "Try another customer name, quote number, or status.");
  if (!quotes.length) return empty(dashboard ? "No quotes waiting" : "Your next job starts with a quote", dashboard ? "Unanswered quotes appear here after you send them." : "Put the work and price in writing, then make it easy to say yes.", '<button class="button secondary" data-action="add-quote">Create quote</button>');
  return responsiveTable(`<table><thead><tr><th>Customer</th><th>Status</th><th class="amount-heading">Total</th>${dashboard ? "" : "<th>Valid through</th>"}<th><span class="sr-only">Actions</span></th></tr></thead><tbody>${quotes.map((q) => `<tr><td><strong>${escape(q.contact_name)}</strong><small class="quote-reference">${escape(q.reference || "Quote")}${dashboard ? "" : " · " + escape(quoteFollowUpText(q))}</small></td><td>${badge(q.status)}</td><td class="quote-amount">${escape(money(q.total_cents, q.currency))}</td>${dashboard ? "" : `<td>${escape(quoteDate(q.expiry_date))}</td>`}<td><button class="text-button table-action" data-action="view-quote" data-id="${escape(q.id)}">${q.status === "draft" ? "Open draft" : "View quote"} </button></td></tr>`).join("")}</tbody></table>`, dashboard ? ["Customer", "Status", "Total", "Actions"] : ["Customer", "Status", "Total", "Valid through", "Actions"]);
}
function quotesAwaitingResponse() {
  const quotes = state.dashboard.quotes_awaiting_response || (state.quotes || []).filter((q) => ["sent", "viewed"].includes(q.status));
  return `<section class="panel"><div class="panel-heading"><div><h2>Quotes awaiting response</h2><p>${quotes.length ? quotes.length + (quotes.length === 1 ? " quote with your customer." : " quotes with your customers.") : "Your next job starts here."}</p></div><a href="#quotes" class="text-button">All quotes </a></div><div class="table-panel">${quotesTable(quotes.slice(0, 5), true)}</div></section>`;
}
function quotesPage() {
  return `${heading("Quotes", "Clear prices. Easy decisions. Keep your next job moving.", '<button class="button" data-action="add-quote">' + icon("plus") + "Create quote</button>")}<div class="toolbar"><div class="search-field">${icon("search")}<input id="quote-search" placeholder="Find a quote…" aria-label="Find a quote"></div><select id="quote-filter" class="filter-select" aria-label="Filter quotes"><option value="all">All quotes</option>${quoteStatuses.map((s) => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></div><section class="panel table-panel" id="quote-results">${quotesTable(state.quotes || [])}</section><p class="note">Customers can accept or decline from their quote link. Unanswered quotes get a reminder after 2 days and again after 5 days by text, email, or both, matching how you sent them. You can stop reminders at any time.</p>${isDemo() ? '<div class="demo-banner"><span><strong>Demo quotes.</strong> Texts and emails are simulated. Open a sent quote to test its reminders.</span></div>' : ""}`;
}
function bindQuoteFilters() {
  const update = () => {
    const query = $("#quote-search").value.toLowerCase();
    const status = $("#quote-filter").value;
    $("#quote-results").innerHTML = quotesTable((state.quotes || []).filter((q) => `${q.contact_name} ${q.reference}`.toLowerCase().includes(query) && (status === "all" || q.status === status)));
  };
  $("#quote-search").addEventListener("input", update);
  $("#quote-filter").addEventListener("change", update);
}
function quoteTotals(items, taxRate) {
  const scaled = (value, scale) => BigInt(Math.round((Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0) * scale));
  const subtotal = items.reduce((sum, item) => sum + (scaled(item.quantity, 1000) * scaled(item.unit_price, 100) + 500n) / 1000n, 0n);
  const subtotal_cents = Number(subtotal);
  const tax_cents = Number((subtotal * scaled(taxRate, 1000) + 50000n) / 100000n);
  return { subtotal_cents, tax_cents, total_cents: subtotal_cents + tax_cents };
}
function quoteTotalsMarkup(q) {
  return `<div class="quote-totals"><div><span>Subtotal</span><strong>${escape(money(q.subtotal_cents, q.currency))}</strong></div><div><span>Tax (${escape(q.tax_rate || 0)}%)</span><strong>${escape(money(q.tax_cents, q.currency))}</strong></div><div class="quote-total"><span>Total <small>${escape(q.currency || "CAD")}</small></span><strong>${escape(money(q.total_cents, q.currency))}</strong></div></div>`;
}
function activityPage() {
  return `${heading("Activity", "Every message and every update for " + escape(state.business.name) + ".")}<section class="panel activity-full">${state.activity.length ? activityRows(state.activity, true) : empty("Your story starts here", "Send your first request and we’ll keep a record of it.")}</section>`;
}
let browserCustomerQuote;
let browserCustomerQuoteSending = false;
let browserQuoteGeneration = 0;
function draftDocumentLinks() {
  return '<nav class="document-links" aria-label="Draft documents"><a href="/terms">Terms draft</a><a href="/privacy">Privacy draft</a></nav>';
}
function renderBrowserLegal(kind) {
  document.title = `${kind === "terms" ? "Terms of Service" : "Privacy Policy"} draft | Tradesuite`;
  const documents = typeof browserLegalDocuments === "undefined" ? {} : browserLegalDocuments;
  $("#main").innerHTML = `<div class="legal-shell"><a class="browser-quote-back" href="#dashboard">Back to workspace</a></div>${documents[kind] || empty("Draft unavailable", "Open the Terms draft or Privacy draft from the installed app.")}`;
}
function browserQuotePageMarkup(quote, error = "") {
  return `<div class="browser-customer-quote"><a class="browser-quote-back" href="#quotes">← Back to workspace</a>${quotePublicMarkup(quote)}${error ? `<div class="browser-quote-error" role="alert">${escape(error)}</div>` : ""}${draftDocumentLinks()}</div>`;
}
async function renderBrowserCustomerQuote(token) {
  const run = ++browserQuoteGeneration;
  document.title = "Your quote · Tradesuite";
  $("#main").innerHTML = loadingMarkup("Opening your quote");
  try {
    const quote = await api(`/q/${encodeURIComponent(token)}/data`);
    if (run !== browserQuoteGeneration || location.hash !== `#quote/${token}`) return;
    browserCustomerQuote = { token, quote };
    document.title = `${quote.business.name} | ${quote.status === "accepted" ? "Quote accepted" : quote.status === "declined" ? "Quote declined" : quote.status === "expired" ? "Quote expired" : "Your quote"}`;
    $("#main").innerHTML = browserQuotePageMarkup(quote);
  } catch (error) {
    if (run !== browserQuoteGeneration || location.hash !== `#quote/${token}`) return;
    browserCustomerQuote = null;
    document.title = "Quote unavailable | Tradesuite";
    $("#main").innerHTML = `<div class="browser-customer-quote"><a class="browser-quote-back" href="#quotes">← Back to workspace</a><section class="panel form-panel"><h1>This quote couldn’t be opened.</h1><p>${escape(error.message)}</p><p>Browser demo quote links work only in the browser where the quote was created.</p></section>${draftDocumentLinks()}</div>`;
  }
}
async function respondBrowserCustomerQuote(decision) {
  const current = browserCustomerQuote;
  if (!current || !current.quote.can_respond || browserCustomerQuoteSending || !["accepted", "declined"].includes(decision)) return;
  browserCustomerQuoteSending = true;
  document.querySelectorAll("[data-decision]").forEach((button) => button.disabled = true);
  let quote = current.quote;
  let failure;
  try {
    quote = await api(`/q/${encodeURIComponent(current.token)}/respond`, { method: "POST", body: JSON.stringify({ decision }) });
  } catch (error) {
    failure = error;
    try { quote = await api(`/q/${encodeURIComponent(current.token)}/data`); } catch { /* Show the send error and preserve the current quote. */ }
  } finally { browserCustomerQuoteSending = false; }
  if (location.hash !== `#quote/${current.token}`) return;
  browserCustomerQuote = { token: current.token, quote };
  document.title = `${quote.business.name} | ${quote.status === "accepted" ? "Quote accepted" : quote.status === "declined" ? "Quote declined" : "Your quote"}`;
  $("#main").innerHTML = browserQuotePageMarkup(quote, failure?.message);
}
async function renderBrowserUnsubscribe(token, confirmed = false) {
  const run = ++browserQuoteGeneration;
  document.title = "Message preferences · Tradesuite";
  $("#main").innerHTML = loadingMarkup("Opening message preferences");
  try {
    const info = await api(`/q/unsubscribe/${encodeURIComponent(token)}${confirmed ? "" : "/data"}`, confirmed ? { method: "POST", body: "{}" } : {});
    if (run !== browserQuoteGeneration || location.hash !== `#unsubscribe/${token}`) return;
    const name = escape(info.business_name);
    document.title = `${info.unsubscribed ? "Unsubscribed" : "Message preferences"} | ${info.business_name}`;
    $("#main").innerHTML = `<div class="browser-customer-quote"><a class="browser-quote-back" href="#quotes">← Back to workspace</a><section class="panel form-panel"><h1>${info.unsubscribed ? "You’re unsubscribed." : `Stop messages from ${name}?`}</h1><p>${info.unsubscribed ? `Texts and quote emails from ${name} are paused.` : `Unsubscribing stops texts and quote emails from ${name}. Your choices for other businesses stay the same.`}</p>${info.unsubscribed ? "" : `<button class="button" data-action="confirm-email-unsubscribe" data-token="${escape(token)}">Unsubscribe</button>`}<p class="note">Browser demo · No real texts or emails are sent.</p></section>${draftDocumentLinks()}</div>`;
  } catch (error) {
    if (run !== browserQuoteGeneration || location.hash !== `#unsubscribe/${token}`) return;
    $("#main").innerHTML = `<div class="browser-customer-quote"><section class="panel form-panel"><h1>This link couldn’t be opened.</h1><p>${escape(error.message)}</p></section>${draftDocumentLinks()}</div>`;
  }
}
function field(label, name, value = "", type = "text", extra = "", help = "") {
  return `<div class="form-field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${escape(value)}" ${extra}>${help ? `<small>${help}</small>` : ""}</div>`;
}
function businessFields(b = {}) {
  return `${field("Business name", "name", b.name, "text", 'required maxlength="100" placeholder="e.g. Harbor Plumbing"')}${field("Phone number", "phone", b.phone, "tel", 'required placeholder="+14165550123"', "Include the country code, such as +1 for Canada.")}${field("Booking link", "booking_url", b.booking_url, "url", 'placeholder="https://yourbusiness.com/book"')}${field("Google review link", "google_review_url", b.google_review_url, "url", 'required placeholder="https://g.page/r/your-business/review"', "The link customers use to leave you a Google review.")}${field("Text-message settings name", "sms_key", b.sms_key, "text", 'required pattern="[A-Za-z][A-Za-z0-9_]*" placeholder="HARBOR" maxlength="40"', "A short name to match this business to its text-message settings, such as HARBOR. No passwords go here.")}`;
}
function settingsPage() {
  const b = state.business;
  const prefix = `BUSINESS_${String(b.sms_key).toUpperCase()}`;
  return `${heading("Business settings", "The details your customers know you by.", '<button class="button secondary" data-action="add-business">' + icon("plus") + "Add business</button>")}<div class="settings-grid"><section class="panel form-panel"><h2>Business details</h2><p>Customers see your business name at the end of every text.</p><form id="settings-form"><div class="form-grid">${businessFields(b)}</div><div id="settings-error" role="alert"></div><div class="form-actions"><button class="button" type="submit">Save changes </button></div></form></section><div><section class="panel form-panel"><h2>Your logo</h2><p>A familiar face for your business.</p>${b.logo_url ? `<img class="logo-preview" src="${escape(b.logo_url)}" alt="${escape(b.name)} logo">` : `<span class="avatar">${initials(b.name)}</span>`}<form id="logo-form"><div class="form-field section-gap"><label for="logo">Upload your logo</label><input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" required><small>PNG, JPG or WebP. Up to 2 MB.</small></div><button class="button secondary small-button" type="submit">Save logo</button></form></section><section class="panel form-panel section-gap"><h2>Text messages</h2><div class="connection-state">${isDemo() ? "Demo mode is on. No real texts will be sent." : b.sms_ready ? "Your text-message settings are ready." : "Your Twilio settings need to be added before you can send."}</div><p class="note">Each business uses its own Twilio account. Your setup helper can add these settings to the app’s private .env file, then restart the app.</p><details class="setup-details"><summary>Show setup details for your installer</summary><dl class="setup-identifiers"><div><dt>Account setting</dt><dd>${escape(prefix)}_ACCOUNT_SID</dd></div><div><dt>Private token setting</dt><dd>${escape(prefix)}_AUTH_TOKEN</dd></div><div><dt>Sending number setting</dt><dd>${escape(prefix)}_PHONE_NUMBER</dd></div></dl></details><p class="note">Keep those details private. They never need to be entered here.</p></section></div></div>`;
}
function bindFilters() {
  const update = () => {
    const query = $("#search").value.toLowerCase(),
      filter = $("#filter").value;
    $("#results").innerHTML =
      state.page === "contacts"
        ? contactsTable(
            state.contacts.filter(
              (c) =>
                `${c.name} ${c.phone} ${c.email} ${c.notes}`
                  .toLowerCase()
                  .includes(query) &&
                (filter === "all" ||
                  (Array.isArray(c.tags) ? c.tags : [c.tags]).includes(filter)),
            ),
          )
        : requestTable(
            state.requests.filter(
              (r) =>
                `${r.contact_name} ${r.contact_phone}`
                  .toLowerCase()
                  .includes(query) &&
                (filter === "all" || r.status === filter),
            ),
          );
  };
  $("#search").addEventListener("input", update);
  $("#filter").addEventListener("change", update);
}
function formData(form) {
  return Object.fromEntries(new FormData(form));
}
function showFormError(target, error) {
  target.innerHTML = `<div class="error-box">${escape(error.message)}</div>`;
}
function bindSettings() {
  const context = base();
  $("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      button = $("button[type=submit]", form);
    button.disabled = true;
    try {
      await api(context, {
        method: "PATCH",
        body: JSON.stringify(formData(form)),
      });
      await refresh();
      toast("Business details saved.");
    } catch (err) {
      showFormError($("#settings-error"), err);
      button.disabled = false;
    }
  });
  $("#logo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      button = $("button", form);
    button.disabled = true;
    try {
      await api(`${context}/logo`, {
        method: "POST",
        body: new FormData(form),
      });
      await refresh();
      toast("Looking good. Your logo is saved.");
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  });
}
function closeModal() {
  modalGeneration++;
  $("#modal").close();
}
function openModal(title, subtitle, content, wide = false) {
  modalGeneration++;
  $("#modal").classList?.toggle("modal-wide", wide);
  $("#modal-content").innerHTML =
    `<div class="modal-inner"><div class="modal-heading"><div><h2>${title}</h2><p>${subtitle}</p></div><button type="button" class="icon-button" data-action="close" aria-label="Close">${icon("close")}</button></div>${content}</div>`;
  if (!$("#modal").open) $("#modal").showModal();
  return modalGeneration;
}
function modalForm(content, label = "Save", extra = "") {
  return `<form id="dialog-form">${content}<div id="dialog-error" role="alert"></div>${extra}<div class="form-actions"><button type="button" class="button secondary" data-action="close">Cancel</button><button class="button" type="submit">${label}</button></div></form>`;
}
function handleModalSubmit(handler, success) {
  $("#dialog-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      button = $("button[type=submit]", form);
    button.disabled = true;
    try {
      const result = await handler(form);
      closeModal();
      await refresh();
      toast(typeof success === "function" ? success(result) : success);
    } catch (err) {
      if ($("#modal").open) showFormError($("#dialog-error"), err);
      else toast(err.message, true);
      button.disabled = false;
    }
  });
}
function businessModal() {
  openModal(
    "Add business",
    "Add the details your customers will see on quotes and messages.",
    modalForm(businessFields().replace(/\b(for|id)="([^"]+)"/g, '$1="new-business-$2"'), "Add business"),
  );
  handleModalSubmit(async (form) => {
    const b = await api("/api/businesses", {
      method: "POST",
      body: JSON.stringify(formData(form)),
    });
    state.business = b;
  }, "Your business is ready. Let’s add a customer.");
}
function contactModal(id) {
  const c = state.contacts.find((x) => String(x.id) === String(id)) || {},
    context = base();
  openModal(
    c.id ? "Edit customer" : "Add customer",
    c.id
      ? "Update their details and keep in touch."
      : "A few details now make following up easy.",
    modalForm(
      `<div class="form-grid">${field("Full name", "name", c.name, "text", 'required maxlength="100"')}${field("Phone number", "phone", c.phone, "tel", 'required placeholder="+14165550123"', "Include the country code.")}${field("Email (optional)", "email", c.email, "email")}<div class="form-field"><label for="tags">Relationship</label><select name="tags" id="tags"><option value="customer" ${(c.tags || []).includes("customer") ? "selected" : ""}>Customer</option><option value="lead" ${(c.tags || []).includes("lead") ? "selected" : ""}>Lead</option></select></div></div><div class="form-field section-gap"><label for="notes">Notes (optional)</label><textarea name="notes" id="notes" placeholder="Anything worth remembering…">${escape(c.notes || "")}</textarea></div><label class="checkbox-label"><input type="checkbox" name="sms_consent" ${c.sms_consent ? "checked" : ""}><span>This person has given us permission to text them about reviews and quotes.</span></label>${c.opted_out ? '<p class="note danger-text">This customer has opted out. Text messages and quote emails are paused for this business.</p>' : ""}`,
      c.id ? "Save customer" : "Add customer",
    ),
  );
  handleModalSubmit(
    (form) => {
      const values = formData(form);
      values.tags = [values.tags];
      values.sms_consent = Boolean(values.sms_consent);
      return api(
        `${context}/contacts${c.id ? "/" + encodeURIComponent(c.id) : ""}`,
        { method: c.id ? "PATCH" : "POST", body: JSON.stringify(values) },
      );
    },
    (saved) => c.id && saved.phone !== c.phone && !saved.sms_consent
      ? "New number saved. Edit this customer again to confirm text permission for it."
      : c.id ? "Customer details saved." : "Customer added.",
  );
}
function quoteLineMarkup(item = { description: "", quantity: 1, unit_price: "" }) {
  return `<div class="quote-line"><label class="quote-description"><span>Work or item</span><input data-line="description" aria-label="Work or item" value="${escape(item.description)}" maxlength="500" placeholder="e.g. Replace kitchen faucet" required></label><label><span>Quantity</span><input data-line="quantity" aria-label="Quantity" type="number" min="0.001" max="100000" step="0.001" value="${escape(item.quantity)}" required></label><label><span>Unit price ($)</span><input data-line="unit_price" aria-label="Unit price in dollars" type="number" min="0" max="1000000" step="0.01" value="${escape(item.unit_price)}" required></label><button type="button" class="icon-button quote-remove" aria-label="Remove item">${icon("close")}</button></div>`;
}
function readQuoteItems(form) {
  return Array.from(form.querySelectorAll(".quote-line"), (row) => ({
    description: $('[data-line="description"]', row).value,
    quantity: Number($('[data-line="quantity"]', row).value),
    unit_price: Number($('[data-line="unit_price"]', row).value),
  }));
}
function quoteFormPayload(form) {
  return { contact_id: $("#quote-contact-id", form).value, line_items: readQuoteItems(form), tax_rate: Number($("#quote-tax-rate", form).value), expiry_date: $("#quote-expiry-date", form).value, notes: $("#quote-notes", form).value, currency: "CAD" };
}
function quoteEditor(id) {
  const q = (state.quotes || []).find((item) => String(item.id) === String(id)) || {};
  if (q.id && q.status !== "draft") return;
  if (!state.contacts.length) {
    openModal("First, add your customer.", "Your quote needs a name to go with it.", '<div class="form-actions"><button class="button" data-action="close-add-contact">Add customer</button></div>');
    return;
  }
  const context = base();
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 30);
  const defaultExpiry = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, "0")}-${String(expiry.getDate()).padStart(2, "0")}`;
  openModal(q.id ? "Edit quote" : "Create quote", "Save a draft first. You can review it before sending.", modalForm(
    `<div class="quote-editor"><div class="form-grid"><div class="form-field"><label for="quote-contact-id">Customer</label><select id="quote-contact-id" required>${options(state.contacts, q.contact_id || state.contacts[0].id)}</select></div><div class="form-field"><label for="quote-expiry-date">Valid through</label><input id="quote-expiry-date" type="date" value="${escape(q.expiry_date || defaultExpiry)}" required></div></div><div class="quote-lines" id="quote-lines">${(q.line_items || [{ description: "", quantity: 1, unit_price: "" }]).map(quoteLineMarkup).join("")}</div><button type="button" class="text-button" id="quote-add-line">${icon("plus")}Add another item</button><div class="quote-calculation"><div class="form-field"><label for="quote-tax-rate">Tax (%)</label><input id="quote-tax-rate" type="number" min="0" max="100" step="0.001" value="${escape(q.tax_rate || 0)}" required><small>Use the rate for this job.</small></div><div id="quote-live-totals" aria-live="polite"></div></div><div class="form-field"><label for="quote-notes">Note to your customer (optional)</label><textarea id="quote-notes" maxlength="5000" placeholder="What's included, timing, or anything else they should know…">${escape(q.notes || "")}</textarea></div><p class="note">All prices are in Canadian dollars. No payment is collected by this app.</p></div>`, "Save draft"), true);
  const form = $("#dialog-form");
  const update = () => {
    const tax_rate = Number($("#quote-tax-rate", form).value);
    $("#quote-live-totals").innerHTML = quoteTotalsMarkup({ ...quoteTotals(readQuoteItems(form), tax_rate), tax_rate, currency: "CAD" });
    const rows = Array.from(form.querySelectorAll(".quote-line"));
    rows.forEach((row) => $(".quote-remove", row).disabled = rows.length === 1);
  };
  $("#quote-add-line").addEventListener("click", () => {
    $("#quote-lines").insertAdjacentHTML("beforeend", quoteLineMarkup());
    update();
    $("#quote-lines").lastElementChild.querySelector("input").focus();
  });
  $("#quote-lines").addEventListener("click", (event) => {
    const button = event.target.closest(".quote-remove");
    if (button && form.querySelectorAll(".quote-line").length > 1) { button.closest(".quote-line").remove(); update(); }
  });
  form.addEventListener("input", update);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      const saved = await api(`${context}/quotes${q.id ? "/" + encodeURIComponent(q.id) : ""}`, { method: q.id ? "PATCH" : "POST", body: JSON.stringify(quoteFormPayload(form)) });
      await refresh();
      await quoteDetail(saved.id);
      toast("Draft saved. Ready when you are.");
    } catch (error) { showFormError($("#dialog-error"), error); submit.disabled = false; }
  });
  update();
}
function safeQuoteUrl(url) {
  try {
    if (!url) return "";
    const parsed = new URL(url, location.href);
    const localDemo = state.config.browser_demo && parsed.protocol === "file:" && parsed.pathname === location.pathname && /^#quote\/[A-Za-z0-9_-]+$/.test(parsed.hash);
    return ["https:", "http:"].includes(parsed.protocol) || localDemo ? parsed.href : "";
  } catch { return ""; }
}
function quoteDeliveryNeedsAttention(delivery) {
  return ["failed", "unknown", "uncertain"].includes(delivery.status) || (delivery.status === "skipped" && Boolean(delivery.error));
}
function quoteDeliveryTimeline(deliveries) {
  if (!deliveries.length) return '<section class="quote-reminders"><strong>Delivery history</strong><p class="note">Messages and reminders will appear here after you send this quote.</p></section>';
  const kind = { initial: "Quote link", nudge_2: "Day 2 reminder", nudge_5: "Day 5 reminder" };
  const status = { sent: "Sent", simulated: "Simulated", sending: "Sending", failed: "Failed", unknown: "Unconfirmed", uncertain: "Unconfirmed", skipped: "Skipped" };
  return `<section class="delivery-timeline" aria-label="Delivery history"><h3>Delivery history</h3><ol class="delivery-timeline">${[...deliveries].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).map((d) => `<li class="delivery-event"><div><strong>${escape(kind[d.kind] || d.kind)} · ${d.channel === "email" ? "Email" : "Text message"}</strong><small>${escape(status[d.status] || d.status)}</small></div><time datetime="${escape(d.updated_at || d.created_at)}">${escape(fullDate(d.updated_at || d.created_at)) || "Time unavailable"}</time></li>`).join("")}</ol></section>`;
}
async function quoteDetail(id) {
  const context = base();
  const loading = openModal("Opening quote", "The details will be ready in a moment.", loadingMarkup("Opening quote"), true);
  let q;
  try { q = await api(`${context}/quotes/${encodeURIComponent(id)}`); }
  catch (error) { if (loading !== modalGeneration) return; openModal("Couldn’t open this quote", "Try again in a moment.", empty("Quote unavailable", escape(error.message), '<button class="button secondary" data-action="close">Close</button>')); throw error; }
  if (loading !== modalGeneration || context !== base()) return;
  const cachedQuotes = state.quotes || [];
  state.quotes = cachedQuotes.some((item) => String(item.id) === String(q.id)) ? cachedQuotes.map((item) => String(item.id) === String(q.id) ? q : item) : [q, ...cachedQuotes];
  const customerLink = safeQuoteUrl(q.public_url);
  const unanswered = ["sent", "viewed"].includes(q.status);
  openModal(escape(q.reference || "Your quote"), escape(q.contact_name), `<div class="quote-detail"><div class="quote-detail-meta">${badge(q.status)}<span>Valid through ${escape(quoteDate(q.expiry_date))}</span></div><div class="quote-detail-items">${q.line_items.map((item) => `<div><span><strong>${escape(item.description)}</strong><small>${escape(item.quantity)} × ${escape(money(Math.round(item.unit_price * 100), q.currency))}</small></span><strong>${escape(money(item.line_total_cents, q.currency))}</strong></div>`).join("")}</div>${quoteTotalsMarkup(q)}${q.notes ? `<div class="quote-note"><strong>Note to your customer</strong><p>${escape(q.notes)}</p></div>` : ""}${q.status !== "draft" && customerLink ? `<div class="quote-link-box"><strong>Customer link</strong><a href="${escape(customerLink)}" target="_blank" rel="noopener">Open the customer’s quote </a><div class="copy-link-row"><input aria-label="Customer quote link" value="${escape(customerLink)}" readonly><button type="button" class="button secondary" data-action="copy-quote-link" data-url="${escape(customerLink)}">Copy link</button></div><p class="note">Anyone with this link can view and respond. Opening it records a view.</p></div>` : ""}${(q.deliveries || []).some(quoteDeliveryNeedsAttention) ? `<div class="error-box">${(q.deliveries || []).filter(quoteDeliveryNeedsAttention).map((d) => `${escape(d.channel === "email" ? "Email" : "Text")}: ${escape(d.error || "Sending could not be confirmed. Check the activity log.")}`).join("<br>")}</div>` : ""}${quoteDeliveryTimeline(q.deliveries || [])}<div class="quote-reminders"><strong>${escape(quoteFollowUpText(q))}</strong>${quoteFollowUpChannels(q) ? `<p class="note">${escape(quoteFollowUpChannels(q))}</p>` : ""}${unanswered && !q.follow_ups_cancelled_at && quoteFollowUpsPending(q) ? `<button class="text-button" data-action="cancel-quote-followups" data-id="${escape(q.id)}">Stop reminders</button>` : ""}</div>${unanswered && isDemo() ? `<div class="quote-demo-tools"><strong>Try the automatic reminders</strong><p class="note">Move this business’s demo quotes forward. No real texts or emails are sent.</p><div><button class="button secondary small-button" data-action="quote-demo-advance" data-days="2" data-id="${escape(q.id)}">Move forward 2 days</button><button class="button secondary small-button" data-action="quote-demo-advance" data-days="3" data-id="${escape(q.id)}">Then 3 more days</button></div></div>` : ""}<div class="form-actions"><button class="button secondary" data-action="close">Close</button>${quoteJobAction(q)}${q.status === "draft" && !(q.deliveries || []).length ? `<button class="button secondary" data-action="edit-quote" data-id="${escape(q.id)}">Edit draft</button>` : ""}${["draft", "sent", "viewed"].includes(q.status) && (q.sendable_channels || ["sms", "email"]).length ? `<button class="button" data-action="send-quote" data-id="${escape(q.id)}">${q.status === "draft" ? "Send quote" : "Send link"} </button>` : ""}</div></div>`, true);
}
async function quoteSendModal(id) {
  const context = base();
  const loading = openModal("Getting your quote ready", "Checking how your customer can receive it.", loadingMarkup("Getting quote ready"));
  let q;
  try { q = await api(`${context}/quotes/${encodeURIComponent(id)}`); }
  catch (error) { if (loading !== modalGeneration) return; openModal("Couldn’t open this quote", "Try again in a moment.", empty("Quote unavailable", escape(error.message), '<button class="button secondary" data-action="close">Close</button>')); throw error; }
  if (loading !== modalGeneration || context !== base()) return;
  if (!["draft", "sent", "viewed"].includes(q.status)) { closeModal(); return; }
  const contact = state.contacts.find((c) => c.id === q.contact_id) || {};
  const sendable = q.sendable_channels || ["sms", "email"];
  const optedOut = Boolean(contact.opted_out || contact.quote_email_opted_out);
  const smsAllowed = Boolean(contact.sms_consent && !optedOut && sendable.includes("sms"));
  const emailAllowed = Boolean(contact.email && !optedOut && sendable.includes("email"));
  openModal("Send your quote.", `${escape(q.contact_name)} · ${escape(money(q.total_cents, q.currency))}`, modalForm(`<div class="quote-send-options"><label class="checkbox-label"><input type="checkbox" name="channel" value="sms" ${smsAllowed ? "checked" : "disabled"}><span><strong>Text message</strong><small>${smsAllowed ? escape(contact.phone) : optedOut ? "This customer has opted out of messages." : !sendable.includes("sms") ? "Already sent or delivery awaiting confirmation." : "Record permission to text this customer first."}</small></span></label><label class="checkbox-label"><input type="checkbox" name="channel" value="email" ${emailAllowed ? (!smsAllowed ? "checked" : "") : "disabled"}><span><strong>Email</strong><small>${emailAllowed ? escape(contact.email) : optedOut ? "This customer has opted out of messages." : !sendable.includes("email") ? "Already sent or delivery awaiting confirmation." : "Add an email address to this customer first."}</small></span></label></div><p class="note">Your customer gets a private quote link with Accept and Decline buttons. Every quote email includes an unsubscribe link. Unanswered quotes get up to two reminders by the same methods you choose here, with permission.</p>${isDemo() ? '<p class="note"><strong>Demo mode:</strong> no real texts or emails are sent. Open the customer link after sending to try it.</p>' : ""}`, isDemo() ? "Send demo quote" : "Send quote"));
  $("#dialog-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const channels = Array.from(form.querySelectorAll('input[name="channel"]:checked'), (input) => input.value);
    if (!channels.length) { showFormError($("#dialog-error"), new Error("Choose text message, email, or both.")); return; }
    $('button[type="submit"]', form).disabled = true;
    let failure;
    try {
      const sent = await api(`${context}/quotes/${encodeURIComponent(id)}/send`, { method: "POST", body: JSON.stringify({ channels }) });
      if ((sent.deliveries || []).some((delivery) => channels.includes(delivery.channel) && quoteDeliveryNeedsAttention(delivery))) failure = new Error("Some messages could not be sent or confirmed. Check the details below.");
    } catch (error) { failure = error; }
    try { await refresh(); await quoteDetail(id); } catch (error) { failure ||= error; closeModal(); }
    toast(failure ? failure.message : isDemo() ? "Demo quote sent. Open the customer link to try it." : "Quote sent. Your customer can now respond.", Boolean(failure));
  });
}
async function cancelQuoteFollowUps(id) {
  const context = base();
  await api(`${context}/quotes/${encodeURIComponent(id)}/cancel-follow-ups`, { method: "POST", body: "{}" });
  await refresh();
  await quoteDetail(id);
  toast("Automatic reminders stopped for this quote.");
}
async function advanceQuoteDemo(id, days) {
  await api(`${base()}/quotes/demo/advance`, { method: "POST", body: JSON.stringify({ days: Number(days) }) });
  await refresh();
  await quoteDetail(id);
  toast("Demo time moved forward. Check the activity log for reminders.");
}
async function requestModal() {
  const available = state.contacts.filter(
    (c) =>
      c.sms_consent &&
      !c.opted_out &&
      !c.quote_email_opted_out &&
      !state.requests.some((r) => r.contact_id === c.id && r.status !== "done"),
  );
  if (!available.length) {
    openModal(
      "Add a customer first",
      "Add a customer with permission to text before asking for a review.",
      `<p class="note">Customers who have opted out or already have an open request won’t appear here.</p><div class="form-actions"><button class="button" data-action="close-add-contact">${icon("plus")}Add customer</button></div>`,
    );
    return;
  }
  const context = base();
  openModal(
    "Request a review",
    "One friendly text, with your Google review link.",
    modalForm(
      `<div class="form-field"><label for="contact_id">Who did you help?</label><select id="contact_id" name="contact_id">${options(available, available[0].id)}</select></div><div class="eyebrow section-gap">YOUR TEXT MESSAGE</div><div id="sms-preview" class="message-preview" aria-live="polite"><span class="sr-only">Loading your message…</span><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line short"></span></div><p class="note">If you haven’t marked it done after 3 days, we’ll send one polite reminder. Then we’ll leave it there.</p>${isDemo() ? '<p class="note"><strong>Demo mode:</strong> this saves a simulated text. Nothing will be sent.</p>' : ""}`,
      isDemo() ? "Send demo request" : "Send review request",
    ),
  );
  let previewGeneration = 0;
  const preview = async () => {
    const run = ++previewGeneration;
    const submit = $("#dialog-form button[type=submit]");
    submit.disabled = true;
    try {
      const data = await api(`${context}/requests/preview`, {
        method: "POST",
        body: JSON.stringify({ contact_id: $("#contact_id").value }),
      });
      if (run !== previewGeneration || !$("#sms-preview")) return;
      $("#sms-preview").textContent = data.body;
      $("#dialog-error").innerHTML = "";
      submit.disabled = false;
    } catch (err) {
      if ($("#dialog-error")) showFormError($("#dialog-error"), err);
    }
  };
  $("#contact_id").addEventListener("change", preview);
  handleModalSubmit(
    (form) =>
      api(`${context}/requests`, {
        method: "POST",
        body: JSON.stringify(formData(form)),
      }),
    isDemo()
      ? "Demo request saved. No real text was sent."
      : "Review request sent. We’ll handle the follow-up.",
  );
  await preview();
}
function doneModal(id) {
  const r = state.requests.find((x) => String(x.id) === String(id));
  if (!r) return;
  const context = base();
  openModal(
    "Mark request done",
    "Mark " + escape(r.contact_name) + "’s request done?",
    modalForm(
      '<p class="note">This stops any pending reminder. You can mark a request done after seeing their review, or whenever you want to close it out.</p>',
      "Mark done",
    ),
  );
  handleModalSubmit(
    () =>
      api(`${context}/requests/${encodeURIComponent(id)}/done`, {
        method: "POST",
        body: "{}",
      }),
    "Marked done. Any pending reminder is stopped.",
  );
}
function retryNudgeModal(id) {
  const request = (state.dashboard.attention_needed || []).find(
    (r) => String(r.id) === String(id),
  );
  if (!request?.retry_allowed) return;
  const context = base();
  openModal(
    "Try the follow-up again.",
    "One gentle reminder, once it goes through.",
    modalForm(
      `${customerInfo(request)}<p class="note">The last follow-up could not be sent. Retry it for this customer? After a successful nudge, no more reminders will be sent.</p>${isDemo() ? '<p class="note"><strong>Demo mode:</strong> no real text will be sent.</p>' : ""}`,
      "Retry nudge",
    ),
  );
  $("#dialog-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("button[type=submit]", event.currentTarget).disabled = true;
    let failure;
    try {
      await api(`${context}/requests/${encodeURIComponent(id)}/retry-nudge`, {
        method: "POST",
        body: "{}",
      });
    } catch (error) {
      failure = error;
    }
    // Re-read retry eligibility even on rejection: an uncertain delivery must
    // not leave an old confirmation open with an enabled send button.
    closeModal();
    try {
      await refresh();
    } catch (error) {
      failure ||= error;
    }
    toast(failure ? failure.message : "Follow-up nudge sent.", Boolean(failure));
  });
}
function demoNudge() {
  const context = base();
  openModal(
    "Take the follow-up for a spin.",
    "See what happens after 3 days, without the wait.",
    modalForm(
      '<p class="note">This moves pending demo reminders forward by 3 days for <strong>' +
        escape(state.business.name) +
        "</strong>, then checks which ones are due. Each eligible request gets one simulated nudge. No real texts are sent.</p>",
      "Run demo follow-up",
    ),
  );
  handleModalSubmit(
    () =>
      api(`${context}/demo/advance`, {
        method: "POST",
        body: JSON.stringify({ days: 3 }),
      }),
    "Demo follow-up checked. See the activity log for the results.",
  );
}
// Jobs keep appointment dates in the business's chosen time zone. These are
// calendar dates and wall-clock times, not instants to convert to the viewer's zone.
const jobStatuses = {
  awaiting_scheduling: "Needs booking", scheduled: "Booked", waiting_parts: "Waiting for parts",
  in_progress: "In progress", completed: "Completed", follow_up: "Follow-up needed", cancelled: "Cancelled",
};
function jobToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function jobAddDays(value, days) {
  const day = new Date(`${value}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}
function jobDate(value) {
  return value ? new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Not booked yet";
}
function jobTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return "";
  const [hour, minute] = value.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}
function jobWindow(job) {
  return job.arrival_start && job.arrival_end ? `${jobTime(job.arrival_start)} to ${jobTime(job.arrival_end)}` : "Arrival window not set";
}
function jobBadge(status) {
  return `<span class="badge admin-job-status ${escape(status)}">${escape(jobStatuses[status] || status)}</span>`;
}
function defaultJobZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Toronto";
}
function newJobsUi() { return { view: "list", query: "", status: "all", type: "all", contact: "", day: jobToday(), span: "week" }; }
let jobsUi = newJobsUi();
function filteredJobs(jobs = state.jobs || [], filters = jobsUi) {
  const query = (filters.query || "").trim().toLowerCase();
  return jobs.filter((job) => (!filters.contact || String(job.contact_id) === String(filters.contact)) && (!query || `${job.title} ${job.reference || ""} ${job.contact_name} ${job.service_address}`.toLowerCase().includes(query)) && (filters.status === "all" || job.status === filters.status) && (filters.type === "all" || job.job_type === filters.type));
}
function jobsTable(jobs, compact = false) {
  if (!jobs.length) return empty("No matching jobs", "Try another search or filter.");
  return responsiveTable(`<table><thead><tr><th>Job & customer</th><th>Status</th><th>Visit</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${jobs.map((job) => `<tr><td><strong>${escape(job.title)}</strong><small class="quote-reference">${escape(job.contact_name)}${compact ? "" : ` · ${job.job_type === "installation" ? "Installation" : "Service"}`}</small>${compact ? "" : `<small class="quote-reference">${escape(job.service_address)}</small>`}</td><td>${jobBadge(job.status)}</td><td><span>${escape(jobDate(job.scheduled_date))}</span>${job.scheduled_date ? `<small class="quote-reference">${escape(jobWindow(job))}</small><small class="quote-reference">${escape(job.time_zone)}</small>` : ""}</td><td><button class="text-button table-action" data-action="view-job" data-id="${escape(job.id)}">View job</button></td></tr>`).join("")}</tbody></table>`, ["Job & customer", "Status", "Visit", "Actions"]);
}
function jobAgendaRange(filters = jobsUi) {
  const selected = filters.day || jobToday();
  if (filters.span === "day") return { start: selected, end: selected };
  const day = new Date(`${selected}T12:00:00Z`).getUTCDay();
  const start = jobAddDays(selected, -(day + 6) % 7);
  return { start, end: jobAddDays(start, 6) };
}
function jobsAgenda(jobs) {
  const { start, end } = jobAgendaRange();
  const dated = jobs.filter((job) => job.scheduled_date && job.scheduled_date >= start && job.scheduled_date <= end && job.status !== "cancelled");
  const days = [...new Set(dated.map((job) => job.scheduled_date))].sort();
  const unbooked = jobs.filter((job) => !job.scheduled_date && !["completed", "cancelled"].includes(job.status));
  return `<div class="jobs-range-label"><strong>${escape(jobDate(start))}${end !== start ? ` to ${escape(jobDate(end))}` : ""}</strong><p class="note">Arrival windows use each job’s saved time zone.</p></div>${days.length ? days.map((day) => `<section class="panel jobs-agenda-day"><div class="panel-heading"><h2>${escape(jobDate(day))}</h2></div><div class="table-panel">${jobsTable(dated.filter((job) => job.scheduled_date === day).sort((a, b) => (a.arrival_start || "").localeCompare(b.arrival_start || "")), true)}</div></section>`).join("") : `<section class="panel">${empty("No visits in this view", "Choose another date, or book a job below.")}</section>`}<section class="panel jobs-agenda-day"><div class="panel-heading"><div><h2>Needs a date</h2><p>Jobs without a booked visit, across all dates.</p></div></div><div class="table-panel">${unbooked.length ? jobsTable(unbooked, true) : empty("Everything has a date", "Unbooked jobs will appear here.")}</div></section>`;
}
function jobsResults() {
  const jobs = filteredJobs();
  if (!(state.jobs || []).length) return `<section class="panel">${empty("A place for the work ahead", "Create a job from an accepted quote, or add a service visit here.", '<button class="button secondary" data-action="add-job">Add a job</button>')}</section>`;
  return jobsUi.view === "schedule" ? jobsAgenda(jobs) : `<section class="panel table-panel">${jobsTable(jobs)}</section>`;
}
function jobsPage() {
  return `${heading("Jobs & schedule", "Book the visit. Keep the work and your customer up to date.", '<button class="button" data-action="add-job">' + icon("plus") + 'Add a job</button>')}<div class="jobs-view-bar"><div class="jobs-view-switch" aria-label="Job view"><button class="button ${jobsUi.view === "list" ? "" : "secondary"}" data-action="jobs-view" data-view="list" aria-pressed="${jobsUi.view === "list"}">Job list</button><button class="button ${jobsUi.view === "schedule" ? "" : "secondary"}" data-action="jobs-view" data-view="schedule" aria-pressed="${jobsUi.view === "schedule"}">Schedule</button></div><p class="note">Your schedule and updates are recorded here. No appointment messages are sent.</p></div><div class="toolbar jobs-toolbar"><div class="search-field">${icon("search")}<input id="jobs-search" value="${escape(jobsUi.query)}" placeholder="Find a job or customer…" aria-label="Find a job or customer"></div><select id="jobs-status" class="filter-select" aria-label="Filter job status"><option value="all">All statuses</option>${Object.entries(jobStatuses).map(([key, label]) => `<option value="${key}" ${jobsUi.status === key ? "selected" : ""}>${label}</option>`).join("")}</select><select id="jobs-type" class="filter-select" aria-label="Filter job type"><option value="all">Service & installation</option><option value="service" ${jobsUi.type === "service" ? "selected" : ""}>Service</option><option value="installation" ${jobsUi.type === "installation" ? "selected" : ""}>Installation</option></select></div>${jobsUi.view === "schedule" ? `<div class="jobs-date-controls"><label class="form-field" for="jobs-day">Show visits around<input id="jobs-day" type="date" value="${escape(jobsUi.day)}" required></label><label class="form-field" for="jobs-span">View<select id="jobs-span"><option value="day" ${jobsUi.span === "day" ? "selected" : ""}>Day</option><option value="week" ${jobsUi.span === "week" ? "selected" : ""}>Week</option></select></label><button class="button secondary" data-action="jobs-today">Today</button></div>` : ""}${jobsUi.contact ? `<div class="jobs-contact-filter"><span>Jobs for <strong>${escape(state.contacts.find((contact) => String(contact.id) === String(jobsUi.contact))?.name || "this customer")}</strong></span><button class="text-button" data-action="clear-job-customer">Show all customers</button></div>` : ""}<div id="jobs-results">${jobsResults()}</div>`;
}
function bindJobFilters() {
  const update = () => {
    jobsUi.query = $("#jobs-search").value;
    jobsUi.status = $("#jobs-status").value;
    jobsUi.type = $("#jobs-type").value;
    if ($("#jobs-day")?.value) jobsUi.day = $("#jobs-day").value;
    if ($("#jobs-span")) jobsUi.span = $("#jobs-span").value;
    $("#jobs-results").innerHTML = jobsResults();
  };
  $("#jobs-search").addEventListener("input", update);
  ["#jobs-status", "#jobs-type", "#jobs-day", "#jobs-span"].forEach((selector) => $(selector)?.addEventListener("change", update));
}
function dashboardJobs() {
  const open = (state.jobs || []).filter((job) => !["completed", "cancelled"].includes(job.status));
  const unbooked = open.filter((job) => !job.scheduled_date);
  const upcoming = open.filter((job) => job.scheduled_date >= jobToday()).sort((a, b) => `${a.scheduled_date}${a.arrival_start}`.localeCompare(`${b.scheduled_date}${b.arrival_start}`));
  return `<section class="panel jobs-dashboard"><div class="panel-heading"><div><h2>Your next jobs</h2><p>Booked visits and work that needs a date.</p></div><a href="#jobs" class="text-button">Jobs & schedule</a></div>${upcoming.length ? `<div class="table-panel">${jobsTable(upcoming.slice(0, 4), true)}</div>` : `<p class="admin-job-empty-line">No upcoming visits booked.</p>`}${unbooked.length ? `<div class="admin-job-booking"><h3>Needs booking</h3>${unbooked.slice(0, 4).map((job) => `<div class="admin-job-booking-row"><span><strong>${escape(job.title)}</strong><small>${escape(job.contact_name)}</small></span><button class="text-button" data-action="view-job" data-id="${escape(job.id)}">Book visit</button></div>`).join("")}</div>` : ""}${!open.length ? `<div class="admin-job-empty-line"><p>Accepted a quote? Turn it into a job to keep the next steps together.</p><a href="#jobs" class="text-button">Open jobs</a></div>` : ""}</section>`;
}
function quoteJobAction(quote) {
  if (quote.status !== "accepted") return "";
  const job = (state.jobs || []).find((item) => String(item.quote_id) === String(quote.id));
  return job ? `<button class="button" data-action="view-job" data-id="${escape(job.id)}">View job</button>` : `<button class="button" data-action="quote-to-job" data-id="${escape(quote.id)}">Create job</button>`;
}
function jobQuoteOptions(contactId, selected = "") {
  return '<option value="">No linked quote</option>' + (state.quotes || []).filter((quote) => quote.status === "accepted" && String(quote.contact_id) === String(contactId)).map((quote) => `<option value="${escape(quote.id)}" ${String(selected) === String(quote.id) ? "selected" : ""}>${escape(quote.reference || "Accepted quote")} · ${escape(money(quote.total_cents, quote.currency))}</option>`).join("");
}
function jobZoneOptions(selected) {
  const zones = new Map([
    ["America/St_Johns", "Newfoundland · St. John’s"], ["America/Halifax", "Atlantic · Halifax"],
    ["America/Toronto", "Eastern · Toronto"], ["America/Winnipeg", "Central · Winnipeg"],
    ["America/Regina", "Saskatchewan · Regina"], ["America/Edmonton", "Mountain · Edmonton"],
    ["America/Vancouver", "Pacific · Vancouver"], ["America/Whitehorse", "Yukon · Whitehorse"],
  ]);
  if (!zones.has(selected)) zones.set(selected, selected.replaceAll("_", " "));
  return [...zones].map(([zone, label]) => `<option value="${escape(zone)}" ${selected === zone ? "selected" : ""}>${escape(label)} (${escape(zone)})</option>`).join("");
}
function jobFormPayload(form) {
  const value = (id) => $(id, form).value;
  const status = value("#job-status");
  return {
    contact_id: value("#job-contact"), quote_id: value("#job-quote") || null,
    title: value("#job-title"), description: value("#job-description"), service_address: value("#job-address"),
    job_type: value("#job-type"), status,
    scheduled_date: status === "awaiting_scheduling" ? "" : value("#job-date"),
    arrival_start: status === "awaiting_scheduling" ? "" : value("#job-start"),
    arrival_end: status === "awaiting_scheduling" ? "" : value("#job-end"),
    time_zone: value("#job-zone"), private_notes: value("#job-private-notes"), customer_update: value("#job-update"),
  };
}
function jobEditor(id, quoteId) {
  const job = (state.jobs || []).find((item) => String(item.id) === String(id)) || {};
  const quote = (state.quotes || []).find((item) => String(item.id) === String(quoteId) && item.status === "accepted");
  if (quote) {
    const existing = (state.jobs || []).find((item) => String(item.quote_id) === String(quote.id));
    if (existing) return jobDetail(existing.id);
  }
  if (!state.contacts.length) {
    openModal("First, add your customer.", "A job needs a customer to go with it.", '<div class="form-actions"><button class="button" data-action="close-add-contact">Add customer</button></div>');
    return;
  }
  const context = base();
  const contactId = job.contact_id || quote?.contact_id || state.contacts[0].id;
  const title = job.title || quote?.line_items?.[0]?.description || "";
  const description = job.description || (quote?.line_items || []).map((item) => item.description).join("\n");
  const selectedQuote = job.quote_id || quote?.id || "";
  const opened = openModal(job.id ? "Edit job" : "Add a job", job.id ? "Keep the visit and progress up to date." : "Save the work first. You choose when to share the customer page.", modalForm(`<div class="admin-job-editor"><section class="admin-job-form-section"><h3>Customer sees</h3><p class="note">These details appear on this job’s customer page when its link is enabled.</p><div class="form-grid"><div class="form-field"><label for="job-contact">Customer</label><select id="job-contact" required ${job.id ? "disabled" : ""}>${options(state.contacts, contactId)}</select>${job.id ? '<small>The customer stays with this job.</small>' : ""}</div><div class="form-field"><label for="job-quote">Accepted quote (optional)</label><select id="job-quote" ${job.id ? "disabled" : ""}>${jobQuoteOptions(contactId, selectedQuote)}</select><small>Quoted prices and terms stay unchanged.</small></div></div><div class="form-field"><label for="job-title">Job name</label><input id="job-title" value="${escape(title)}" placeholder="e.g. Furnace service" maxlength="160" required></div><div class="form-field"><label for="job-address">Service address</label><input id="job-address" value="${escape(job.service_address || "")}" autocomplete="street-address" maxlength="1000" required></div><div class="form-grid"><div class="form-field"><label for="job-type">Type of work</label><select id="job-type"><option value="service" ${job.job_type !== "installation" ? "selected" : ""}>Service</option><option value="installation" ${job.job_type === "installation" ? "selected" : ""}>Installation</option></select></div><div class="form-field"><label for="job-status">Job status</label><select id="job-status">${Object.entries(jobStatuses).map(([status, label]) => `<option value="${status}" ${(job.status || "awaiting_scheduling") === status ? "selected" : ""}>${label}</option>`).join("")}</select></div></div><div class="form-field"><label for="job-description">Work to be done</label><textarea id="job-description" maxlength="5000" placeholder="What’s included in this job?">${escape(description)}</textarea></div><div class="admin-job-schedule" id="job-schedule"><h3>Visit details</h3><p class="note" id="job-schedule-help">Choose a local date and arrival window. Times stay in the time zone below.</p><div class="form-field"><label for="job-date">Visit date</label><input id="job-date" type="date" value="${escape(job.scheduled_date || "")}" aria-describedby="job-schedule-help"></div><div class="form-grid"><div class="form-field"><label for="job-start">Arrive from</label><input id="job-start" type="time" value="${escape(job.arrival_start || "")}"></div><div class="form-field"><label for="job-end">Arrive by</label><input id="job-end" type="time" value="${escape(job.arrival_end || "")}"></div></div><div class="form-field"><label for="job-zone">Visit time zone</label><select id="job-zone">${jobZoneOptions(job.time_zone || defaultJobZone())}</select><small>The customer sees this time zone with their visit.</small></div></div><div class="form-field"><label for="job-update">New update for your customer (optional)</label><textarea id="job-update" maxlength="5000" placeholder="e.g. The part has arrived. We’ll confirm a visit date with you."></textarea><small>Saved to the customer page’s update history. No text or email is sent.</small></div></section><section class="admin-job-form-section admin-job-private"><h3>Internal notes</h3><p class="note">Only the business owner can see these. They never appear on the customer page.</p><div class="form-field"><label for="job-private-notes">Notes for you (optional)</label><textarea id="job-private-notes" maxlength="10000">${escape(job.private_notes || "")}</textarea></div></section></div>`, "Save job"), true);
  const form = $("#dialog-form");
  const syncSchedule = () => {
    const status = $("#job-status", form).value;
    ["#job-date", "#job-start", "#job-end"].forEach((selector) => {
      const input = $(selector, form);
      input.disabled = status === "awaiting_scheduling";
      input.required = status === "scheduled";
    });
    $("#job-schedule-help", form).textContent = status === "awaiting_scheduling" ? "This job needs booking. Choose Booked when you have a date and arrival window." : "Choose a local date and arrival window. Times stay in the time zone below.";
  };
  $("#job-status", form).addEventListener("change", syncSchedule);
  if (!job.id) {
    $("#job-contact", form).addEventListener("change", () => { $("#job-quote", form).innerHTML = jobQuoteOptions($("#job-contact", form).value); });
    $("#job-quote", form).addEventListener("change", () => {
      const picked = (state.quotes || []).find((item) => String(item.id) === $("#job-quote", form).value);
      if (!picked) return;
      if (!$("#job-title", form).value.trim()) $("#job-title", form).value = picked.line_items?.[0]?.description || "";
      if (!$("#job-description", form).value.trim()) $("#job-description", form).value = (picked.line_items || []).map((item) => item.description).join("\n");
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      const saved = await api(`${context}/jobs${job.id ? "/" + encodeURIComponent(job.id) : ""}`, { method: job.id ? "PATCH" : "POST", body: JSON.stringify(jobFormPayload(form)) });
      if (opened !== modalGeneration || context !== base()) return;
      await refresh();
      if (opened !== modalGeneration || context !== base()) return;
      await jobDetail(saved.id);
      toast("Job saved.");
    } catch (error) { if (opened === modalGeneration && context === base()) { showFormError($("#dialog-error"), error); submit.disabled = false; } }
  });
  syncSchedule();
}
function safeJobUrl(url) {
  try {
    if (!url) return "";
    const parsed = new URL(url, location.href);
    if (parsed.username || parsed.password) return "";
    const localDemo = state.config.browser_demo && parsed.protocol === "file:" && parsed.pathname === location.pathname && /^#job\/[A-Za-z0-9_-]+$/.test(parsed.hash);
    return ["https:", "http:"].includes(parsed.protocol) || localDemo ? parsed.href : "";
  } catch { return ""; }
}
function jobHistory(job) {
  return `<section class="admin-job-section"><h3>Customer update history</h3>${(job.public_updates || []).length ? `<ol class="delivery-timeline">${[...job.public_updates].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map((update) => `<li class="delivery-event"><div><strong>${escape(jobStatuses[update.status] || update.status)}</strong><p class="admin-job-message">${escape(update.message)}</p></div><time datetime="${escape(update.created_at)}">${escape(fullDate(update.created_at))}</time></li>`).join("")}</ol>` : '<p class="note">No updates recorded yet. Add a customer update when there’s something to share.</p>'}</section>`;
}
function jobDetailMarkup(job) {
  const link = job.link_enabled ? safeJobUrl(job.public_url) : "";
  return `<div class="admin-job-detail"><div class="quote-detail-meta">${jobBadge(job.status)}<span>${job.job_type === "installation" ? "Installation" : "Service"}</span><span>${escape(job.reference || "")}</span></div><section class="admin-job-section"><h3>Service address</h3><p class="admin-job-message">${escape(job.service_address)}</p>${job.description ? `<h3>Work to be done</h3><p class="admin-job-message">${escape(job.description)}</p>` : ""}</section><section class="admin-job-section admin-job-visit"><h3>Visit</h3><strong>${escape(jobDate(job.scheduled_date))}</strong>${job.scheduled_date ? `<p>${escape(jobWindow(job))}<br><span class="note">${escape(job.time_zone)}</span></p>` : '<p class="note">Edit this job to add a date and arrival window.</p>'}</section>${job.quote_id ? `<section class="admin-job-section"><h3>Accepted quote</h3><button class="text-button" data-action="view-quote" data-id="${escape(job.quote_id)}">View ${escape(job.quote?.reference || "accepted quote")}</button><p class="note">The accepted quote keeps its original prices and terms.</p></section>` : ""}${jobHistory(job)}<section class="admin-job-section admin-job-private"><h3>Internal notes · owner only</h3><p class="note">These notes are never shown on the customer page.</p><p class="admin-job-message">${escape(job.private_notes || "No internal notes yet.")}</p></section><section class="quote-link-box"><h3>Customer job page</h3>${link ? `<a href="${escape(link)}" target="_blank" rel="noopener">Open customer job page</a><div class="copy-link-row"><input aria-label="Customer job link" value="${escape(link)}" readonly><button class="button secondary" data-action="copy-job-link" data-url="${escape(link)}">Copy link</button></div><p class="note">Anyone with this link can view this job. Share it only with your customer. Internal notes are never included. No text or email is sent.</p><div class="admin-job-link-actions"><button class="text-button" data-action="rotate-job-link" data-id="${escape(job.id)}">Replace link</button><button class="text-button" data-action="revoke-job-link" data-id="${escape(job.id)}">Turn off link</button></div>` : `<p class="note">The customer page is private until you enable its link. Anyone you share that link with can view this job only.</p><button class="button secondary" data-action="share-job" data-id="${escape(job.id)}">Enable customer link</button><p class="note">This creates a link to copy. No text or email is sent.</p>`}</section><div class="form-actions"><button class="button secondary" data-action="close">Close</button><button class="button" data-action="edit-job" data-id="${escape(job.id)}">Edit job</button></div></div>`;
}
async function jobDetail(id) {
  const context = base();
  const loading = openModal("Opening job", "The details will be ready in a moment.", loadingMarkup("Opening job"), true);
  let job;
  try { job = await api(`${context}/jobs/${encodeURIComponent(id)}`); }
  catch (error) {
    if (loading !== modalGeneration || context !== base()) return;
    openModal("Couldn’t open this job", "Try again in a moment.", empty("Job unavailable", escape(error.message), '<button class="button secondary" data-action="close">Close</button>'));
    throw error;
  }
  if (loading !== modalGeneration || context !== base()) return;
  // Refresh this record so an edit opened from its detail uses the latest values.
  const cachedJobs = state.jobs || [];
  state.jobs = cachedJobs.some((item) => String(item.id) === String(job.id)) ? cachedJobs.map((item) => String(item.id) === String(job.id) ? job : item) : [job, ...cachedJobs];
  openModal(escape(job.title), escape(job.contact_name), jobDetailMarkup(job), true);
}
async function changeJobLink(id, action) {
  const context = base(), opened = modalGeneration;
  await api(`${context}/jobs/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
  if (opened !== modalGeneration || context !== base()) return;
  await refresh();
  if (opened !== modalGeneration || context !== base()) return;
  await jobDetail(id);
  toast(action === "revoke-link" ? "Customer link turned off." : action === "rotate-link" ? "New customer link ready. The old link no longer works." : "Customer link ready to copy.");
}
function jobLinkModal(id, action) {
  const replacing = action === "rotate-link";
  openModal(replacing ? "Replace this customer link?" : "Turn off this customer link?", "The current link will stop working immediately.", modalForm(`<p class="note">${replacing ? "A new link will be ready to copy. Share the new link with your customer yourself." : "The job and its history stay in your workspace. You can enable a new link later."} No text or email is sent.</p>`, replacing ? "Replace link" : "Turn off link"));
  const context = base(), opened = modalGeneration;
  $("#dialog-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $('button[type="submit"]', event.currentTarget);
    submit.disabled = true;
    try { await changeJobLink(id, action); }
    catch (error) { if (opened === modalGeneration && context === base()) { showFormError($("#dialog-error"), error); submit.disabled = false; } }
  });
}
let browserJobGeneration = 0;
async function renderBrowserCustomerJob(token) {
  const run = ++browserJobGeneration;
  document.title = "Your job · Tradesuite";
  $("#main").innerHTML = loadingMarkup("Opening your job");
  try {
    const job = await api(`/j/${encodeURIComponent(token)}/data`);
    if (run !== browserJobGeneration || location.hash !== `#job/${token}`) return;
    document.title = `${job.business.name} | Your job`;
    $("#main").innerHTML = `<div class="browser-customer-quote"><a class="browser-quote-back" href="#jobs">Back to workspace</a>${jobPublicMarkup(job, { localPreview: true })}${draftDocumentLinks()}</div>`;
  } catch (error) {
    if (run !== browserJobGeneration || location.hash !== `#job/${token}`) return;
    document.title = "Job unavailable | Tradesuite";
    $("#main").innerHTML = `<div class="browser-customer-quote"><a class="browser-quote-back" href="#jobs">Back to workspace</a><section class="panel form-panel"><h1>This job page couldn’t be opened.</h1><p>${escape(error.message)}</p><p>Browser demo links work only in the browser where the job was created.</p></section>${draftDocumentLinks()}</div>`;
  }
}
document.addEventListener("click", async (e) => {
  const decision = e.target.closest("[data-decision]");
  if (decision && state.config.browser_demo && location.hash.startsWith("#quote/")) {
    await respondBrowserCustomerQuote(decision.dataset.decision);
    return;
  }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  try {
    switch (el.dataset.action) {
      case "confirm-email-unsubscribe":
        if (state.config.browser_demo && location.hash === `#unsubscribe/${el.dataset.token}`) {
          el.disabled = true;
          await renderBrowserUnsubscribe(el.dataset.token, true);
        }
        break;
      case "add-business":
        businessModal();
        break;
      case "add-contact":
        contactModal();
        break;
      case "edit-contact":
        contactModal(el.dataset.id);
        break;
      case "customer-jobs":
        jobsUi = { ...newJobsUi(), contact: el.dataset.id };
        location.hash = "#jobs";
        break;
      case "clear-job-customer":
        jobsUi.contact = "";
        render();
        break;
      case "request":
        await requestModal();
        break;
      case "add-quote":
        quoteEditor();
        break;
      case "edit-quote":
        quoteEditor(el.dataset.id);
        break;
      case "view-quote":
        await quoteDetail(el.dataset.id);
        break;
      case "add-job":
        jobEditor();
        break;
      case "quote-to-job":
        await jobEditor(undefined, el.dataset.id);
        break;
      case "edit-job":
        jobEditor(el.dataset.id);
        break;
      case "view-job":
        await jobDetail(el.dataset.id);
        break;
      case "jobs-view":
        jobsUi.view = el.dataset.view === "schedule" ? "schedule" : "list";
        render();
        break;
      case "jobs-today":
        jobsUi.day = jobToday();
        render();
        break;
      case "share-job":
        el.disabled = true;
        try { await changeJobLink(el.dataset.id, "share"); } finally { el.disabled = false; }
        break;
      case "rotate-job-link":
        jobLinkModal(el.dataset.id, "rotate-link");
        break;
      case "revoke-job-link":
        jobLinkModal(el.dataset.id, "revoke-link");
        break;
      case "copy-job-link": {
        const link = safeJobUrl(el.dataset.url);
        if (!link) throw new Error("This customer link is unavailable.");
        try {
          await navigator.clipboard.writeText(link);
          el.textContent = "Copied";
          toast("Link copied");
        } catch {
          const input = el.parentElement.querySelector("input");
          input.focus(); input.select();
          toast("Select and copy the customer link above.");
        }
        break;
      }
      case "copy-quote-link": {
        const link = safeQuoteUrl(el.dataset.url);
        if (!link) throw new Error("This customer link is unavailable.");
        try {
          await navigator.clipboard.writeText(link);
          el.textContent = "Copied";
          toast("Link copied");
        } catch {
          const input = el.parentElement.querySelector("input");
          input.focus(); input.select();
          toast("Select and copy the customer link above.");
        }
        break;
      }
      case "send-quote":
        await quoteSendModal(el.dataset.id);
        break;
      case "cancel-quote-followups":
        el.disabled = true;
        try { await cancelQuoteFollowUps(el.dataset.id); } finally { el.disabled = false; }
        break;
      case "quote-demo-advance":
        el.disabled = true;
        try { await advanceQuoteDemo(el.dataset.id, el.dataset.days); } finally { el.disabled = false; }
        break;
      case "done":
        doneModal(el.dataset.id);
        break;
      case "retry-nudge":
        retryNudgeModal(el.dataset.id);
        break;
      case "demo-nudge":
        demoNudge();
        break;
      case "close":
        closeModal();
        break;
      case "close-add-contact":
        closeModal();
        contactModal();
        break;
    }
  } catch (err) {
    toast(err.message, true);
  }
});
async function switchBusiness(id) {
  closeModal();
  jobsUi = newJobsUi();
  state.business = state.businesses.find((x) => String(x.id) === String(id));
  Object.assign(state, {
    contacts: [],
    requests: [],
    quotes: [],
    jobs: [],
    activity: [],
    dashboard: {},
  });
  render();
  try {
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}
document.addEventListener("change", (e) => {
  if (e.target.matches("#business-select,.mobile-business"))
    switchBusiness(e.target.value);
});
window.addEventListener("hashchange", () => {
  render();
  refresh().catch((err) => toast(err.message, true));
});
$("#modal").addEventListener("cancel", () => modalGeneration++);
$("#modal").addEventListener("close", () => {
  if (!$("#modal").open) modalGeneration++;
  document.body.appendChild($("#toast"));
});
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      closeModal();
  }
});
refresh().catch((err) => {
  $("#main").innerHTML = empty(
    "We couldn’t open your workspace.",
    escape(err.message),
    '<button class="button" id="retry">Try again</button>',
  );
  $("#retry")?.addEventListener("click", () => location.reload());
});

// Keep automatic follow-ups visible without disturbing an open form.
setInterval(() => {
  if (
    !document.hidden &&
    !browserCustomerQuoteSending &&
    !$("#modal").open &&
    state.page !== "settings" &&
    !document.activeElement?.matches("input,textarea,select")
  ) {
    refresh().catch(() => {});
  }
}, 30000);
