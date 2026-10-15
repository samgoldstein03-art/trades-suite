import express from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import multer from "multer";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transaction } from "./db.js";
import { buildSms, credentialsFor, credentialsReady, PHONE_PATTERN, safeFailure } from "./sms.js";
import { buildQuoteEmailText, safeEmailFailure, validEmailAddress } from "./email.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86400000;
const STATUSES = new Set(["draft", "sent", "viewed", "accepted", "declined", "expired"]);
const OPEN = new Set(["sent", "viewed"]);
export class QuoteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new QuoteError(status, message); }
function text(value, label, max, required = false) {
  if (typeof value !== "string") fail(400, `${label} must be text.`);
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result))
    fail(400, `Enter ${label.toLowerCase()}${required ? "" : " within the allowed length"}.`);
  return result;
}
function scaled(value, label, places, max, positive = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max || (positive && value === 0))
    fail(400, `Enter a valid ${label.toLowerCase()}.`);
  // Decimal spelling, rather than floating-point multiplication, makes cents
  // deterministic (for example 1.005 is rejected as a unit price).
  const match = String(value).match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${places}}))?$`));
  if (!match) fail(400, `${label} can have at most ${places} decimal places.`);
  return BigInt(match[1]) * 10n ** BigInt(places) + BigInt((match[2] || "").padEnd(places, "0"));
}
function fields(input, stamp) {
  if (!Array.isArray(input.line_items) || !input.line_items.length || input.line_items.length > 100)
    fail(400, "Add between 1 and 100 line items.");
  let subtotal = 0n;
  const lineItems = input.line_items.map((item) => {
    if (!item || typeof item !== "object") fail(400, "Enter a valid line item.");
    const quantity = scaled(item.quantity, "Quantity", 3, 100000, true);
    const price = scaled(item.unit_price, "Unit price", 2, 1000000);
    const amount = (quantity * price + 500n) / 1000n;
    subtotal += amount;
    return { description: text(item.description, "Description", 500, true), quantity: item.quantity, unit_price: item.unit_price, line_total_cents: Number(amount) };
  });
  const taxRate = scaled(input.tax_rate ?? 0, "Tax rate", 3, 100);
  const tax = (subtotal * taxRate + 50000n) / 100000n;
  if (subtotal + tax > 10000000000n) fail(400, "The quote total is too large.");
  const expiry = text(input.expiry_date, "Expiry date", 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !Number.isFinite(Date.parse(`${expiry}T00:00:00Z`)) || new Date(`${expiry}T00:00:00Z`).toISOString().slice(0, 10) !== expiry)
    fail(400, "Enter a valid expiry date.");
  if (Date.parse(`${expiry}T00:00:00Z`) + DAY <= Date.parse(stamp)) fail(400, "Choose an expiry date that has not passed.");
  const currency = input.currency ?? "CAD";
  if (!["CAD", "USD"].includes(currency)) fail(400, "Choose CAD or USD as the currency.");
  return { contact_id: text(input.contact_id, "Customer", 100, true), line_items: JSON.stringify(lineItems), tax_rate: Number(taxRate) / 1000, subtotal_cents: Number(subtotal), tax_cents: Number(tax), total_cents: Number(subtotal + tax), currency, expiry_date: expiry, notes: text(input.notes ?? "", "Notes", 5000) };
}

export function createQuoteModule({ db, smsMode, now = () => new Date(), sendSms, sendEmail, emailReady = () => Boolean(sendEmail), publicOrigin, uploadDir = resolve(ROOT, "data/uploads") }) {
  const adminRouter = express.Router({ mergeParams: true });
  const publicRouter = express.Router();
  const stamp = () => new Date(now()).toISOString();
  const business = (businessId) => {
    const row = db.prepare("SELECT * FROM businesses WHERE id=?").get(businessId);
    if (!row) fail(404, "Business not found.");
    return row;
  };
  const contact = (businessId, contactId) => {
    const row = db.prepare("SELECT * FROM contacts WHERE business_id=? AND id=?").get(businessId, contactId);
    if (!row) fail(404, "Customer not found in this business.");
    return row;
  };
  function log(q, kind, label, body = null) {
    db.prepare("INSERT INTO activity (id,business_id,contact_id,quote_id,kind,label,body,mode,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), q.business_id, q.contact_id, q.id, kind, label, body, q.mode, stamp());
  }
  function expire(businessId) {
    const expired = db.prepare(`SELECT * FROM quotes WHERE status IN ('draft','sent','viewed') AND expiry_date < ? ${businessId ? "AND business_id=?" : ""}`)
      .all(...(businessId ? [stamp().slice(0, 10), businessId] : [stamp().slice(0, 10)]));
    for (const q of expired) {
      const changed = db.prepare("UPDATE quotes SET status='expired',updated_at=? WHERE business_id=? AND id=? AND status IN ('draft','sent','viewed')").run(stamp(), q.business_id, q.id);
      if (changed.changes) log(q, "quote_status", `${q.reference} expired`);
    }
  }
  function getQuote(businessId, id) {
    expire(businessId);
    const q = db.prepare("SELECT * FROM quotes WHERE business_id=? AND id=?").get(businessId, id);
    if (!q) fail(404, "Quote not found in this business.");
    return q;
  }
  function deliveries(q) {
    return db.prepare("SELECT id,channel,kind,status,error,error_code,email_bounced,attempts,created_at,updated_at FROM quote_deliveries WHERE business_id=? AND quote_id=? ORDER BY created_at,rowid")
      .all(q.business_id, q.id);
  }
  function initialDeliveries(q) {
    return db.prepare("SELECT * FROM quote_deliveries WHERE business_id=? AND quote_id=? AND kind='initial' AND status=? ORDER BY channel DESC")
      .all(q.business_id, q.id, smsMode === "demo" ? "simulated" : "sent");
  }
  function quoteView(q) {
    const snapshot = q.snapshot_json ? JSON.parse(q.snapshot_json) : null;
    const sends = deliveries(q);
    const nudges = sends.filter((d) => d.kind !== "initial" && ["sent", "simulated"].includes(d.status));
    const initials = initialDeliveries(q);
    const followUpsPending = OPEN.has(q.status) && !q.follow_ups_cancelled_at && !blocked(q.business_id, contact(q.business_id, q.contact_id)) && initials.some((initial) => !sends.some((d) => d.channel === initial.channel && d.kind === "nudge_5"));
    const { public_token, snapshot_json, follow_up_phone, ...visible } = q;
    const sendable = ["draft", "sent", "viewed"].includes(q.status) && !blocked(q.business_id, contact(q.business_id, q.contact_id)) ? ["sms", "email"].filter((channel) => {
      const attempt = sends.find((d) => d.channel === channel && d.kind === "initial");
      return !attempt || attempt.status === "failed";
    }) : [];
    return { ...visible, contact_name: snapshot?.customer_name || contact(q.business_id, q.contact_id).name, line_items: JSON.parse(q.line_items), deliveries: sends, nudge_count: new Set(nudges.map((d) => d.kind)).size, nudges_sent: nudges.length, follow_up_channels: initials.map((d) => d.channel), follow_ups_pending: followUpsPending, sendable_channels: sendable };
  }
  function publicView(q) {
    const snapshot = JSON.parse(q.snapshot_json);
    return { reference: q.reference, status: q.status, mode: q.mode === "demo" ? "demo" : "live", business: { ...snapshot.business, logo_url: snapshot.business.logo_url ? `/q/${q.public_token}/logo` : null }, customer_name: snapshot.customer_name, contact_name: snapshot.customer_name, line_items: JSON.parse(q.line_items), tax_rate: q.tax_rate, subtotal_cents: q.subtotal_cents, tax_cents: q.tax_cents, total_cents: q.total_cents, currency: q.currency, expiry_date: q.expiry_date, notes: q.notes, can_respond: OPEN.has(q.status) };
  }
  function fromToken(token) {
    if (!/^[a-f0-9]{64}$/.test(token)) fail(404, "This quote link was not found.");
    const found = db.prepare("SELECT * FROM quotes WHERE public_token=? AND sent_at IS NOT NULL").get(token);
    if (!found) fail(404, "This quote link was not found.");
    return getQuote(found.business_id, found.id);
  }
  function blocked(businessId, person) {
    return Boolean(person.opted_out || person.quote_email_opted_out || db.prepare("SELECT 1 FROM phone_opt_outs WHERE business_id=? AND phone=?").get(businessId, person.phone));
  }
  function canText(biz, person) {
    if (!person.sms_consent) fail(400, "Confirm this customer has agreed to receive texts.");
    if (!PHONE_PATTERN.test(person.phone)) fail(400, "Add a valid customer phone number.");
    if (blocked(biz.id, person)) fail(400, "This customer has opted out of texts.");
    if (smsMode === "twilio" && !credentialsReady(biz)) fail(400, "Add this business Twilio settings before sending a text.");
  }
  function optOut(q, phone) {
    const added = db.prepare("INSERT OR IGNORE INTO phone_opt_outs (business_id,phone,created_at) VALUES (?,?,?)").run(q.business_id, phone, stamp());
    const updated = db.prepare("UPDATE contacts SET opted_out=1,updated_at=? WHERE business_id=? AND phone=? AND opted_out=0").run(stamp(), q.business_id, phone);
    if (added.changes || updated.changes) log(q, "opt_out", "Customer opted out of texts");
  }
  function buildUrl(req, q) {
    const origin = typeof publicOrigin === "function" ? publicOrigin(req) : publicOrigin;
    let url;
    try { url = new URL(origin); } catch { fail(400, "Set the public website address before sending a quote."); }
    if (!["http:", "https:"].includes(url.protocol) || (smsMode === "twilio" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      fail(400, "Set a valid public website address before sending a quote.");
    return `${url.origin}/q/${q.public_token}`;
  }
  function newUnsubscribeUrl(q, url = q.public_url) {
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO contact_unsubscribe_links (token_hash,business_id,contact_id,created_at) VALUES (?,?,?,?)")
      .run(createHash("sha256").update(token).digest("hex"), q.business_id, q.contact_id, stamp());
    return `${new URL(url).origin}/q/unsubscribe/${token}`;
  }
  function reserve(q, channel, kind, recipient, body, unsubscribe_url = null) {
    const existing = db.prepare("SELECT * FROM quote_deliveries WHERE business_id=? AND quote_id=? AND channel=? AND kind=?").get(q.business_id, q.id, channel, kind);
    if (existing) {
      // A provider rejection may be retried explicitly for the initial send.
      // Unknown outcomes, successful sends, and all follow-ups are never retried.
      if (kind !== "initial" || existing.status !== "failed") return null;
      db.prepare("UPDATE quote_deliveries SET status='sending',recipient=?,body=?,unsubscribe_url=?,email_bounced=0,error=NULL,error_code=NULL,attempts=attempts+1,updated_at=? WHERE id=? AND status='failed'").run(recipient, body, unsubscribe_url, stamp(), existing.id);
      return { ...existing, status: "sending", recipient, body, unsubscribe_url };
    }
    const delivery = { id: randomUUID(), business_id: q.business_id, quote_id: q.id, channel, kind, recipient, body, unsubscribe_url };
    db.prepare("INSERT INTO quote_deliveries (id,business_id,quote_id,channel,kind,status,recipient,body,unsubscribe_url,created_at,updated_at) VALUES (?,?,?,?,?,'sending',?,?,?,?,?)")
      .run(delivery.id, q.business_id, q.id, channel, kind, recipient, body, unsubscribe_url, stamp(), stamp());
    return delivery;
  }
  async function deliver(q, biz, delivery) {
    // Combined sends await one provider at a time. A STOP or unsubscribe may
    // arrive during that wait, so recheck before starting the next channel.
    const current = getQuote(q.business_id, q.id);
    const person = contact(q.business_id, q.contact_id);
    let stopReason = blocked(q.business_id, person) ? "This customer has opted out of messages." : null;
    if (delivery.kind !== "initial") {
      if (!OPEN.has(current.status) || current.follow_ups_cancelled_at) stopReason = "This quote is no longer waiting for follow-ups.";
      else if (delivery.channel === "email" && (!validEmailAddress(person.email) || person.email.toLowerCase() !== delivery.recipient.toLowerCase() || emailBounced(q))) stopReason = "Email reminders stopped because the email address changed, is invalid, or was rejected.";
      else if (delivery.channel === "sms" && (!person.sms_consent || person.phone !== delivery.recipient)) stopReason = "Text reminders stopped because the phone number or permission changed.";
    }
    if (stopReason) {
      transaction(db, () => {
        db.prepare("UPDATE quote_deliveries SET status='skipped',error=?,updated_at=? WHERE id=?").run(stopReason, stamp(), delivery.id);
        log(q, "quote_delivery_stopped", `${q.reference} delivery stopped`, stopReason);
      });
      return false;
    }
    try {
      let result;
      if (smsMode === "twilio") {
        const emailBusiness = delivery.channel === "email"
          ? { ...biz, name: JSON.parse(db.prepare("SELECT snapshot_json FROM quotes WHERE business_id=? AND id=?").get(q.business_id, q.id).snapshot_json).business.name }
          : biz;
        result = delivery.channel === "sms"
          ? await sendSms({ ...credentialsFor(biz), to: delivery.recipient, body: delivery.body, businessId: biz.id })
          : await sendEmail({ business: emailBusiness, to: delivery.recipient, subject: `${delivery.kind === "initial" ? "" : "Friendly reminder: "}${q.reference} from ${emailBusiness.name}`, text: delivery.body, unsubscribeUrl: delivery.unsubscribe_url });
        if (delivery.channel === "sms" && !result?.sid)
          throw new Error("The SMS provider did not confirm acceptance.");
        if (delivery.channel === "email" && !result?.messageId)
          throw new Error("The email provider did not confirm acceptance.");
      }
      const state = smsMode === "demo" ? "simulated" : "sent";
      transaction(db, () => {
        db.prepare("UPDATE quote_deliveries SET status=?,provider_sid=?,updated_at=? WHERE id=?").run(state, result?.sid || result?.messageId || null, stamp(), delivery.id);
        if (delivery.kind === "initial") {
          // A provider may answer after midnight while another request expires
          // the draft. Keep that delivered link usable, with its expired state.
          const changed = db.prepare("UPDATE quotes SET status=CASE WHEN status='draft' THEN 'sent' ELSE status END,sent_at=?,updated_at=? WHERE business_id=? AND id=? AND sent_at IS NULL AND status IN ('draft','expired')").run(stamp(), stamp(), q.business_id, q.id);
          if (changed.changes && getQuote(q.business_id, q.id).status === "sent") log(q, "quote_status", `${q.reference} sent`);
        }
        log(q, delivery.channel === "sms" ? "sms_sent" : "email_sent", `${q.reference} ${delivery.kind === "initial" ? "link" : "follow-up"} ${state === "simulated" ? "simulated" : "sent"} by ${delivery.channel === "sms" ? "text" : "email"}`, delivery.body);
      });
      return true;
    } catch (error) {
      const failure = delivery.channel === "sms" ? safeFailure(error) : { code: null, ...safeEmailFailure(error) };
      transaction(db, () => {
        db.prepare("UPDATE quote_deliveries SET status=?,error_code=?,error=?,email_bounced=?,updated_at=? WHERE id=?").run(failure.uncertain ? "uncertain" : "failed", failure.code, failure.message, failure.bounced ? 1 : 0, stamp(), delivery.id);
        if (delivery.channel === "sms" && failure.code === 21610) optOut(q, delivery.recipient);
        log(q, "quote_delivery_failed", `${q.reference} ${delivery.kind === "initial" ? "delivery" : "follow-up"} needs attention`, failure.message);
      });
      return false;
    }
  }

  adminRouter.use((req, res, next) => { try { business(req.params.businessId); next(); } catch (error) { next(error); } });
  adminRouter.get("/", (req, res) => {
    expire(req.params.businessId);
    const status = req.query.status;
    if (status && !STATUSES.has(status)) fail(400, "Choose a valid quote status.");
    const rows = db.prepare(`SELECT * FROM quotes WHERE business_id=? ${status ? "AND status=?" : ""} ORDER BY created_at DESC,rowid DESC`).all(...(status ? [req.params.businessId, status] : [req.params.businessId]));
    res.json(rows.map(quoteView));
  });
  adminRouter.post("/", (req, res) => {
    const data = fields(req.body || {}, stamp());
    contact(req.params.businessId, data.contact_id);
    const id = randomUUID();
    const q = { ...data, id, business_id: req.params.businessId, reference: `Q-${id.slice(0, 8).toUpperCase()}`, mode: smsMode };
    transaction(db, () => {
      db.prepare("INSERT INTO quotes (business_id,id,contact_id,reference,line_items,tax_rate,subtotal_cents,tax_cents,total_cents,currency,expiry_date,notes,public_token,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(q.business_id, id, q.contact_id, q.reference, q.line_items, q.tax_rate, q.subtotal_cents, q.tax_cents, q.total_cents, q.currency, q.expiry_date, q.notes, randomBytes(32).toString("hex"), smsMode, stamp(), stamp());
      log(q, "quote_created", `${q.reference} created as a draft`);
    });
    res.status(201).json(quoteView(getQuote(q.business_id, id)));
  });
  adminRouter.post("/demo/advance", async (req, res) => {
    if (smsMode !== "demo") fail(404, "This action is only available in demo mode.");
    if (![2, 3, 5].includes(req.body?.days)) fail(400, "Choose 2, 3, or 5 days.");
    const rows = db.prepare("SELECT * FROM quotes WHERE business_id=? AND mode='demo' AND status IN ('sent','viewed')").all(req.params.businessId);
    for (const q of rows) db.prepare("UPDATE quotes SET sent_at=? WHERE business_id=? AND id=?").run(new Date(Date.parse(q.sent_at) - req.body.days * DAY).toISOString(), q.business_id, q.id);
    const result = await runQuoteNudges(req.params.businessId);
    res.json(result);
  });
  adminRouter.get("/:id", (req, res) => res.json(quoteView(getQuote(req.params.businessId, req.params.id))));
  adminRouter.patch("/:id", (req, res) => {
    const q = getQuote(req.params.businessId, req.params.id);
    if (q.status !== "draft" || q.snapshot_json) fail(409, "Only an unsent draft can be changed. Create a new quote for a different offer.");
    const data = fields({ ...q, line_items: JSON.parse(q.line_items), ...req.body }, stamp());
    contact(q.business_id, data.contact_id);
    db.prepare("UPDATE quotes SET contact_id=?,line_items=?,tax_rate=?,subtotal_cents=?,tax_cents=?,total_cents=?,currency=?,expiry_date=?,notes=?,updated_at=? WHERE business_id=? AND id=?")
      .run(data.contact_id, data.line_items, data.tax_rate, data.subtotal_cents, data.tax_cents, data.total_cents, data.currency, data.expiry_date, data.notes, stamp(), q.business_id, q.id);
    res.json(quoteView(getQuote(q.business_id, q.id)));
  });
  adminRouter.post("/:id/send", async (req, res) => {
    const q = getQuote(req.params.businessId, req.params.id);
    if (!["draft", "sent", "viewed"].includes(q.status)) fail(409, "This quote is no longer available to send.");
    if (q.mode !== smsMode) fail(409, "This quote belongs to a different text mode. Create a new quote.");
    const channels = req.body?.channels ?? ["sms"];
    if (!Array.isArray(channels) || !channels.length || channels.length > 2 || channels.some((c) => !["sms", "email"].includes(c)) || new Set(channels).size !== channels.length) fail(400, "Choose text, email, or both.");
    const biz = business(q.business_id);
    const person = contact(q.business_id, q.contact_id);
    if (channels.includes("sms")) canText(biz, person);
    if (channels.includes("email")) {
      if (blocked(biz.id, person)) fail(400, "This customer has opted out of messages.");
      if (!validEmailAddress(person.email)) fail(400, "Add a valid customer email address first.");
      if (smsMode === "twilio" && !emailReady(biz)) fail(400, "Add this business email settings before sending email.");
    }
    const url = q.public_url || buildUrl(req, q);
    const snapshot = q.snapshot_json ? JSON.parse(q.snapshot_json) : { business: { name: biz.name, phone: biz.phone, booking_url: biz.booking_url, logo_url: biz.logo_url }, customer_name: person.name };
    const jobs = transaction(db, () => {
      const reserved = [];
      for (const channel of channels) {
        let unsubscribeUrl = null;
        if (channel === "email") unsubscribeUrl = newUnsubscribeUrl(q, url);
        const body = channel === "sms" ? buildSms(snapshot.business, { name: snapshot.customer_name }, "quote", { url, reference: q.reference }) : buildQuoteEmailText({ businessName: snapshot.business.name, customerName: snapshot.customer_name, url, unsubscribeUrl, allowHttp: smsMode === "demo" });
        const delivery = reserve(q, channel, "initial", channel === "sms" ? person.phone : person.email, body, unsubscribeUrl);
        if (!delivery) fail(409, "This quote was already sent through that channel, or a previous delivery is still unconfirmed. Check its delivery history.");
        reserved.push(delivery);
      }
      db.prepare("UPDATE quotes SET snapshot_json=?,public_url=?,follow_up_phone=COALESCE(follow_up_phone,?),updated_at=? WHERE business_id=? AND id=?").run(JSON.stringify(snapshot), url, person.phone, stamp(), q.business_id, q.id);
      return reserved;
    });
    // A quote may succeed on one channel and fail on another. Keep each outcome
    // separately; only an accepted delivery changes a draft to sent.
    for (const delivery of jobs) await deliver(q, biz, delivery);
    res.json(quoteView(getQuote(q.business_id, q.id)));
  });
  adminRouter.post("/:id/cancel-follow-ups", (req, res) => {
    const q = getQuote(req.params.businessId, req.params.id);
    if (!q.follow_ups_cancelled_at) {
      db.prepare("UPDATE quotes SET follow_ups_cancelled_at=?,updated_at=? WHERE business_id=? AND id=?").run(stamp(), stamp(), q.business_id, q.id);
      log(q, "quote_follow_ups_cancelled", `${q.reference} follow-ups stopped`);
    }
    res.json(quoteView(getQuote(q.business_id, q.id)));
  });

  publicRouter.use((req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" }); next(); });
  function unsubscribeContact(token) {
    if (!/^[a-f0-9]{64}$/.test(token)) fail(404, "This unsubscribe link was not found.");
    const person = db.prepare(`SELECT c.*, b.name AS unsubscribe_business_name
      FROM contact_unsubscribe_links l
      JOIN contacts c ON c.business_id=l.business_id AND c.id=l.contact_id
      JOIN businesses b ON b.id=c.business_id WHERE l.token_hash=?`)
      .get(createHash("sha256").update(token).digest("hex"));
    if (!person) fail(404, "This unsubscribe link was not found.");
    return person;
  }
  function unsubscribePage(person, token) {
    const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const name = escape(person.unsubscribe_business_name);
    const complete = Boolean(person.quote_email_opted_out);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Message preferences — ${name}</title><link rel="stylesheet" href="/q/assets/quote.css"></head><body><main id="customer-quote"><article class="customer-quote-card quote-unavailable"><h1>${complete ? "You’re unsubscribed." : `Stop messages from ${name}?`}</h1><p>${complete ? `You won’t receive more quote emails or texts for this customer from ${name}.` : "This stops quote emails and texts for this customer. It does not change your quote or its status."}</p>${complete ? "" : `<form method="post" action="/q/unsubscribe/${token}"><input type="hidden" name="action" value="unsubscribe"><div class="customer-decision-buttons"><button type="submit">Unsubscribe</button></div></form>`}</article></main></body></html>`;
  }
  // GET is intentionally read-only: email security scanners visit links.
  // Mail clients perform the RFC 8058 one-click operation with a public POST.
  publicRouter.get("/unsubscribe/:token/data", (req, res) => {
    const person = unsubscribeContact(req.params.token);
    res.json({ business_name: person.unsubscribe_business_name, unsubscribed: Boolean(person.quote_email_opted_out) });
  });
  publicRouter.get("/unsubscribe/:token", (req, res) => res.type("html").send(unsubscribePage(unsubscribeContact(req.params.token), req.params.token)));
  const parseUrlencodedUnsubscribe = express.urlencoded({ extended: false, limit: "2kb", parameterLimit: 2 });
  const parseMultipartUnsubscribe = multer({ limits: { files: 0, fields: 2, fieldSize: 256 } }).none();
  publicRouter.post("/unsubscribe/:token", (req, res, next) => {
    if (req.is("application/x-www-form-urlencoded")) return parseUrlencodedUnsubscribe(req, res, next);
    if (req.is("multipart/form-data")) return parseMultipartUnsubscribe(req, res, (error) => next(error ? new QuoteError(400, "Send a valid unsubscribe request.") : undefined));
    next(new QuoteError(415, "Send the unsubscribe request as a form."));
  }, (req, res) => {
    const person = unsubscribeContact(req.params.token);
    if (req.body?.["List-Unsubscribe"] !== "One-Click" && req.body?.action !== "unsubscribe") fail(400, "Choose Unsubscribe to stop messages.");
    transaction(db, () => {
      const changed = db.prepare("UPDATE contacts SET quote_email_opted_out=1,updated_at=? WHERE business_id=? AND id=? AND quote_email_opted_out=0").run(stamp(), person.business_id, person.id);
      if (changed.changes) {
        db.prepare("UPDATE quotes SET follow_ups_cancelled_at=?,updated_at=? WHERE business_id=? AND contact_id=? AND status IN ('sent','viewed') AND follow_ups_cancelled_at IS NULL").run(stamp(), stamp(), person.business_id, person.id);
        db.prepare("INSERT INTO activity (id,business_id,contact_id,kind,label,mode,created_at) VALUES (?,?,?,'opt_out',?,?,?)").run(randomUUID(), person.business_id, person.id, "Customer unsubscribed from quote emails and texts.", smsMode, stamp());
      }
    });
    res.status(200).type("html").send(unsubscribePage({ ...person, quote_email_opted_out: 1 }, req.params.token));
  });
  publicRouter.get("/assets/quote.js", (req, res) => res.sendFile(resolve(ROOT, "public/quote.js")));
  publicRouter.get("/assets/quote.css", (req, res) => res.sendFile(resolve(ROOT, "public/quote.css")));
  publicRouter.get("/:token", (req, res) => { fromToken(req.params.token); res.sendFile(resolve(ROOT, "public/quote.html")); });
  publicRouter.get("/:token/logo", (req, res) => {
    const q = fromToken(req.params.token);
    const logo = JSON.parse(q.snapshot_json).business.logo_url;
    // Only files already selected in this business snapshot may be public.
    // The upload handler permits raster images, never arbitrary HTML or SVG.
    if (!logo || !/^\/uploads\/[A-Za-z0-9._-]+$/.test(logo)) fail(404, "Logo not found.");
    res.sendFile(resolve(uploadDir, basename(logo)));
  });
  publicRouter.get("/:token/data", (req, res) => {
    let q = fromToken(req.params.token);
    if (q.status === "sent") {
      transaction(db, () => {
        const changed = db.prepare("UPDATE quotes SET status='viewed',viewed_at=?,updated_at=? WHERE business_id=? AND id=? AND status='sent'").run(stamp(), stamp(), q.business_id, q.id);
        if (changed.changes) log(q, "quote_status", `${q.reference} viewed`);
      });
      q = getQuote(q.business_id, q.id);
    }
    res.json(publicView(q));
  });
  publicRouter.post("/:token/respond", (req, res) => {
    let q = fromToken(req.params.token);
    if (req.get("Sec-Fetch-Site") === "cross-site") fail(403, "Open the quote link to respond.");
    const expectedOrigin = new URL(q.public_url).origin;
    if (req.get("Origin") && req.get("Origin") !== expectedOrigin) fail(403, "Open the quote link to respond.");
    if (!req.is("application/json")) fail(415, "Send the response as JSON.");
    const decision = req.body?.decision;
    if (!["accepted", "declined"].includes(decision)) fail(400, "Choose Accept or Decline.");
    if (q.status === decision) return res.json(publicView(q));
    if (!OPEN.has(q.status)) fail(409, "This quote is no longer waiting for a response.");
    transaction(db, () => {
      const changed = db.prepare("UPDATE quotes SET status=?,responded_at=?,updated_at=? WHERE business_id=? AND id=? AND status IN ('sent','viewed')").run(decision, stamp(), stamp(), q.business_id, q.id);
      if (!changed.changes) fail(409, "This quote has already been answered.");
      log(q, "quote_status", `${q.reference} ${decision}`);
    });
    q = getQuote(q.business_id, q.id);
    res.json(publicView(q));
  });

  function emailBounced(q) {
    return Boolean(db.prepare("SELECT 1 FROM quote_deliveries WHERE business_id=? AND quote_id=? AND channel='email' AND email_bounced=1").get(q.business_id, q.id));
  }
  function cancelSequence(q, reason) {
    const changed = db.prepare("UPDATE quotes SET follow_ups_cancelled_at=?,updated_at=? WHERE business_id=? AND id=? AND follow_ups_cancelled_at IS NULL").run(stamp(), stamp(), q.business_id, q.id);
    if (changed.changes) log(q, "quote_follow_ups_cancelled", `${q.reference} follow-ups stopped`, reason);
  }
  function stopChannel(q, channel, reason, initials) {
    let added = 0;
    for (const kind of ["nudge_2", "nudge_5"]) {
      added += Number(db.prepare("INSERT OR IGNORE INTO quote_deliveries (id,business_id,quote_id,channel,kind,status,error,attempts,created_at,updated_at) VALUES (?,?,?,?,?,'skipped',?,0,?,?)")
        .run(randomUUID(), q.business_id, q.id, channel, kind, reason, stamp(), stamp()).changes);
    }
    if (added) log(q, "quote_channel_stopped", `${q.reference} ${channel === "email" ? "email" : "text"} reminders stopped`, reason);
    // Preserve the single-channel cancellation behavior without stopping a
    // valid second channel when only one recipient or permission changed.
    if (initials.length === 1) cancelSequence(q, reason);
  }
  async function runQuoteNudges(businessId) {
    expire(businessId);
    const candidates = db.prepare(`SELECT * FROM quotes WHERE mode=? AND status IN ('sent','viewed') AND follow_ups_cancelled_at IS NULL AND sent_at<=? ${businessId ? "AND business_id=?" : ""}`)
      .all(...[smsMode, new Date(Date.parse(stamp()) - 2 * DAY).toISOString(), ...(businessId ? [businessId] : [])]);
    let sent = 0;
    let failed = 0;
    for (const candidate of candidates) {
      for (const channel of ["sms", "email"]) {
        const job = transaction(db, () => {
          const q = getQuote(candidate.business_id, candidate.id);
          if (!OPEN.has(q.status) || q.follow_ups_cancelled_at) return null;
          const initials = initialDeliveries(q);
          const initial = initials.find((d) => d.channel === channel);
          if (!initial) return null;
          const person = contact(q.business_id, q.contact_id);
          const biz = business(q.business_id);
          if (blocked(q.business_id, person)) {
            cancelSequence(q, "This customer has opted out of messages.");
            return null;
          }
          if (channel === "sms" && (!person.sms_consent || !PHONE_PATTERN.test(person.phone) || person.phone !== initial.recipient)) {
            stopChannel(q, channel, "Text permission or the customer's phone number changed.", initials);
            return null;
          }
          if (channel === "email" && (!validEmailAddress(person.email) || !validEmailAddress(initial.recipient) || person.email.toLowerCase() !== initial.recipient.toLowerCase() || emailBounced(q))) {
            stopChannel(q, channel, "The customer's email address changed, is invalid, or was rejected by the email provider.", initials);
            return null;
          }
          if (smsMode === "twilio" && (channel === "sms" ? !credentialsReady(biz) : !emailReady(biz))) return null;
          const age = Date.parse(stamp()) - Date.parse(q.sent_at);
          const kind = age >= 5 * DAY ? "nudge_5" : "nudge_2";
          if (kind === "nudge_5") {
            // After downtime, send one current reminder rather than a burst of
            // stale reminders. A skipped day-two reminder consumes that slot.
            db.prepare("INSERT OR IGNORE INTO quote_deliveries (id,business_id,quote_id,channel,kind,status,attempts,created_at,updated_at) VALUES (?,?,?,?,'nudge_2','skipped',0,?,?)").run(randomUUID(), q.business_id, q.id, channel, stamp(), stamp());
          }
          // Avoid generating new unsubscribe capabilities on repeated ticks once
          // this channel's durable reminder reservation has already been taken.
          if (db.prepare("SELECT 1 FROM quote_deliveries WHERE business_id=? AND quote_id=? AND channel=? AND kind=?").get(q.business_id, q.id, channel, kind)) return null;
          const snapshot = JSON.parse(q.snapshot_json);
          const unsubscribeUrl = channel === "email" ? initial.unsubscribe_url || newUnsubscribeUrl(q) : null;
          const body = channel === "sms"
            ? buildSms(snapshot.business, { name: snapshot.customer_name }, "quote_nudge", { url: q.public_url, reference: q.reference })
            : buildQuoteEmailText({ businessName: snapshot.business.name, customerName: snapshot.customer_name, url: q.public_url, unsubscribeUrl, kind: "quote_nudge", allowHttp: smsMode === "demo" });
          const delivery = reserve(q, channel, kind, initial.recipient, body, unsubscribeUrl);
          return delivery ? { q, biz, delivery } : null;
        });
        if (!job) continue;
        // Recheck status, permission and each channel after provider I/O. The
        // database's channel/kind uniqueness also protects concurrent workers.
        if (await deliver(job.q, job.biz, job.delivery)) sent += 1;
        else failed += 1;
      }
    }
    return { sent, failed };
  }
  function dashboard(businessId) {
    expire(businessId);
    return { quotes_awaiting_response: db.prepare("SELECT * FROM quotes WHERE business_id=? AND status IN ('sent','viewed') ORDER BY sent_at,id").all(businessId).map(quoteView) };
  }
  return { adminRouter, publicRouter, dashboard, runQuoteNudges };
}
