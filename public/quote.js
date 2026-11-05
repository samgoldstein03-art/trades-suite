const quoteEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const quoteMoney = (cents, currency = "CAD") => new Intl.NumberFormat("en-CA", { style: "currency", currency }).format((Number(cents) || 0) / 100);
const quoteExpiry = (value) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
function quoteSafeLink(value) {
  try { const link = new URL(value, location.href); return ["http:", "https:"].includes(link.protocol) ? link.href : ""; } catch { return ""; }
}
function quotePublicMarkup(quote) {
  const business = quote.business || {};
  const logo = business.logo_url && quoteSafeLink(business.logo_url);
  const booking = business.booking_url && quoteSafeLink(business.booking_url);
  const phone = /^\+?[\d ()-]{7,25}$/.test(business.phone || "") ? business.phone : "";
  const status = {
    accepted: ["You’re all set.", "Your acceptance is recorded. Contact the business to arrange the work."],
    declined: ["Thanks for letting us know.", "Your decision has been sent to the business."],
    expired: ["This quote has expired.", "Please contact the business if you’d like an updated quote."],
  }[quote.status];
  const initials = (business.name || "Business").trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("");
  const businessHeader = `<header class="customer-business">${logo ? `<img src="${quoteEscape(logo)}" alt="${quoteEscape(business.name)} logo">` : `<span class="quote-business-mark" aria-hidden="true">${quoteEscape(initials)}</span>`}<div><strong>${quoteEscape(business.name)}</strong><span>A quote prepared for you</span></div></header>`;
  return `${quote.mode === "demo" ? '<div class="quote-demo-notice">Demo quote · No real texts or emails are sent.</div>' : ""}<article class="customer-quote-card">${businessHeader}<section class="quote-intro"><div class="quote-intro-top"><p class="quote-reference">${quoteEscape(quote.reference || "Quote")}</p><span class="quote-validity">Valid through ${quoteEscape(quoteExpiry(quote.expiry_date))}</span></div><h1>Your quote.</h1><p>Prepared for <strong>${quoteEscape(quote.customer_name || quote.contact_name)}</strong>. Here’s the work and what it will cost.</p></section><section class="customer-line-items" aria-label="Work and prices"><div class="customer-items-heading"><span>Work &amp; materials</span><span>Amount</span></div>${quote.line_items.map((item) => `<div class="customer-line-item"><div><h2>${quoteEscape(item.description)}</h2><p>${quoteEscape(item.quantity)} × ${quoteEscape(quoteMoney(Math.round(item.unit_price * 100), quote.currency))}</p></div><strong>${quoteEscape(quoteMoney(item.line_total_cents, quote.currency))}</strong></div>`).join("")}</section><section class="customer-totals" aria-label="Quote total"><div><span>Subtotal</span><strong>${quoteEscape(quoteMoney(quote.subtotal_cents, quote.currency))}</strong></div><div><span>Tax (${quoteEscape(quote.tax_rate)}%)</span><strong>${quoteEscape(quoteMoney(quote.tax_cents, quote.currency))}</strong></div><div class="customer-total"><span>Quote total <small>${quoteEscape(quote.currency || "CAD")}</small></span><strong>${quoteEscape(quoteMoney(quote.total_cents, quote.currency))}</strong></div></section>${quote.notes ? `<section class="customer-notes"><h2>A note from ${quoteEscape(business.name)}</h2><p>${quoteEscape(quote.notes)}</p></section>` : ""}<section class="customer-decision ${quoteEscape(quote.status)}">${status ? `<h2>${status[0]}</h2><p>${status[1]}</p>` : quote.can_respond ? `<h2>Ready to get started?</h2><p>Your answer goes straight to the business. No payment is collected here.</p><div class="customer-decision-buttons"><button id="accept-quote" data-decision="accepted" type="button" class="button">Accept quote</button><button id="decline-quote" data-decision="declined" type="button" class="button secondary">Decline</button></div>` : '<h2>This quote is not ready for a response.</h2><p>Please contact the business for help.</p>'}<div id="quote-response-error" role="alert"></div></section>${phone || booking ? `<footer class="customer-contact"><span>Questions about your quote?</span><div>${phone ? `<a href="tel:${quoteEscape(phone.replace(/[ ()-]/g, ""))}" class="text-button">${quoteEscape(phone)}</a>` : ""}${booking ? `<a href="${quoteEscape(booking)}" target="_blank" rel="noopener noreferrer" class="text-button">Book a time</a>` : ""}</div></footer>` : ""}</article>`;
}
async function quotePublicRequest(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const data = await response.json().catch(() => ({ error: "We couldn’t open this quote. Please try again." }));
  if (!response.ok) throw new Error(data.error || "Your response could not be saved. Please try again.");
  return data;
}
let customerQuoteData;
let customerQuoteSending = false;
const customerQuotePath = location.pathname.replace(/\/$/, "");
function showCustomerQuote(data) {
  customerQuoteData = data;
  document.title = `${data.business.name} | ${data.status === "accepted" ? "Quote accepted" : data.status === "declined" ? "Quote declined" : data.status === "expired" ? "Quote expired" : "Your quote"}`;
  document.querySelector("#customer-quote").innerHTML = quotePublicMarkup(data);
}
async function submitCustomerQuote(decision) {
  if (customerQuoteSending || !customerQuoteData?.can_respond || !["accepted", "declined"].includes(decision)) return;
  customerQuoteSending = true;
  document.querySelectorAll("[data-decision]").forEach((button) => button.disabled = true);
  try {
    showCustomerQuote(await quotePublicRequest(`${customerQuotePath}/respond`, { method: "POST", body: JSON.stringify({ decision }) }));
  } catch (error) {
    // Re-read before re-enabling: another tab may have answered or the quote expired.
    try { showCustomerQuote(await quotePublicRequest(`${customerQuotePath}/data`)); } catch { /* Keep the current quote and original error. */ }
    document.querySelector("#quote-response-error").textContent = error.message;
    document.querySelectorAll("[data-decision]").forEach((button) => button.disabled = !customerQuoteData.can_respond);
  } finally { customerQuoteSending = false; }
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-decision]");
  if (button) submitCustomerQuote(button.dataset.decision);
});
quotePublicRequest(`${customerQuotePath}/data`).then(showCustomerQuote).catch((error) => {
  document.title = "Quote unavailable | Tradesuite";
  document.querySelector("#customer-quote").innerHTML = `<div class="customer-quote-card quote-unavailable"><p class="quote-reference">Your quote</p><h1>This quote couldn’t be opened.</h1><p>${quoteEscape(error.message)}</p><p>Please check the link or contact the business that sent it.</p></div>`;
});
setInterval(() => {
  if (!document.hidden && !customerQuoteSending && customerQuoteData?.can_respond) quotePublicRequest(`${customerQuotePath}/data`).then(showCustomerQuote).catch(() => {});
}, 30000);
