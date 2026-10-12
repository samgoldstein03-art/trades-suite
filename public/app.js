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
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.message}"/></svg>`;
const nav = [
  ["dashboard", "Overview", "grid"],
  ["contacts", "Customers", "people"],
  ["requests", "Review requests", "message"],
  ["activity", "Activity", "activity"],
  ["settings", "Business settings", "settings"],
];
let state = {
  businesses: [],
  config: { sms_mode: "demo" },
  business: null,
  contacts: [],
  requests: [],
  activity: [],
  dashboard: {},
  page: "dashboard",
};
let generation = 0,
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
  `<span class="badge ${escape(status)}">${{ sent: "Sent", nudged: "Nudged", done: "Done", lead: "Lead", customer: "Customer", "opted-out": "Opted out" }[status] || escape(status)}</span>`;
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
  $("#toast").textContent = message;
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
function customerInfo(contact) {
  return `<div class="customer-info"><span class="avatar">${initials(contact.name || contact.contact_name)}</span><span><strong>${escape(contact.name || contact.contact_name)}</strong><small>${escape(contact.phone || contact.contact_phone || "")}</small></span></div>`;
}
function requestButton(label = "Request a review") {
  return `<button class="button" data-action="request">${icon("plus")}${label}</button>`;
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
    const [contacts, requests, activity, dashboard] = await Promise.all([
      api(`${base()}/contacts`),
      api(`${base()}/requests`),
      api(`${base()}/activity`),
      api(`${base()}/dashboard`),
    ]);
    if (run !== generation) return;
    Object.assign(state, { contacts, requests, activity, dashboard });
  }
  render();
}
function render() {
  state.page = location.hash.slice(1) || "dashboard";
  if (!nav.some((x) => x[0] === state.page)) state.page = "dashboard";
  $("#main-nav").innerHTML = nav
    .map(
      ([id, label, glyph]) =>
        `<a class="nav-link ${state.page === id ? "active" : ""}" ${state.page === id ? 'aria-current="page"' : ""} href="#${id}">${icon(glyph)}<span>${label}</span></a>`,
    )
    .join("");
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
  $("#page-name").textContent = nav.find((x) => x[0] === state.page)[1];
  if (!state.business) {
    $("#main").innerHTML =
      `<div class="welcome"><span class="brand-mark">t<span>↗</span></span><div class="eyebrow" style="margin-top:25px">GOOD WORK TRAVELS</div><h1>Your next customer starts<br>with a happy one.</h1><p>A simple place to look after your customers and ask for a little word of mouth. Add your first business to get started.</p><button class="button" data-action="add-business">${icon("plus")}Add your business</button><p class="note">${isDemo() ? "You’re in demo mode. No real texts will be sent." : ""}</p></div>`;
    return;
  }
  $("#main").innerHTML = {
    dashboard: dashboardPage,
    contacts: contactsPage,
    requests: requestsPage,
    activity: activityPage,
    settings: settingsPage,
  }[state.page]();
  if (state.page === "settings") bindSettings();
  if (state.page === "contacts" || state.page === "requests") bindFilters();
}
function activityRows(items, full = false) {
  return items
    .map((a) => {
      const done = /done|completed/i.test(a.kind + " " + a.label),
        nudge = /nudge/i.test(a.kind + " " + a.label),
        failed = /fail|unknown/i.test(a.kind + " " + a.label);
      return `<div class="activity-row"><span class="activity-icon ${done ? "done" : nudge ? "nudge" : ""}">${icon(done ? "check" : nudge ? "clock" : failed ? "activity" : "send")}</span><div class="activity-copy"><strong>${escape(a.label || a.kind)}</strong><small>${escape(a.contact_name || state.business.name)}${a.mode === "demo" ? " · Demo" : ""}</small>${full && a.body ? `<div class="activity-message">${escape(a.body)}</div>` : ""}</div><time datetime="${escape(a.created_at)}" title="${escape(fullDate(a.created_at))}">${full ? escape(fullDate(a.created_at)) : ago(a.created_at)}</time></div>`;
    })
    .join("");
}
function requestTable(requests, limited = false) {
  if (!requests.length)
    return empty(
      "Your first good word starts here",
      "Pick a happy customer and ask for a review.",
      requestButton(),
    );
  return `<table><thead><tr><th>Customer</th><th>Status</th><th>Requested</th><th>${limited ? "Next step" : "Follow-up"}</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${requests.map((r) => `<tr><td>${customerInfo(r)}${r.mode === "demo" ? '<small class="subtle">Demo request</small>' : ""}</td><td>${badge(r.status)}</td><td title="${escape(fullDate(r.sent_at))}">${date(r.sent_at)}</td><td>${r.status === "done" ? "All wrapped up" : r.status === "nudged" ? "No more follow-ups" : r.nudge_attempted_at ? "Follow-up attempted" : `One nudge ${date(r.nudge_due_at)}`}</td><td>${r.status !== "done" ? `<button class="text-button table-action" data-action="done" data-id="${escape(r.id)}">Mark done ${icon("check")}</button>` : '<span class="subtle">Completed</span>'}</td></tr>`).join("")}</tbody></table>`;
}
function dashboardPage() {
  const d = state.dashboard;
  const awaiting = state.requests
    .filter(
      (x) =>
        x.status === "sent" &&
        !x.nudge_attempted_at &&
        x.mode === state.config.sms_mode,
    )
    .sort((a, b) => new Date(a.nudge_due_at) - new Date(b.nudge_due_at));
  const upcoming = d.upcoming_nudges || awaiting;
  const recent = d.recent_activity || state.activity;
  return `${heading("A little word of mouth.", "Here’s how things are looking for " + escape(state.business.name) + ".", `<div class="heading-actions"><button class="button secondary" data-action="add-contact">${icon("people")}Add customer</button>${requestButton()}</div>`)}<section class="hero"><div class="hero-copy"><div class="eyebrow">YOU DO GOOD WORK. LET IT SHOW.</div><h2>Happy customers.<br>Your next best advertisement.</h2><p>A friendly text. An honest review. A little more trust<br>from the next person who needs a hand.</p><button class="button lime" data-action="request">Ask for a review ${icon("arrow")}</button></div><div class="hero-art" aria-hidden="true"><div class="orbit"></div><div class="review-card"><div class="stars">★★★★★</div><b>Another job well done.</b><div class="review-lines"></div><div class="review-lines short"></div></div><span class="review-spark">✦</span></div></section><section class="stats-grid" aria-label="Your numbers"><div class="stat-card"><div class="stat-top">Review requests sent<span class="stat-icon">${icon("send")}</span></div><div class="stat-number">${d.total_requests ?? state.requests.length}</div><div class="stat-bottom">A little ask that goes a long way</div></div><div class="stat-card"><div class="stat-top">Waiting for a nudge<span class="stat-icon">${icon("clock")}</span></div><div class="stat-number">${d.awaiting_nudge ?? upcoming.length}</div><div class="stat-bottom"><span class="green">One gentle follow-up</span> · after 3 days</div></div><div class="stat-card"><div class="stat-top">Marked done<span class="stat-icon">${icon("star")}</span></div><div class="stat-number">${d.completed ?? state.requests.filter((x) => x.status === "done").length}</div><div class="stat-bottom">Closed out by you. Nice work.</div></div></section><div class="dashboard-grid"><section class="panel"><div class="panel-heading"><h2>The latest</h2><a href="#activity" class="text-button">All activity ${icon("arrow")}</a></div><div class="activity-list">${recent.length ? activityRows(recent.slice(0, 4)) : empty("A fresh start", "Your requests and updates will appear here.")}</div><div class="panel-bottom">${icon("activity")}Every request and update, all in one place.</div></section><div><section class="panel"><div class="panel-heading"><div><h2>A gentle follow-up</h2><p>We’ll take it from here.</p></div><span class="stat-icon">${icon("clock")}</span></div><div class="nudge-list">${
    upcoming.length
      ? upcoming
          .slice(0, 3)
          .map(
            (r) =>
              `<div class="nudge-row"><span class="avatar small">${initials(r.contact_name)}</span><span><strong>${escape(r.contact_name)}</strong><small>Review requested ${date(r.sent_at)}</small></span><span class="nudge-time">${new Date(r.nudge_due_at) <= new Date() ? "Due now" : date(r.nudge_due_at)}</span></div>`,
          )
          .join("")
      : empty("All caught up", "No follow-ups waiting right now.")
  }</div><div class="panel-bottom">${icon("shield")}Just one reminder. Never a string of texts.</div></section><div class="quick-tip">${icon("bulb")}<div><strong>The best time to ask?</strong><p>Right after a job well done. A warm thank-you and a quick link make it easy to leave a review.</p></div></div></div></div><div class="panel-heading" style="padding:28px 0 14px"><h2>Recent review requests</h2><a href="#requests" class="text-button">View all ${icon("arrow")}</a></div><section class="panel table-panel">${requestTable(state.requests.slice(0, 4), true)}</section>${demoBanner()}`;
}
function demoBanner() {
  return isDemo()
    ? `<div class="demo-banner"><span><strong>A practice run, with peace of mind.</strong> These texts are simulated. Nothing is sent to a phone.</span><button class="text-button" data-action="demo-nudge">Test the 3-day nudge ${icon("arrow")}</button></div>`
    : "";
}
function contactsPage() {
  return `${heading("Your customers.", "A familiar name. A job well done. Keep everyone in one place.", `<button class="button" data-action="add-contact">${icon("plus")}Add customer</button>`)}<div class="toolbar"><div class="search-field">${icon("search")}<input id="search" placeholder="Find a customer…" aria-label="Find a customer"></div><select id="filter" class="filter-select" aria-label="Filter customers"><option value="all">Everyone</option><option value="customer">Customers</option><option value="lead">Leads</option></select></div><section class="panel table-panel" id="results">${contactsTable(state.contacts)}</section>`;
}
function contactsTable(contacts) {
  return contacts.length
    ? `<table><thead><tr><th>Name & phone</th><th>Email</th><th>Relationship</th><th>Text messages</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${contacts.map((c) => `<tr><td>${customerInfo(c)}</td><td>${escape(c.email || "—")}</td><td>${(Array.isArray(c.tags) ? c.tags : [c.tags]).filter(Boolean).map(badge).join(" ")}</td><td>${c.opted_out ? badge("opted-out") : c.sms_consent ? '<span class="success-text">Permission recorded</span>' : '<span class="subtle">No permission yet</span>'}</td><td><button class="text-button table-action" data-action="edit-contact" data-id="${escape(c.id)}">Edit ${icon("edit")}</button></td></tr>`).join("")}</tbody></table>`
    : empty(
        "No customers here yet",
        "Add a customer to start building your list.",
        '<button class="button secondary" data-action="add-contact">Add customer</button>',
      );
}
function requestsPage() {
  return `${heading("A good word goes a long way.", "Send a review request, then let us handle one friendly reminder.", requestButton())}<div class="toolbar"><div class="search-field">${icon("search")}<input id="search" placeholder="Find a request…" aria-label="Find a request"></div><select id="filter" class="filter-select" aria-label="Filter requests"><option value="all">All requests</option><option value="sent">Sent</option><option value="nudged">Nudged</option><option value="done">Done</option></select></div><section class="panel table-panel" id="results">${requestTable(state.requests)}</section><p class="note">Seen a customer’s review? Mark their request done to stop the follow-up. “Sent” means accepted for sending; it doesn’t confirm phone delivery. Reviews aren’t checked automatically.</p>${demoBanner()}`;
}
function activityPage() {
  return `${heading("Nothing falls through the cracks.", "Every text and every update for " + escape(state.business.name) + ".")}<section class="panel activity-full">${state.activity.length ? activityRows(state.activity, true) : empty("Your story starts here", "Send your first request and we’ll keep a record of it.")}</section>`;
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
  return `${heading("Make yourself at home.", "Your business details, all in one place.", '<button class="button secondary" data-action="add-business">' + icon("plus") + "Add business</button>")}<div class="settings-grid"><section class="panel form-panel"><h2>Business details</h2><p>Customers see your business name at the end of every text.</p><form id="settings-form"><div class="form-grid">${businessFields(b)}</div><div id="settings-error" role="alert"></div><div class="form-actions"><button class="button" type="submit">Save changes ${icon("check")}</button></div></form></section><div><section class="panel form-panel"><h2>Your logo</h2><p>A familiar face for your business.</p>${b.logo_url ? `<img class="logo-preview" src="${escape(b.logo_url)}" alt="${escape(b.name)} logo">` : `<span class="avatar">${initials(b.name)}</span>`}<form id="logo-form"><div class="form-field" style="margin-top:16px"><label for="logo">Upload your logo</label><input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" required><small>PNG, JPG or WebP. Up to 2 MB.</small></div><button class="button secondary small-button" type="submit">Save logo</button></form></section><section class="panel form-panel" style="margin-top:22px"><h2>Text messages</h2><div class="connection-state">${isDemo() ? "Demo mode is on. No real texts will be sent." : b.sms_ready ? "Your text-message settings are ready." : "Your Twilio settings need to be added before you can send."}</div><p class="note">Each business uses its own Twilio account. Your setup helper can add these settings to the app’s private .env file, then restart the app.</p><div class="code-block">${escape(prefix)}_ACCOUNT_SID<br>${escape(prefix)}_AUTH_TOKEN<br>${escape(prefix)}_PHONE_NUMBER</div><p class="note">Keep those details private. They never need to be entered here.</p></section></div></div>`;
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
function openModal(title, subtitle, content) {
  $("#modal-content").innerHTML =
    `<div class="modal-inner"><div class="modal-heading"><div><h2>${title}</h2><p>${subtitle}</p></div><button type="button" class="icon-button" data-action="close" aria-label="Close">${icon("close")}</button></div>${content}</div>`;
  $("#modal").showModal();
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
      $("#modal").close();
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
    c.id ? "A familiar face." : "Meet your next happy customer.",
    c.id
      ? "Update their details and keep in touch."
      : "A few details now make following up easy.",
    modalForm(
      `<div class="form-grid">${field("Full name", "name", c.name, "text", 'required maxlength="100"')}${field("Phone number", "phone", c.phone, "tel", 'required placeholder="+14165550123"', "Include the country code.")}${field("Email (optional)", "email", c.email, "email")}<div class="form-field"><label for="tags">Relationship</label><select name="tags" id="tags"><option value="customer" ${(c.tags || []).includes("customer") ? "selected" : ""}>Customer</option><option value="lead" ${(c.tags || []).includes("lead") ? "selected" : ""}>Lead</option></select></div></div><div class="form-field" style="margin-top:17px"><label for="notes">Notes (optional)</label><textarea name="notes" id="notes" placeholder="Anything worth remembering…">${escape(c.notes || "")}</textarea></div><label class="checkbox-label"><input type="checkbox" name="sms_consent" ${c.sms_consent ? "checked" : ""}><span>This person has given us permission to text them for review requests.</span></label>${c.opted_out ? '<p class="note danger-text">This customer has opted out. Review texts are paused until they text START.</p>' : ""}`,
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
async function requestModal() {
  const available = state.contacts.filter(
    (c) =>
      c.sms_consent &&
      !c.opted_out &&
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
      `<div class="form-field"><label for="contact_id">Who did you help?</label><select id="contact_id" name="contact_id">${options(available, available[0].id)}</select></div><div class="eyebrow" style="margin-top:23px">YOUR TEXT MESSAGE</div><div id="sms-preview" class="message-preview" aria-live="polite">Loading your message…</div><p class="note">If you haven’t marked it done after 3 days, we’ll send one polite reminder. Then we’ll leave it there.</p>${isDemo() ? '<p class="note"><strong>Demo mode:</strong> this saves a simulated text. Nothing will be sent.</p>' : ""}`,
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
  const el = e.target.closest("[data-action]");
  if (!el) return;
  try {
    switch (el.dataset.action) {
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
      case "done":
        doneModal(el.dataset.id);
        break;
      case "demo-nudge":
        demoNudge();
        break;
      case "close":
        $("#modal").close();
        break;
      case "close-add-contact":
        $("#modal").close();
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
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      e.target.close();
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
    !$("#modal").open &&
    state.page !== "settings" &&
    !document.activeElement?.matches("input,textarea,select")
  ) {
    refresh().catch(() => {});
  }
}, 30000);
