const $ = (s, el = document) => el.querySelector(s);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  people:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  message:
    "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2-5a8.5 8.5 0 1 1 16-3.5 M8 10h8 M8 14h5",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  plus: "M12 5v14 M5 12h14",
  check: "M5 12l4 4L19 6",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z",
  bulb: "M9 18h6 M9 21h6 M8 14a6 6 0 1 1 8 0l-1 2H9z",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
  close: "M6 6l12 12 M18 6 6 18",
  send: "m22 2-7 20-4-9L2 9z M22 2 11 13",
  shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6",
  edit: "m15 4 5 5 M4 20l5-1L21 7a3.5 3.5 0 0 0-5-5L4 14z",
  quote: "M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h3",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.message}"/></svg>`;
const nav = [
  ["dashboard", "Overview", "grid"],
  ["contacts", "Customers", "people"],
  ["requests", "Review requests", "message"],
  ["quotes", "Quotes", "quote"],
  ["activity", "Activity", "activity"],
  ["settings", "Business settings", "settings"],
];
let state = {
  businesses: [],
  config: { sms_mode: "demo" },
  business: null,
  contacts: [],
  requests: [],
  quotes: [],
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
    : "—";
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
  return `<div class="empty">${icon("message")}<strong>${title}</strong><p>${subtitle}</p>${button}</div>`;
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
function dashboardMetrics(requests, quotes, now = new Date()) {
  const day = 86400000, current = new Date(now).getTime(), previous = current - 7 * day;
  const timestamp = (value) => value ? Date.parse(value) : NaN;
  const inWeek = (value, end) => timestamp(value) > end - 7 * day && timestamp(value) <= end;
  const sentAt = (q) => timestamp(q.sent_at);
  const delivered = quotes.filter((q) => q.status !== "draft" && Number.isFinite(sentAt(q)));
  const openAt = (q, time) => sentAt(q) <= time &&
    (!q.responded_at || timestamp(q.responded_at) > time) &&
    (!q.expiry_date || timestamp(`${q.expiry_date}T23:59:59.999Z`) >= time) &&
    (!["accepted", "declined"].includes(q.status) || Boolean(q.responded_at));
  const reminderDates = requests.filter((r) => r.nudged_at).map((r) => r.nudged_at).concat(quotes.flatMap((q) => (q.deliveries || []).filter((d) => ["nudge_2", "nudge_5"].includes(d.kind) && ["sent", "simulated"].includes(d.status)).map((d) => d.updated_at || d.created_at)));
  const weekDelta = (dates) => dates.filter((d) => inWeek(d, current)).length - dates.filter((d) => inWeek(d, previous)).length;
  const percent = (accepted, total) => total ? Math.round(accepted / total * 1000) / 10 : 0;
  const priorDelivered = delivered.filter((q) => sentAt(q) <= previous);
  const conversion = percent(delivered.filter((q) => q.status === "accepted").length, delivered.length);
  const priorConversion = percent(priorDelivered.filter((q) => q.status === "accepted" && timestamp(q.responded_at) <= previous).length, priorDelivered.length);
  const awaiting = quotes.filter((q) => ["sent", "viewed"].includes(q.status)).length;
  return {
    reviews: { value: requests.length, delta: weekDelta(requests.map((r) => r.sent_at)), label: "vs previous 7 days" },
    awaiting: { value: awaiting, delta: awaiting - delivered.filter((q) => openAt(q, previous)).length, label: "vs 7 days ago" },
    nudges: { value: reminderDates.length, delta: weekDelta(reminderDates), label: "vs previous 7 days" },
    conversion: { value: conversion, delta: Math.round((conversion - priorConversion) * 10) / 10, label: "pts vs 7 days ago" },
  };
}
function kpiCard(label, metric, suffix = "") {
  const delta = metric.delta;
  return `<article class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${metric.value.toLocaleString()}${suffix}</div><div class="kpi-meta"><span class="kpi-delta neutral">${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta).toLocaleString()}</span><span>${metric.label}</span></div></article>`;
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
    const [contacts, requests, activity, dashboard, quotes] = await Promise.all([
      api(`${base()}/contacts`),
      api(`${base()}/requests`),
      api(`${base()}/activity`),
      api(`${base()}/dashboard`),
      api(`${base()}/quotes`),
    ]);
    if (run !== generation) return;
    Object.assign(state, { contacts, requests, activity, dashboard, quotes });
  }
  render();
}
function render() {
  state.page = location.hash.slice(1) || "dashboard";
  const customerRoute = state.config.browser_demo && /^quote\/([A-Za-z0-9_-]+)$/.exec(state.page);
  const unsubscribeRoute = state.config.browser_demo && /^unsubscribe\/([A-Za-z0-9_-]+)$/.exec(state.page);
  document.body.classList.toggle("customer-quote-view", Boolean(customerRoute || unsubscribeRoute));
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
      ([id, label, glyph]) =>
        `<a class="nav-link ${state.page === id ? "active" : ""}" ${state.page === id ? 'aria-current="page"' : ""} href="#${id}">${icon(glyph)}<span>${label}</span></a>`,
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
    activity: activityPage,
    settings: settingsPage,
  }[state.page]();
  if (state.page === "settings") bindSettings();
  if (state.page === "contacts" || state.page === "requests") bindFilters();
  if (state.page === "quotes") bindQuoteFilters();
}
function activityRows(items, full = false) {
  return items
    .map((a) => {
      const done = /done|completed|accepted/i.test(a.kind + " " + a.label),
        nudge = /nudge/i.test(a.kind + " " + a.label),
        failed = /fail|unknown/i.test(a.kind + " " + a.label);
      return `<div class="activity-row"><span class="activity-icon ${done ? "done" : nudge ? "nudge" : ""}">${icon(done ? "check" : nudge ? "clock" : failed ? "activity" : /unsubscrib|opt.out/i.test(a.kind + " " + a.label) ? "shield" : /draft/i.test(a.label) ? "quote" : "send")}</span><div class="activity-copy"><strong>${escape(a.label || a.kind)}</strong><small>${escape(a.contact_name || state.business.name)}${a.mode === "demo" ? " · Demo" : ""}</small>${full && a.body ? `<div class="activity-message">${escape(a.body)}</div>` : ""}</div><time datetime="${escape(a.created_at)}" title="${escape(fullDate(a.created_at))}">${full ? escape(fullDate(a.created_at)) : ago(a.created_at)}</time></div>`;
    })
    .join("");
}
function requestTable(requests, limited = false) {
  if (!requests.length && !limited && state.requests.length) return empty("No matching requests", "Try another customer name or status.");
  if (!requests.length)
    return empty(
      "Your first good word starts here",
      "Pick a happy customer and ask for a review.",
      requestButton("Request a review", true),
    );
  return responsiveTable(`<table><thead><tr><th>Customer</th><th>Status</th><th>Requested</th><th>${limited ? "Next step" : "Follow-up"}</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${requests.map((r) => `<tr><td>${customerInfo(r)}${r.mode === "demo" ? '<small class="subtle">Demo request</small>' : ""}</td><td>${badge(r.status)}</td><td title="${escape(fullDate(r.sent_at))}">${date(r.sent_at)}</td><td>${r.status === "done" ? "All wrapped up" : r.status === "nudged" ? "No more follow-ups" : r.nudge_attempted_at ? "Follow-up attempted" : `One nudge ${date(r.nudge_due_at)}`}</td><td>${r.status !== "done" ? `<button class="text-button table-action" data-action="done" data-id="${escape(r.id)}">Mark done ${icon("check")}</button>` : '<span class="subtle">Completed</span>'}</td></tr>`).join("")}</tbody></table>`, ["Customer","Status","Requested","Follow-up","Actions"]);
}
function attentionNeeded(requests) {
  if (!requests.length) return "";
  return `<section class="panel attention-panel" aria-labelledby="attention-heading"><div class="panel-heading"><div><h2 id="attention-heading">Attention needed</h2><p>These follow-ups need a hand.</p></div></div><div class="attention-list">${requests.map((r) => `<div class="attention-row"><div>${customerInfo(r)}<p class="attention-error">${escape(r.nudge_error || "The follow-up could not be sent.")}</p>${!r.retry_allowed ? `<p class="note">${escape(r.retry_blocked_reason || "Check the activity log before trying again.")}</p>` : ""}</div><button class="button secondary" data-action="retry-nudge" data-id="${escape(r.id)}" ${r.retry_allowed ? "" : "disabled"}>Retry nudge</button></div>`).join("")}</div></section>`;
}
function workerStatus() {
  const checked = state.dashboard.worker_last_checked_at;
  return `<p class="worker-status">${icon("clock")}<span>${checked ? `Follow-ups last checked at <time datetime="${escape(checked)}">${escape(fullDate(checked))}</time>.` : "Follow-ups have not been checked yet."}${state.config.browser_demo ? " Checks run while this page is open." : ""}</span></p>`;
}
function dashboardPage() {
  const d = state.dashboard;
  const upcoming = d.upcoming_nudges || state.requests.filter((r) => r.status === "sent" && !r.nudge_attempted_at && r.mode === state.config.sms_mode).sort((a, b) => new Date(a.nudge_due_at) - new Date(b.nudge_due_at));
  const recent = d.recent_activity || state.activity;
  const metrics = dashboardMetrics(state.requests, state.quotes || []);
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const greeting = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
  const primary = (state.quotes || []).length ? '<button class="button" data-action="add-quote">' + icon("plus") + 'Create quote</button>' : state.contacts.length ? requestButton() : '<button class="button" data-action="add-contact">' + icon("plus") + 'Add your first customer</button>';
  return `${mobileSwitcher()}<div class="page-heading dashboard-heading"><div><p class="date-label">${escape(today)}</p><h1>${greeting}.</h1><p>Here’s what’s happening at ${escape(state.business.name)}.</p></div>${primary}</div><section class="kpi-grid" aria-label="Your business at a glance">${kpiCard("Reviews requested", metrics.reviews)}${kpiCard("Quotes awaiting response", metrics.awaiting)}${kpiCard("Nudges sent", metrics.nudges)}${kpiCard("Quote conversion", metrics.conversion, "%")}</section>${attentionNeeded(d.attention_needed || [])}<div class="dashboard-content"><div>${quotesAwaitingResponse()}<section class="panel"><div class="panel-heading"><div><h2>Review follow-ups</h2><p>One friendly reminder, after 3 days.</p></div><a href="#requests" class="text-button">All requests ${icon("arrow")}</a></div><div class="nudge-list">${upcoming.length ? upcoming.slice(0, 3).map((r) => `<div class="nudge-row"><span class="avatar small">${initials(r.contact_name)}</span><span><strong>${escape(r.contact_name)}</strong><small>Review requested ${date(r.sent_at)}</small></span><span class="nudge-time">${new Date(r.nudge_due_at) <= new Date() ? "Due now" : date(r.nudge_due_at)}</span></div>`).join("") : empty("You’re all caught up", "Review follow-ups will appear here when they’re scheduled.")}</div></section></div><section class="panel"><div class="panel-heading"><div><h2>Recent activity</h2><p>The latest from your business.</p></div><a href="#activity" class="text-button" aria-label="View all activity">${icon("arrow")}</a></div><div class="activity-list">${recent.length ? activityRows(recent.slice(0, 6)) : empty("A fresh start", "Messages and customer updates will appear here.")}</div></section></div>${workerStatus()}<h2 class="section-heading">Recent review requests</h2><section class="panel table-panel">${requestTable(state.requests.slice(0, 4), true)}</section>${demoBanner()}`;
}
function demoBanner() {
  return isDemo()
    ? `<div class="demo-banner"><span><strong>A practice run, with peace of mind.</strong> These texts are simulated. Nothing is sent to a phone.</span><button class="text-button" data-action="demo-nudge">Test the 3-day nudge ${icon("arrow")}</button></div>`
    : "";
}
function contactsPage() {
  return `${heading("Customers", "The people behind every job. Keep their details close.", `<button class="button" data-action="add-contact">${icon("plus")}Add customer</button>`)}<div class="toolbar"><div class="search-field">${icon("search")}<input id="search" placeholder="Find a customer…" aria-label="Find a customer"></div><select id="filter" class="filter-select" aria-label="Filter customers"><option value="all">Everyone</option><option value="customer">Customers</option><option value="lead">Leads</option></select></div><section class="panel table-panel" id="results">${contactsTable(state.contacts)}</section>`;
}
function contactsTable(contacts) {
  if (!contacts.length && state.contacts.length) return empty("No matching customers", "Try another name or relationship.");
  return contacts.length
    ? responsiveTable(`<table><thead><tr><th>Name & phone</th><th>Email</th><th>Relationship</th><th>Message permission</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${contacts.map((c) => `<tr><td>${customerInfo(c)}</td><td>${escape(c.email || "—")}</td><td>${(Array.isArray(c.tags) ? c.tags : [c.tags]).filter(Boolean).map(badge).join(" ")}</td><td>${c.opted_out ? badge("opted-out") : c.sms_consent ? '<span class="success-text">Text permission recorded</span>' : '<span class="subtle">No text permission yet</span>'}</td><td><button class="text-button table-action" data-action="edit-contact" data-id="${escape(c.id)}">Edit ${icon("edit")}</button></td></tr>`).join("")}</tbody></table>`, ["Customer","Email","Relationship","Message permission","Actions"])
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
const quoteDate = (value) => value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
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
  return responsiveTable(`<table><thead><tr><th>Customer</th><th>Status</th><th class="amount-heading">Total</th>${dashboard ? "" : "<th>Valid through</th>"}<th><span class="sr-only">Actions</span></th></tr></thead><tbody>${quotes.map((q) => `<tr><td><strong>${escape(q.contact_name)}</strong><small class="quote-reference">${escape(q.reference || "Quote")}${dashboard ? "" : " · " + escape(quoteFollowUpText(q))}</small></td><td>${badge(q.status)}</td><td class="quote-amount">${escape(money(q.total_cents, q.currency))}</td>${dashboard ? "" : `<td>${escape(quoteDate(q.expiry_date))}</td>`}<td><button class="text-button table-action" data-action="view-quote" data-id="${escape(q.id)}">${q.status === "draft" ? "Open draft" : "View quote"} ${icon("arrow")}</button></td></tr>`).join("")}</tbody></table>`, dashboard ? ["Customer", "Status", "Total", "Actions"] : ["Customer", "Status", "Total", "Valid through", "Actions"]);
}
function quotesAwaitingResponse() {
  const quotes = state.dashboard.quotes_awaiting_response || (state.quotes || []).filter((q) => ["sent", "viewed"].includes(q.status));
  return `<section class="panel"><div class="panel-heading"><div><h2>Quotes awaiting response</h2><p>${quotes.length ? quotes.length + (quotes.length === 1 ? " quote with your customer." : " quotes with your customers.") : "Your next job starts here."}</p></div><a href="#quotes" class="text-button">All quotes ${icon("arrow")}</a></div><div class="table-panel">${quotesTable(quotes.slice(0, 5), true)}</div></section>`;
}
function quotesPage() {
  return `${heading("Quotes", "Clear prices. Easy decisions. Keep your next job moving.", '<button class="button" data-action="add-quote">' + icon("plus") + "Create quote</button>")}<div class="toolbar"><div class="search-field">${icon("search")}<input id="quote-search" placeholder="Find a quote…" aria-label="Find a quote"></div><select id="quote-filter" class="filter-select" aria-label="Filter quotes"><option value="all">All quotes</option>${quoteStatuses.map((s) => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></div><section class="panel table-panel" id="quote-results">${quotesTable(state.quotes || [])}</section><p class="note">Customers can accept or decline from their quote link. Unanswered quotes get a reminder after 2 days and again after 5 days by text, email, or both, matching how you sent them. You can stop reminders at any time.</p>${isDemo() ? '<div class="demo-banner"><span><strong>A practice quote, from start to finish.</strong> Texts and emails are simulated. Open a sent quote to test its reminders.</span></div>' : ""}`;
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
function browserQuotePageMarkup(quote, error = "") {
  return `<div class="browser-customer-quote"><a class="browser-quote-back" href="#quotes">← Back to workspace</a>${quotePublicMarkup(quote)}${error ? `<div class="browser-quote-error" role="alert">${escape(error)}</div>` : ""}</div>`;
}
async function renderBrowserCustomerQuote(token) {
  const run = ++browserQuoteGeneration;
  document.title = "Your quote · Tradesuite";
  $("#main").innerHTML = loadingMarkup("Opening your quote");
  try {
    const quote = await api(`/q/${encodeURIComponent(token)}/data`);
    if (run !== browserQuoteGeneration || location.hash !== `#quote/${token}`) return;
    browserCustomerQuote = { token, quote };
    document.title = `${quote.business.name} — ${quote.status === "accepted" ? "Quote accepted" : quote.status === "declined" ? "Quote declined" : quote.status === "expired" ? "Quote expired" : "Your quote"}`;
    $("#main").innerHTML = browserQuotePageMarkup(quote);
  } catch (error) {
    if (run !== browserQuoteGeneration || location.hash !== `#quote/${token}`) return;
    browserCustomerQuote = null;
    document.title = "Quote unavailable — Tradesuite";
    $("#main").innerHTML = `<div class="browser-customer-quote"><a class="browser-quote-back" href="#quotes">← Back to workspace</a><section class="panel form-panel"><h1>This quote couldn’t be opened.</h1><p>${escape(error.message)}</p><p>Browser demo quote links work only in the browser where the quote was created.</p></section></div>`;
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
  document.title = `${quote.business.name} — ${quote.status === "accepted" ? "Quote accepted" : quote.status === "declined" ? "Quote declined" : "Your quote"}`;
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
    document.title = `${info.unsubscribed ? "Unsubscribed" : "Message preferences"} — ${info.business_name}`;
    $("#main").innerHTML = `<div class="browser-customer-quote"><a class="browser-quote-back" href="#quotes">← Back to workspace</a><section class="panel form-panel"><h1>${info.unsubscribed ? "You’re unsubscribed." : `Stop messages from ${name}?`}</h1><p>${info.unsubscribed ? `Texts and quote emails from ${name} are paused.` : `Unsubscribing stops texts and quote emails from ${name}. Your choices for other businesses stay the same.`}</p>${info.unsubscribed ? "" : `<button class="button" data-action="confirm-email-unsubscribe" data-token="${escape(token)}">Unsubscribe</button>`}<p class="note">Browser demo · No real texts or emails are sent.</p></section></div>`;
  } catch (error) {
    if (run !== browserQuoteGeneration || location.hash !== `#unsubscribe/${token}`) return;
    $("#main").innerHTML = `<div class="browser-customer-quote"><section class="panel form-panel"><h1>This link couldn’t be opened.</h1><p>${escape(error.message)}</p></section></div>`;
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
  return `${heading("Business settings", "The details your customers know you by.", '<button class="button secondary" data-action="add-business">' + icon("plus") + "Add business</button>")}<div class="settings-grid"><section class="panel form-panel"><h2>Business details</h2><p>Customers see your business name at the end of every text.</p><form id="settings-form"><div class="form-grid">${businessFields(b)}</div><div id="settings-error" role="alert"></div><div class="form-actions"><button class="button" type="submit">Save changes ${icon("check")}</button></div></form></section><div><section class="panel form-panel"><h2>Your logo</h2><p>A familiar face for your business.</p>${b.logo_url ? `<img class="logo-preview" src="${escape(b.logo_url)}" alt="${escape(b.name)} logo">` : `<span class="avatar">${initials(b.name)}</span>`}<form id="logo-form"><div class="form-field section-gap"><label for="logo">Upload your logo</label><input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" required><small>PNG, JPG or WebP. Up to 2 MB.</small></div><button class="button secondary small-button" type="submit">Save logo</button></form></section><section class="panel form-panel section-gap"><h2>Text messages</h2><div class="connection-state">${isDemo() ? "Demo mode is on. No real texts will be sent." : b.sms_ready ? "Your text-message settings are ready." : "Your Twilio settings need to be added before you can send."}</div><p class="note">Each business uses its own Twilio account. Your setup helper can add these settings to the app’s private .env file, then restart the app.</p><div class="code-block">${escape(prefix)}_ACCOUNT_SID<br>${escape(prefix)}_AUTH_TOKEN<br>${escape(prefix)}_PHONE_NUMBER</div><p class="note">Keep those details private. They never need to be entered here.</p></section></div></div>`;
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
    "A new business.",
    "Keep its customers, reviews and texts in their own space.",
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
  const customerLink = safeQuoteUrl(q.public_url);
  const unanswered = ["sent", "viewed"].includes(q.status);
  openModal(escape(q.reference || "Your quote"), escape(q.contact_name), `<div class="quote-detail"><div class="quote-detail-meta">${badge(q.status)}<span>Valid through ${escape(quoteDate(q.expiry_date))}</span></div><div class="quote-detail-items">${q.line_items.map((item) => `<div><span><strong>${escape(item.description)}</strong><small>${escape(item.quantity)} × ${escape(money(Math.round(item.unit_price * 100), q.currency))}</small></span><strong>${escape(money(item.line_total_cents, q.currency))}</strong></div>`).join("")}</div>${quoteTotalsMarkup(q)}${q.notes ? `<div class="quote-note"><strong>Note to your customer</strong><p>${escape(q.notes)}</p></div>` : ""}${q.status !== "draft" && customerLink ? `<div class="quote-link-box"><strong>Customer link</strong><a href="${escape(customerLink)}" target="_blank" rel="noopener">Open the customer’s quote ${icon("arrow")}</a><div class="copy-link-row"><input aria-label="Customer quote link" value="${escape(customerLink)}" readonly><button type="button" class="button secondary" data-action="copy-quote-link" data-url="${escape(customerLink)}">Copy link</button></div><p class="note">Anyone with this link can view and respond. Opening it records a view.</p></div>` : ""}${(q.deliveries || []).some(quoteDeliveryNeedsAttention) ? `<div class="error-box">${(q.deliveries || []).filter(quoteDeliveryNeedsAttention).map((d) => `${escape(d.channel === "email" ? "Email" : "Text")}: ${escape(d.error || "Sending could not be confirmed. Check the activity log.")}`).join("<br>")}</div>` : ""}${quoteDeliveryTimeline(q.deliveries || [])}<div class="quote-reminders"><strong>${escape(quoteFollowUpText(q))}</strong>${quoteFollowUpChannels(q) ? `<p class="note">${escape(quoteFollowUpChannels(q))}</p>` : ""}${unanswered && !q.follow_ups_cancelled_at && quoteFollowUpsPending(q) ? `<button class="text-button" data-action="cancel-quote-followups" data-id="${escape(q.id)}">Stop reminders</button>` : ""}</div>${unanswered && isDemo() ? `<div class="quote-demo-tools"><strong>Try the automatic reminders</strong><p class="note">Move this business’s demo quotes forward. No real texts or emails are sent.</p><div><button class="button secondary small-button" data-action="quote-demo-advance" data-days="2" data-id="${escape(q.id)}">Move forward 2 days</button><button class="button secondary small-button" data-action="quote-demo-advance" data-days="3" data-id="${escape(q.id)}">Then 3 more days</button></div></div>` : ""}<div class="form-actions"><button class="button secondary" data-action="close">Close</button>${q.status === "draft" && !(q.deliveries || []).length ? `<button class="button secondary" data-action="edit-quote" data-id="${escape(q.id)}">Edit draft</button>` : ""}${["draft", "sent", "viewed"].includes(q.status) && (q.sendable_channels || ["sms", "email"]).length ? `<button class="button" data-action="send-quote" data-id="${escape(q.id)}">${q.status === "draft" ? "Send quote" : "Send link"} ${icon("send")}</button>` : ""}</div></div>`, true);
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
      "Start with a happy customer.",
      "Add a customer with permission to text before asking for a review.",
      `<p class="note">Customers who have opted out or already have an open request won’t appear here.</p><div class="form-actions"><button class="button" data-action="close-add-contact">${icon("plus")}Add customer</button></div>`,
    );
    return;
  }
  const context = base();
  openModal(
    "Ask for a little word of mouth.",
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
    "Another one wrapped up.",
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
  state.business = state.businesses.find((x) => String(x.id) === String(id));
  Object.assign(state, {
    contacts: [],
    requests: [],
    quotes: [],
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
