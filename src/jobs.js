import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transaction } from "./db.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = new Set(["service", "installation"]);
const STATUSES = new Set(["awaiting_scheduling", "scheduled", "waiting_parts", "in_progress", "completed", "follow_up", "cancelled"]);
const STATUS_LABELS = { awaiting_scheduling: "Awaiting scheduling", scheduled: "Booked", waiting_parts: "Waiting for parts", in_progress: "Work underway", completed: "Completed", follow_up: "Follow-up needed", cancelled: "Cancelled" };
const PUBLIC_FIELDS = ["title", "job_type", "status", "description", "service_address", "scheduled_date", "arrival_start", "arrival_end", "time_zone"];
const SCHEDULE_FIELDS = ["scheduled_date", "arrival_start", "arrival_end", "time_zone"];

export class JobError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new JobError(status, message); };
function text(value, label, max, required = false) {
  if (typeof value !== "string") fail(400, `${label} must be text.`);
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result))
    fail(400, `Enter ${label.toLowerCase()}${required ? "" : " within the allowed length"}.`);
  return result;
}
function fields(input, previous = {}) {
  const get = (name, fallback = "") => input[name] === undefined ? previous[name] ?? fallback : input[name];
  const values = {
    title: text(get("title"), "Job title", 160, true),
    job_type: get("job_type", "service"),
    status: get("status", "awaiting_scheduling"),
    description: text(get("description"), "Work details", 5000),
    service_address: text(get("service_address"), "Service address", 1000, true),
    scheduled_date: text(get("scheduled_date"), "Appointment date", 10),
    arrival_start: text(get("arrival_start"), "Arrival window start", 5),
    arrival_end: text(get("arrival_end"), "Arrival window end", 5),
    time_zone: text(get("time_zone", "America/Toronto"), "Time zone", 100, true),
    private_notes: text(get("private_notes"), "Private notes", 10000),
  };
  if (!TYPES.has(values.job_type)) fail(400, "Choose service / repair or installation.");
  if (!STATUSES.has(values.status)) fail(400, "Choose a valid job status.");
  try {
    if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(values.time_zone)) throw new Error();
    new Intl.DateTimeFormat("en", { timeZone: values.time_zone }).format();
  }
  catch { fail(400, "Choose a valid appointment time zone."); }
  const hasSchedule = Boolean(values.scheduled_date || values.arrival_start || values.arrival_end);
  if (hasSchedule) {
    const day = values.scheduled_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T12:00:00Z`)) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day)
      fail(400, "Enter a valid appointment date.");
    if (![values.arrival_start, values.arrival_end].every((value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)))
      fail(400, "Enter both times for the arrival window.");
    if (values.arrival_end <= values.arrival_start) fail(400, "The arrival window must end after it starts on the same day.");
    if (values.status === "awaiting_scheduling") fail(400, "Choose Booked for this appointment, or clear the date and arrival window.");
  } else if (values.status === "scheduled") fail(400, "Add a date and arrival window before marking this job Booked.");
  return values;
}
function origin(value, demo) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(503, "Set up the public app address before sharing a customer job link."); }
  const local = demo && parsed.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname);
  if ((!local && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname))
    fail(503, "Use the app's public HTTPS address before sharing a customer job link.");
  return parsed.origin;
}

export function createJobModule({ db, smsMode, now = () => new Date(), publicOrigin, uploadDir = resolve(ROOT, "data/uploads") }) {
  const adminRouter = express.Router({ mergeParams: true });
  const publicRouter = express.Router();
  const stamp = () => new Date(now()).toISOString();
  const business = (businessId) => {
    const found = db.prepare("SELECT * FROM businesses WHERE id=?").get(businessId);
    if (!found) fail(404, "Business not found.");
    return found;
  };
  const contact = (businessId, contactId) => {
    const found = db.prepare("SELECT * FROM contacts WHERE business_id=? AND id=?").get(businessId, contactId);
    if (!found) fail(404, "Customer not found in this business.");
    return found;
  };
  const get = (businessId, id) => {
    const found = db.prepare("SELECT * FROM jobs WHERE business_id=? AND id=?").get(businessId, id);
    if (!found) fail(404, "Job not found in this business.");
    return found;
  };
  const linkedQuote = (businessId, quoteId) => {
    const found = db.prepare("SELECT * FROM quotes WHERE business_id=? AND id=?").get(businessId, quoteId);
    if (!found) fail(404, "Quote not found in this business.");
    return found;
  };
  function updates(job) {
    return db.prepare("SELECT id,message,status,created_at FROM job_updates WHERE business_id=? AND job_id=? ORDER BY created_at,rowid")
      .all(job.business_id, job.id);
  }
  function addUpdate(job, message, when) {
    db.prepare("INSERT INTO job_updates (business_id,id,job_id,message,status,created_at) VALUES (?,?,?,?,?,?)")
      .run(job.business_id, randomUUID(), job.id, message, job.status, when);
  }
  function log(job, kind, label, when) {
    // Activity records deliberately omit customer links and private notes.
    db.prepare("INSERT INTO activity (id,business_id,contact_id,quote_id,job_id,kind,label,mode,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), job.business_id, job.contact_id, job.quote_id, job.id, kind, label, job.mode, when);
  }
  function quoteSummary(job, admin = false) {
    if (!job.quote_id) return null;
    const q = linkedQuote(job.business_id, job.quote_id);
    if (q.status !== "accepted" || q.contact_id !== job.contact_id || q.mode !== job.mode) return null;
    return { ...(admin ? { id: q.id, status: q.status } : {}), reference: q.reference, public_url: q.public_url || null, total_cents: q.total_cents, currency: q.currency };
  }
  function adminView(job) {
    const { public_token, customer_name, link_revoked_at, shared_at, ...visible } = job;
    const enabled = Boolean(public_token && !link_revoked_at && job.public_url);
    return { ...visible, contact_name: customer_name, public_url: enabled ? job.public_url : null, link_enabled: enabled, public_updates: updates(job), quote: quoteSummary(job, true) };
  }
  function publicView(job) {
    const biz = business(job.business_id);
    return {
      reference: job.reference,
      ...Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, job[field]])),
      customer_name: job.customer_name,
      business: { name: biz.name, phone: biz.phone, booking_url: biz.booking_url, logo_url: biz.logo_url ? `/j/${job.public_token}/logo` : null },
      mode: job.mode === "demo" ? "demo" : "live",
      public_updates: updates(job),
      updated_at: job.public_updated_at,
      quote: quoteSummary(job),
    };
  }
  function fromToken(token) {
    if (!/^[a-f0-9]{64}$/.test(token)) fail(404, "This job link is unavailable. Ask the business for a current link.");
    const job = db.prepare("SELECT * FROM jobs WHERE public_token=? AND link_revoked_at IS NULL AND public_url IS NOT NULL").get(token);
    if (!job) fail(404, "This job link is unavailable. Ask the business for a current link.");
    return job;
  }

  adminRouter.use((req, res, next) => { try { business(req.params.businessId); next(); } catch (error) { next(error); } });
  adminRouter.get("/", (req, res) => {
    const status = req.query.status, type = req.query.job_type;
    if (status && !STATUSES.has(status)) fail(400, "Choose a valid job status.");
    if (type && !TYPES.has(type)) fail(400, "Choose a valid job type.");
    const clauses = ["business_id=?"], values = [req.params.businessId];
    if (status) { clauses.push("status=?"); values.push(status); }
    if (type) { clauses.push("job_type=?"); values.push(type); }
    const rows = db.prepare(`SELECT * FROM jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,rowid DESC`).all(...values);
    res.json(rows.map(adminView));
  });
  adminRouter.post("/", (req, res) => {
    const input = req.body || {};
    const quoteId = input.quote_id === undefined || input.quote_id === null || input.quote_id === "" ? null : text(input.quote_id, "Quote", 100, true);
    const quote = quoteId ? linkedQuote(req.params.businessId, quoteId) : null;
    if (quote && quote.status !== "accepted") fail(409, "Only an accepted quote can be added to a job.");
    if (quote && quote.mode !== smsMode) fail(409, "Create this job in the same sending mode as its accepted quote.");
    const contactId = text(input.contact_id ?? quote?.contact_id ?? "", "Customer", 100, true);
    const person = contact(req.params.businessId, contactId);
    if (quote && quote.contact_id !== person.id) fail(400, "Choose the customer who accepted this quote.");
    const existing = quote && db.prepare("SELECT * FROM jobs WHERE business_id=? AND quote_id=?").get(req.params.businessId, quote.id);
    if (existing) return res.json(adminView(existing));
    const values = fields(input);
    const message = input.customer_update === undefined ? "" : text(input.customer_update, "Customer update", 5000);
    const when = stamp(), id = randomUUID();
    let customerName = person.name;
    if (quote?.snapshot_json) customerName = JSON.parse(quote.snapshot_json).customer_name || person.name;
    const job = { business_id: req.params.businessId, id, contact_id: person.id, customer_name: customerName, quote_id: quoteId, reference: `J-${id.slice(0, 8).toUpperCase()}`, ...values, mode: smsMode, public_token: null, public_url: null, link_revoked_at: null, shared_at: null, public_updated_at: when, created_at: when, updated_at: when };
    transaction(db, () => {
      const keys = Object.keys(job);
      db.prepare(`INSERT INTO jobs (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => job[key]));
      addUpdate(job, message || "Job created.", when);
      log(job, "job_created", `${job.reference} created`, when);
    });
    res.status(201).json(adminView(job));
  });
  adminRouter.get("/:id", (req, res) => res.json(adminView(get(req.params.businessId, req.params.id))));
  adminRouter.patch("/:id", (req, res) => {
    const input = req.body || {}, job = get(req.params.businessId, req.params.id);
    if (input.contact_id !== undefined && input.contact_id !== job.contact_id) fail(400, "A job stays linked to its original customer.");
    if (input.quote_id !== undefined && (input.quote_id || null) !== job.quote_id) fail(400, "A job stays linked to its original quote.");
    const values = fields(input, job);
    const message = input.customer_update === undefined ? "" : text(input.customer_update, "Customer update", 5000);
    const changed = Object.keys(values).filter((key) => values[key] !== job[key]);
    if (!changed.length && !message) return res.json(adminView(job));
    const publicChange = changed.some((key) => PUBLIC_FIELDS.includes(key)) || Boolean(message);
    const statusChange = changed.includes("status"), scheduleChange = changed.some((key) => SCHEDULE_FIELDS.includes(key));
    const when = stamp(), next = { ...job, ...values, updated_at: when, public_updated_at: publicChange ? when : job.public_updated_at };
    transaction(db, () => {
      db.prepare(`UPDATE jobs SET ${Object.keys(values).map((key) => `${key}=?`).join(",")},updated_at=?,public_updated_at=? WHERE business_id=? AND id=?`)
        .run(...Object.values(values), when, next.public_updated_at, job.business_id, job.id);
      if (message || statusChange || scheduleChange) addUpdate(next, message || (statusChange ? `Status changed to ${STATUS_LABELS[next.status]}.` : "Appointment updated."), when);
      if (statusChange) log(next, "job_status", `${next.reference} marked ${STATUS_LABELS[next.status]}`, when);
      else log(next, message ? "job_customer_update" : "job_updated", `${next.reference} ${message ? "customer update published" : "details updated"}`, when);
    });
    res.json(adminView(next));
  });
  function share(req, res, rotate) {
    const job = get(req.params.businessId, req.params.id);
    if (!rotate && job.public_token && !job.link_revoked_at && job.public_url) return res.json(adminView(job));
    const base = origin(typeof publicOrigin === "function" ? publicOrigin(req) : publicOrigin, job.mode === "demo");
    const token = randomBytes(32).toString("hex"), when = stamp();
    const next = { ...job, public_token: token, public_url: `${base}/j/${token}`, link_revoked_at: null, shared_at: when };
    transaction(db, () => {
      db.prepare("UPDATE jobs SET public_token=?,public_url=?,link_revoked_at=NULL,shared_at=? WHERE business_id=? AND id=?")
        .run(token, next.public_url, when, job.business_id, job.id);
      log(next, "job_link", `${next.reference} customer link ${rotate ? "renewed" : "enabled"}`, when);
    });
    res.json(adminView(next));
  }
  adminRouter.post("/:id/share", (req, res) => share(req, res, false));
  adminRouter.post("/:id/rotate-link", (req, res) => share(req, res, true));
  adminRouter.post("/:id/revoke-link", (req, res) => {
    const job = get(req.params.businessId, req.params.id);
    if (!job.public_token || job.link_revoked_at) return res.json(adminView(job));
    const when = stamp(), next = { ...job, public_url: null, link_revoked_at: when };
    transaction(db, () => {
      db.prepare("UPDATE jobs SET public_url=NULL,link_revoked_at=? WHERE business_id=? AND id=?").run(when, job.business_id, job.id);
      log(next, "job_link", `${next.reference} customer link turned off`, when);
    });
    res.json(adminView(next));
  });

  publicRouter.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  publicRouter.get("/assets/job.js", (req, res) => res.sendFile(resolve(ROOT, "public/job.js")));
  publicRouter.get("/assets/job.css", (req, res) => res.sendFile(resolve(ROOT, "public/job.css")));
  publicRouter.get("/:token/data", (req, res) => res.json(publicView(fromToken(req.params.token))));
  publicRouter.get("/:token/logo", (req, res) => {
    const job = fromToken(req.params.token), logo = business(job.business_id).logo_url;
    if (!logo || !/^\/uploads\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/i.test(logo)) fail(404, "Business logo not found.");
    res.sendFile(resolve(uploadDir, basename(logo)));
  });
  publicRouter.get("/:token", (req, res) => {
    fromToken(req.params.token);
    res.sendFile(resolve(ROOT, "public/job.html"));
  });
  publicRouter.use((req, res) => res.status(404).json({ error: "This customer job action was not found." }));
  return { adminRouter, publicRouter };
}
