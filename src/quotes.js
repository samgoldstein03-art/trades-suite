import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transaction } from "./db.js";
import { buildSms, credentialsFor, credentialsReady, PHONE_PATTERN, safeFailure } from "./sms.js";
import { safeEmailFailure } from "./email.js";

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
    return db.prepare("SELECT id,channel,kind,status,error,error_code,attempts,created_at,updated_at FROM quote_deliveries WHERE business_id=? AND quote_id=? ORDER BY created_at,rowid")
      .all(q.business_id, q.id);
  }
  function quoteView(q) {
    const snapshot = q.snapshot_json ? JSON.parse(q.snapshot_json) : null;
    const sends = deliveries(q);
    const nudges = sends.filter((d) => d.kind !== "initial" && ["sent", "simulated"].includes(d.status)).length;
    const { public_token, snapshot_json, follow_up_phone, ...visible } = q;
    const sendable = ["draft", "sent", "viewed"].includes(q.status) ? ["sms", "email"].filter((channel) => {
      const attempt = sends.find((d) => d.channel === channel && d.kind === "initial");
      return !attempt || attempt.status === "failed";
    }) : [];
    return { ...visible, contact_name: snapshot?.customer_name || contact(q.business_id, q.contact_id).name, line_items: JSON.parse(q.line_items), deliveries: sends, nudge_count: nudges, nudges_sent: nudges, sendable_channels: sendable };
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
    return Boolean(person.opted_out || db.prepare("SELECT 1 FROM phone_opt_outs WHERE business_id=? AND phone=?").get(businessId, person.phone));
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
  function reserve(q, channel, kind, recipient, body) {
    const existing = db.prepare("SELECT * FROM quote_deliveries WHERE business_id=? AND quote_id=? AND channel=? AND kind=?").get(q.business_id, q.id, channel, kind);
    if (existing) {
      // A provider rejection may be retried explicitly for the initial send.
      // Unknown outcomes, successful sends, and all follow-ups are never retried.
      if (kind !== "initial" || existing.status !== "failed") return null;
      db.prepare("UPDATE quote_deliveries SET status='sending',recipient=?,body=?,error=NULL,error_code=NULL,attempts=attempts+1,updated_at=? WHERE id=? AND status='failed'").run(recipient, body, stamp(), existing.id);
      return { ...existing, status: "sending", recipient, body };
    }
    const delivery = { id: randomUUID(), business_id: q.business_id, quote_id: q.id, channel, kind, recipient, body };
    db.prepare("INSERT INTO quote_deliveries (id,business_id,quote_id,channel,kind,status,recipient,body,created_at,updated_at) VALUES (?,?,?,?,?,'sending',?,?,?,?)")
      .run(delivery.id, q.business_id, q.id, channel, kind, recipient, body, stamp(), stamp());
    return delivery;
  }
  async function deliver(q, biz, delivery) {
    try {
      let result;
      if (smsMode === "twilio") {
        result = delivery.channel === "sms"
          ? await sendSms({ ...credentialsFor(biz), to: delivery.recipient, body: delivery.body, businessId: biz.id })
          : await sendEmail({ business: biz, to: delivery.recipient, subject: `${q.reference} from ${biz.name}`, text: delivery.body });
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
        db.prepare("UPDATE quote_deliveries SET status=?,error_code=?,error=?,updated_at=? WHERE id=?").run(failure.uncertain ? "uncertain" : "failed", failure.code, failure.message, stamp(), delivery.id);
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
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email)) fail(400, "Add a customer email address first.");
      if (smsMode === "twilio" && !emailReady(biz)) fail(400, "Add this business email settings before sending email.");
    }
    const url = q.public_url || buildUrl(req, q);
    const snapshot = q.snapshot_json ? JSON.parse(q.snapshot_json) : { business: { name: biz.name, phone: biz.phone, booking_url: biz.booking_url, logo_url: biz.logo_url }, customer_name: person.name };
    const jobs = transaction(db, () => {
      const reserved = [];
      for (const channel of channels) {
        const body = channel === "sms" ? buildSms(snapshot.business, { name: snapshot.customer_name }, "quote", { url, reference: q.reference }) : `Hi ${snapshot.customer_name.split(/\s+/)[0]},\n\nYour quote from ${snapshot.business.name} is ready. View it and accept or decline here:\n${url}\n\n${snapshot.business.name}`;
        const delivery = reserve(q, channel, "initial", channel === "sms" ? person.phone : person.email, body);
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

  async function runQuoteNudges(businessId) {
    expire(businessId);
    const candidates = db.prepare(`SELECT * FROM quotes WHERE mode=? AND status IN ('sent','viewed') AND follow_ups_cancelled_at IS NULL AND sent_at<=? ${businessId ? "AND business_id=?" : ""}`)
      .all(...[smsMode, new Date(Date.parse(stamp()) - 2 * DAY).toISOString(), ...(businessId ? [businessId] : [])]);
    let sent = 0;
    let failed = 0;
    for (const candidate of candidates) {
      const job = transaction(db, () => {
        const q = getQuote(candidate.business_id, candidate.id);
        if (!OPEN.has(q.status) || q.follow_ups_cancelled_at) return null;
        const person = contact(q.business_id, q.contact_id);
        const biz = business(q.business_id);
        if (!person.sms_consent || blocked(q.business_id, person) || person.phone !== q.follow_up_phone) {
          db.prepare("UPDATE quotes SET follow_ups_cancelled_at=?,updated_at=? WHERE business_id=? AND id=?").run(stamp(), stamp(), q.business_id, q.id);
          log(q, "quote_follow_ups_cancelled", `${q.reference} follow-ups stopped`, "Text permission or the customer's phone number changed.");
          return null;
        }
        if (smsMode === "twilio" && !credentialsReady(biz)) return null;
        const age = Date.parse(stamp()) - Date.parse(q.sent_at);
        const kind = age >= 5 * DAY ? "nudge_5" : "nudge_2";
        if (kind === "nudge_5") {
          // After downtime, send one current reminder rather than a burst of
          // stale reminders. A skipped day-two reminder consumes that slot.
          db.prepare("INSERT OR IGNORE INTO quote_deliveries (id,business_id,quote_id,channel,kind,status,created_at,updated_at) VALUES (?,?,?,'sms','nudge_2','skipped',?,?)").run(randomUUID(), q.business_id, q.id, stamp(), stamp());
        }
        const snapshot = JSON.parse(q.snapshot_json);
        const body = buildSms(snapshot.business, { name: snapshot.customer_name }, "quote_nudge", { url: q.public_url, reference: q.reference });
        const delivery = reserve(q, "sms", kind, q.follow_up_phone, body);
        return delivery ? { q, biz, delivery } : null;
      });
      if (!job) continue;
      // No await occurs between checking eligibility and reserving the send.
      // A second worker/process sees the durable reservation and cannot resend.
      if (await deliver(job.q, job.biz, job.delivery)) sent += 1;
      else failed += 1;
    }
    return { sent, failed };
  }
  function dashboard(businessId) {
    expire(businessId);
    return { quotes_awaiting_response: db.prepare("SELECT * FROM quotes WHERE business_id=? AND status IN ('sent','viewed') ORDER BY sent_at,id").all(businessId).map(quoteView) };
  }
  return { adminRouter, publicRouter, dashboard, runQuoteNudges };
}
