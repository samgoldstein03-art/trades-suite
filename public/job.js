const jobPublicEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const jobPublicStatuses = {
  awaiting_scheduling: ["Waiting for booking", "No appointment has been booked yet."],
  scheduled: ["Booked", "Your recorded visit details are below."],
  waiting_parts: ["Waiting for parts", "The business has marked this job as waiting for parts."],
  in_progress: ["Work underway", "The business has marked this job as underway."],
  completed: ["Completed", "The business has marked this job complete."],
  follow_up: ["Follow-up needed", "The business has marked this job as needing a follow-up."],
  cancelled: ["Cancelled", "This job is marked cancelled. Contact the business if you have a question."],
};
function jobPublicStatus(value) {
  return Object.hasOwn(jobPublicStatuses, value) ? jobPublicStatuses[value] : ["Status unavailable", "Contact the business for the latest job details."];
}
function jobPublicSafeLink(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const link = new URL(value, location.href);
    return ["http:", "https:"].includes(link.protocol) && !link.username && !link.password ? link.href : "";
  } catch { return ""; }
}
function jobPublicQuoteLink(value, localPreview) {
  const webLink = jobPublicSafeLink(value);
  if (webLink || !localPreview || typeof value !== "string") return webLink;
  try {
    const current = new URL(location.href), link = new URL(value, current);
    return current.protocol === "file:" && link.protocol === current.protocol && link.host === current.host && link.pathname === current.pathname && !current.search && !link.search && !link.username && !link.password && /^#quote\/[A-Za-z0-9_-]+$/.test(link.hash) ? link.href : "";
  } catch { return ""; }
}
function jobPublicDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return date.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
function jobPublicTime(value) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return "";
  const [hour, minute] = value.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "pm" : "am"}`;
}
function jobPublicTimeZone(value) {
  if (typeof value !== "string" || !value) return "";
  try { new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(); return value; } catch { return ""; }
}
function jobPublicTimestamp(value, timeZone) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "";
  const zone = jobPublicTimeZone(timeZone);
  return new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone, timeZoneName: "short" } : {}) }).format(new Date(value));
}
function jobPublicMoney(cents, currency) {
  try { return new Intl.NumberFormat("en-CA", { style: "currency", currency: currency || "CAD" }).format((Number(cents) || 0) / 100); } catch { return ""; }
}
function jobPublicLoadingMarkup() {
  return '<div class="customer-job-page"><div class="customer-job-card customer-job-loading" role="status" aria-label="Opening your job details"><div class="customer-job-loading-brand"><span class="customer-job-skeleton customer-job-skeleton-logo"></span><span class="customer-job-skeleton customer-job-skeleton-name"></span></div><div class="customer-job-loading-content"><span class="customer-job-skeleton customer-job-skeleton-title"></span><span class="customer-job-skeleton customer-job-skeleton-line"></span><span class="customer-job-skeleton customer-job-skeleton-block"></span><span class="customer-job-skeleton customer-job-skeleton-block"></span></div><span class="sr-only">Opening your job details.</span></div></div>';
}
function jobPublicUnavailableMarkup(message = "Please check the link or contact the business that sent it.", canRetry = false) {
  return `<div class="customer-job-page"><section class="customer-job-card customer-job-unavailable"><p class="customer-job-eyebrow">Your job details</p><h1>This job link isn’t available.</h1><p>${jobPublicEscape(message)}</p>${canRetry ? '<button type="button" class="button secondary" data-job-public-retry>Try again</button>' : ""}</section></div>`;
}
function jobPublicMarkup(job, { localPreview = false } = {}) {
  const business = job.business || {};
  const businessName = business.name || "Your service provider";
  const logo = jobPublicSafeLink(business.logo_url);
  const booking = jobPublicSafeLink(business.booking_url);
  const phone = /^\+?[\d ()-]{7,25}$/.test(business.phone || "") ? business.phone : "";
  const initials = businessName.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("");
  const [status, statusCopy] = jobPublicStatus(job.status);
  const statusClass = Object.hasOwn(jobPublicStatuses, job.status) ? job.status.replaceAll("_", "-") : "unavailable";
  const date = jobPublicDate(job.scheduled_date);
  const start = jobPublicTime(job.arrival_start);
  const end = jobPublicTime(job.arrival_end);
  const timeZone = jobPublicTimeZone(job.time_zone);
  const lastUpdated = jobPublicTimestamp(job.updated_at, timeZone);
  const quote = job.quote || {};
  const quoteLink = jobPublicQuoteLink(quote.public_url, localPreview === true && job.mode === "demo");
  const quoteTotal = jobPublicMoney(quote.total_cents, quote.currency);
  const updates = Array.isArray(job.public_updates) ? job.public_updates : [];
  return `<div class="customer-job-page">${job.mode === "demo" ? '<p class="customer-job-demo-notice">Sample job · No real texts or emails are sent.</p>' : ""}<article class="customer-job-card"><header class="customer-job-business">${logo ? `<img src="${jobPublicEscape(logo)}" alt="${jobPublicEscape(businessName)} logo">` : `<span class="customer-job-brand-mark" aria-hidden="true">${jobPublicEscape(initials)}</span>`}<div><strong>${jobPublicEscape(businessName)}</strong><span>Your job details</span></div></header><section class="customer-job-intro"><p class="customer-job-eyebrow">${jobPublicEscape(job.reference || "Your job")}${job.job_type === "service" ? " · Service" : job.job_type === "installation" ? " · Installation" : ""}</p><h1>${jobPublicEscape(job.title || "Your job")}</h1>${job.customer_name ? `<p>For ${jobPublicEscape(job.customer_name)}</p>` : ""}</section><section class="customer-job-status customer-job-status-${statusClass}" aria-labelledby="customer-job-status-heading"><p class="customer-job-eyebrow">Job status</p><h2 id="customer-job-status-heading">${jobPublicEscape(status)}</h2><p>${jobPublicEscape(statusCopy)}</p>${lastUpdated ? `<p class="customer-job-updated">Last updated <time datetime="${jobPublicEscape(job.updated_at)}">${jobPublicEscape(lastUpdated)}</time></p>` : ""}</section><section class="customer-job-section" aria-labelledby="customer-job-visit-heading"><div class="customer-job-section-heading"><h2 id="customer-job-visit-heading">Visit details</h2>${timeZone ? `<span class="customer-job-timezone">Times shown in ${jobPublicEscape(timeZone.replaceAll("_", " "))}</span>` : ""}</div><dl class="customer-job-visit"><div><dt>Service address</dt><dd>${job.service_address ? jobPublicEscape(job.service_address) : "Address not added yet"}</dd></div><div><dt>Visit date</dt><dd>${date ? `<time datetime="${jobPublicEscape(job.scheduled_date)}">${jobPublicEscape(date)}</time>` : "Not booked yet"}</dd></div><div><dt>Arrival window</dt><dd>${date && start && end ? `${jobPublicEscape(start)} to ${jobPublicEscape(end)}` : "Not set yet"}</dd></div></dl></section>${job.description ? `<section class="customer-job-section customer-job-work"><h2>The work</h2><p>${jobPublicEscape(job.description)}</p></section>` : ""}${quoteLink ? `<section class="customer-job-section customer-job-quote" aria-labelledby="customer-job-quote-heading"><div><h2 id="customer-job-quote-heading">Accepted quote</h2><p>${jobPublicEscape(quote.reference || "Quote")}${quoteTotal ? ` · <strong>${jobPublicEscape(quoteTotal)} ${jobPublicEscape(quote.currency || "CAD")}</strong>` : ""}</p></div><a href="${jobPublicEscape(quoteLink)}" class="button secondary">View quote</a></section>` : ""}<section class="customer-job-section" aria-labelledby="customer-job-updates-heading"><div class="customer-job-section-heading"><h2 id="customer-job-updates-heading">Updates from ${jobPublicEscape(businessName)}</h2><span class="customer-job-order">Latest first</span></div>${updates.length ? `<ol class="customer-job-updates">${updates.slice().reverse().map((update) => { const timestamp = jobPublicTimestamp(update.created_at, timeZone); return `<li><div class="customer-job-update-heading"><strong>${jobPublicEscape(jobPublicStatus(update.status)[0])}</strong>${timestamp ? `<time datetime="${jobPublicEscape(update.created_at)}">${jobPublicEscape(timestamp)}</time>` : ""}</div>${update.message ? `<p>${jobPublicEscape(update.message)}</p>` : ""}</li>`; }).join("")}</ol>` : '<p class="customer-job-no-updates">No updates have been shared yet.</p>'}</section>${phone || booking ? `<footer class="customer-job-contact"><div><h2>A question about the work?</h2><p>Contact ${jobPublicEscape(businessName)} directly.</p></div><div class="customer-job-contact-links">${phone ? `<a href="tel:${jobPublicEscape(phone.replace(/[ ()-]/g, ""))}" class="button">${jobPublicEscape(phone)}</a>` : ""}${booking ? `<a href="${jobPublicEscape(booking)}" class="button secondary" target="_blank" rel="noopener noreferrer">Book a time</a>` : ""}</div></footer>` : ""}</article></div>`;
}
async function jobPublicRequest(path) {
  const response = await fetch(path, { cache: "no-store", headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error("Job details could not be loaded.");
    error.status = response.status;
    throw error;
  }
  return data;
}
let jobPublicLoadGeneration = 0;
let jobPublicLinkUnavailable = false;
let jobPublicLastMarkup = "";
const jobPublicPath = location.pathname.replace(/\/$/, "");
function jobPublicShow(data) {
  document.title = `${data.business?.name || "Your service provider"} | Your job`;
  const markup = jobPublicMarkup(data);
  // A background check must not remove a focused contact or quote link.
  if (markup !== jobPublicLastMarkup) document.querySelector("#customer-job").innerHTML = markup;
  jobPublicLastMarkup = markup;
}
async function jobPublicLoad() {
  const generation = ++jobPublicLoadGeneration;
  const container = document.querySelector("#customer-job");
  container.setAttribute("aria-busy", "true");
  try {
    const data = await jobPublicRequest(`${jobPublicPath}/data`);
    if (generation !== jobPublicLoadGeneration) return;
    jobPublicLinkUnavailable = false;
    jobPublicShow(data);
  } catch (error) {
    if (generation !== jobPublicLoadGeneration) return;
    jobPublicLinkUnavailable = [404, 410].includes(error.status);
    jobPublicLastMarkup = "";
    document.title = "Job link unavailable | Tradesuite";
    container.innerHTML = jobPublicUnavailableMarkup(jobPublicLinkUnavailable ? "Please ask the business for a current link to your job." : "We couldn’t refresh the job details. Try again or contact the business.", !jobPublicLinkUnavailable);
  } finally {
    if (generation === jobPublicLoadGeneration) container.setAttribute("aria-busy", "false");
  }
}
// The customer page only reads shared job details. Changes are made by the business.
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-job-public-retry]")) jobPublicLoad();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !jobPublicLinkUnavailable) jobPublicLoad();
});
jobPublicLoad();
setInterval(() => {
  if (!document.hidden && !jobPublicLinkUnavailable) jobPublicLoad();
}, 30000);
