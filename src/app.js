import express from "express";
import multer from "multer";
import twilio from "twilio";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, transaction } from "./db.js";
import { createAdminAccess } from "./admin.js";
import {
  buildSms,
  credentialsFor,
  credentialsReady,
  PHONE_PATTERN,
  safeFailure,
  twilioTransport,
} from "./sms.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THREE_DAYS = 72 * 60 * 60 * 1000;
const STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);
const START_WORDS = new Set(["START", "UNSTOP"]);

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => {
  throw new AppError(400, message);
};

function textValue(value, label, max, required = false) {
  if (typeof value !== "string") bad(`${label} must be text.`);
  const result = value.trim();
  if (required && !result) bad(`Enter ${label.toLowerCase()}.`);
  if (result.length > max)
    bad(`${label} is too long (maximum ${max} characters).`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result))
    bad(`${label} contains unsupported characters.`);
  return result;
}

function phoneValue(value) {
  const raw = textValue(value, "Phone number", 40, true);
  const phone = raw.replace(/[\s().-]/g, "");
  if (!PHONE_PATTERN.test(phone))
    bad("Enter a phone number with its country code, such as +14165550123.");
  return phone;
}

function urlValue(value, label) {
  const text = textValue(value, label, 2000);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
  } catch {
    bad(`${label} must be a full http or https link.`);
  }
  return text;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") bad(`${label} must be true or false.`);
  return value ? 1 : 0;
}

export function createApp({
  dbPath = process.env.DATABASE_PATH || resolve(ROOT, "data/suite.sqlite"),
  smsMode = process.env.SMS_MODE || "demo",
  now = () => new Date(),
  sendSms = twilioTransport,
  uploadDir = process.env.UPLOAD_DIR || resolve(ROOT, "data/uploads"),
} = {}) {
  if (!["demo", "twilio"].includes(smsMode))
    throw new Error("SMS_MODE must be demo or twilio.");
  const admin = createAdminAccess();
  const db = openDatabase(dbPath);
  const app = express();
  const uploadPath = resolve(uploadDir);
  mkdirSync(uploadPath, { recursive: true });
  const stamp = () => new Date(now()).toISOString();
  const getBusiness = (id) => {
    const business = db
      .prepare("SELECT * FROM businesses WHERE id = ?")
      .get(id);
    if (!business) throw new AppError(404, "Business not found.");
    return business;
  };
  const getContact = (businessId, contactId) => {
    const contact = db
      .prepare("SELECT * FROM contacts WHERE business_id = ? AND id = ?")
      .get(businessId, contactId);
    if (!contact)
      throw new AppError(404, "Customer not found in this business.");
    return contact;
  };
  const getRequest = (businessId, requestId) => {
    const request = db
      .prepare(
        `SELECT r.*, c.name AS contact_name, c.phone AS contact_phone
      FROM review_requests r JOIN contacts c ON c.business_id = r.business_id AND c.id = r.contact_id
      WHERE r.business_id = ? AND r.id = ?`,
      )
      .get(businessId, requestId);
    if (!request)
      throw new AppError(404, "Review request not found in this business.");
    return request;
  };
  const businessView = (business) => ({
    ...business,
    sms_ready: smsMode === "demo" || credentialsReady(business),
  });
  const contactView = (contact) => ({
    ...contact,
    tags: JSON.parse(contact.tags),
    sms_consent: Boolean(contact.sms_consent),
    opted_out: Boolean(contact.opted_out),
  });
  const log = ({
    businessId,
    contactId = null,
    requestId = null,
    kind,
    label,
    body = null,
    mode = null,
  }) => {
    db.prepare(
      `INSERT INTO activity (id, business_id, contact_id, request_id, kind, label, body, mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      businessId,
      contactId,
      requestId,
      kind,
      label,
      body,
      mode,
      stamp(),
    );
  };
  const activities = (businessId, limit = 100) =>
    db
      .prepare(
        `SELECT a.*, c.name AS contact_name
    FROM activity a LEFT JOIN contacts c ON c.business_id = a.business_id AND c.id = a.contact_id
    WHERE a.business_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
      )
      .all(businessId, limit);
  const isBlocked = (businessId, contact) =>
    Boolean(
      contact.opted_out ||
        db
          .prepare(
            "SELECT 1 FROM phone_opt_outs WHERE business_id = ? AND phone = ?",
          )
          .get(businessId, contact.phone),
    );

  function optOutPhone(businessId, phone, source) {
    const added = db
      .prepare(
        "INSERT OR IGNORE INTO phone_opt_outs (business_id, phone, created_at) VALUES (?, ?, ?)",
      )
      .run(businessId, phone, stamp());
    const changed = db
      .prepare(
        "UPDATE contacts SET opted_out = 1, updated_at = ? WHERE business_id = ? AND phone = ? AND opted_out = 0",
      )
      .run(stamp(), businessId, phone);
    if (added.changes || changed.changes) {
      const contact = db
        .prepare(
          "SELECT id FROM contacts WHERE business_id=? AND phone=? LIMIT 1",
        )
        .get(businessId, phone);
      log({
        businessId,
        contactId: contact?.id || null,
        kind: "opt_out",
        label: source,
      });
    }
  }

  function validateCanSend(business, contact) {
    if (!business.google_review_url)
      bad("Add this business Google review link before sending a request.");
    if (!contact.sms_consent)
      bad("Confirm this customer has agreed to receive review-request texts.");
    if (isBlocked(business.id, contact))
      bad("This customer has opted out of texts.");
    if (smsMode === "twilio" && !credentialsReady(business))
      bad(
        "Add this business Twilio settings to the .env file, then restart the app.",
      );
  }

  function reserveMessage(business, contact, kind, requestId = null) {
    const message = {
      id: randomUUID(),
      business_id: business.id,
      contact_id: contact.id,
      request_id: requestId,
      kind,
      mode: smsMode,
      body: buildSms(business, contact, kind),
      to_phone: contact.phone,
    };
    db.prepare(
      `INSERT INTO sms_messages
      (id,business_id,contact_id,request_id,kind,mode,body,to_phone,delivery_status,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
    ).run(
      message.id,
      business.id,
      contact.id,
      requestId,
      kind,
      smsMode,
      message.body,
      contact.phone,
      stamp(),
      stamp(),
    );
    return message;
  }

  async function deliver(business, message) {
    if (smsMode === "demo") return { sid: `DEMO_${randomUUID()}` };
    const result = await sendSms({
      ...credentialsFor(business),
      to: message.to_phone,
      body: message.body,
      businessId: business.id,
      kind: message.kind,
    });
    if (!result?.sid)
      throw new Error("Provider did not return a message identifier.");
    return result;
  }

  function recordFailure(business, message, error, requestId = null) {
    const failure = safeFailure(error);
    db.prepare(
      "UPDATE sms_messages SET delivery_status = ?, error_code = ?, updated_at = ? WHERE business_id = ? AND id = ?",
    ).run(
      failure.uncertain ? "uncertain" : "failed",
      failure.code,
      stamp(),
      business.id,
      message.id,
    );
    if (failure.code === 21610)
      optOutPhone(
        business.id,
        message.to_phone,
        "Customer opted out of texts (confirmed by Twilio).",
      );
    log({
      businessId: business.id,
      contactId: message.contact_id,
      requestId,
      kind: failure.uncertain ? "sms_uncertain" : "sms_failed",
      label: `${message.kind === "nudge" ? "Follow-up" : "Review request"} could not be confirmed. ${failure.message}`,
      body: message.body,
      mode: smsMode,
    });
    return failure;
  }

  // Health and signature-verified Twilio callbacks are the only public routes.
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    res.set("X-Frame-Options", "DENY");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    next();
  });

  app.post(
    "/webhooks/twilio/:businessId",
    express.urlencoded({ extended: false, limit: "32kb" }),
    (req, res) => {
      const business = getBusiness(req.params.businessId);
      const credentials = credentialsFor(business);
      const baseUrl = admin.webhookOrigin;
      const signature = req.get("X-Twilio-Signature") || "";
      if (
        !baseUrl ||
        !credentialsReady(business) ||
        !signature ||
        !twilio.validateRequest(
          credentials.authToken,
          signature,
          `${baseUrl}${req.originalUrl}`,
          req.body,
        ) ||
        req.body.AccountSid !== credentials.accountSid ||
        req.body.To !== credentials.from
      ) {
        throw new AppError(403, "Webhook signature could not be verified.");
      }
      const phone = req.body.From;
      if (!PHONE_PATTERN.test(phone || ""))
        throw new AppError(400, "Invalid sender phone number.");
      const keyword = String(req.body.Body || "")
        .trim()
        .toUpperCase();
      const optOutType = String(req.body.OptOutType || "").toUpperCase();
      transaction(db, () => {
        if (optOutType === "STOP" || STOP_WORDS.has(keyword)) {
          optOutPhone(
            business.id,
            phone,
            "Customer replied STOP and opted out of texts.",
          );
        } else if (optOutType === "START" || START_WORDS.has(keyword)) {
          const removed = db
            .prepare(
              "DELETE FROM phone_opt_outs WHERE business_id = ? AND phone = ?",
            )
            .run(business.id, phone);
          const changed = db
            .prepare(
              "UPDATE contacts SET opted_out = 0, updated_at = ? WHERE business_id = ? AND phone = ? AND opted_out = 1",
            )
            .run(stamp(), business.id, phone);
          if (removed.changes || changed.changes) {
            const contact = db
              .prepare(
                "SELECT id FROM contacts WHERE business_id=? AND phone=? LIMIT 1",
              )
              .get(business.id, phone);
            log({
              businessId: business.id,
              contactId: contact?.id || null,
              kind: "opt_in",
              label: "Customer replied START and allowed texts again.",
            });
          }
        }
      });
      res
        .type("text/xml")
        .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    },
  );

  app.get("/healthz", (req, res) => {
    db.prepare("SELECT 1").get();
    res.set("Cache-Control", "no-store").json({ status: "ok" });
  });
  app.use(admin.middleware);

  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const configuredOrigin = admin.adminOrigin;
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(
      req.get("host") || "",
    );
    if (
      !localHost &&
      (!configuredOrigin || req.get("host") !== new URL(configuredOrigin).host)
    ) {
      return next(
        new AppError(403, "Open the app using its configured address."),
      );
    }
    const site = req.get("Sec-Fetch-Site");
    if (site === "cross-site")
      return next(new AppError(403, "Open this app directly to continue."));
    const origin = req.get("Origin");
    const expectedOrigin =
      configuredOrigin || `${req.protocol}://${req.get("host")}`;
    if (origin && origin !== expectedOrigin)
      return next(new AppError(403, "This request must come from the app."));
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.is("application/json") &&
      !req.is("multipart/form-data")
    ) {
      return next(new AppError(415, "Send this request as JSON."));
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.is("application/json") &&
      (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
    ) {
      return next(new AppError(400, "Send the form details as a JSON object."));
    }
    next();
  });

  app.get("/api/config", (req, res) =>
    res.json({ sms_mode: smsMode, nudge_after_hours: 72 }),
  );
  app.get("/api/businesses", (req, res) =>
    res.json(
      db
        .prepare("SELECT * FROM businesses ORDER BY created_at, rowid")
        .all()
        .map(businessView),
    ),
  );

  function businessInput(body, existing = {}) {
    const merged = {
      name: "",
      phone: "",
      booking_url: "",
      google_review_url: "",
      ...existing,
      ...body,
    };
    const name = textValue(merged.name, "Business name", 100, true);
    if (/\r|\n/.test(name)) bad("Business name must be on one line.");
    const smsKey = textValue(
      merged.sms_key ||
        name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
      "SMS key",
      50,
      true,
    ).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,49}$/.test(smsKey))
      bad(
        "SMS key must start with a letter and use only letters, numbers and underscores.",
      );
    return {
      name,
      phone: phoneValue(merged.phone),
      booking_url: urlValue(merged.booking_url, "Booking link"),
      google_review_url: urlValue(
        merged.google_review_url,
        "Google review link",
      ),
      sms_key: smsKey,
    };
  }

  app.post("/api/businesses", (req, res) => {
    const data = businessInput(req.body);
    if (
      db.prepare("SELECT 1 FROM businesses WHERE sms_key = ?").get(data.sms_key)
    )
      throw new AppError(
        409,
        "That SMS key is already used by another business. Choose a different key.",
      );
    const id = randomUUID();
    db.prepare(
      "INSERT INTO businesses (id,name,phone,booking_url,google_review_url,sms_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      id,
      data.name,
      data.phone,
      data.booking_url,
      data.google_review_url,
      data.sms_key,
      stamp(),
      stamp(),
    );
    log({ businessId: id, kind: "business_created", label: "Business added." });
    res.status(201).json(businessView(getBusiness(id)));
  });

  app.patch("/api/businesses/:businessId", (req, res) => {
    const existing = getBusiness(req.params.businessId);
    const data = businessInput(req.body, existing);
    if (
      db
        .prepare("SELECT 1 FROM businesses WHERE sms_key = ? AND id != ?")
        .get(data.sms_key, existing.id)
    )
      throw new AppError(
        409,
        "That SMS key is already used by another business.",
      );
    if (
      data.sms_key !== existing.sms_key &&
      db
        .prepare(
          "SELECT 1 FROM sms_messages WHERE business_id = ? AND delivery_status = 'sending'",
        )
        .get(existing.id)
    ) {
      throw new AppError(
        409,
        "Wait until this business has finished sending its texts before changing the SMS key.",
      );
    }
    db.prepare(
      "UPDATE businesses SET name=?,phone=?,booking_url=?,google_review_url=?,sms_key=?,updated_at=? WHERE id=?",
    ).run(
      data.name,
      data.phone,
      data.booking_url,
      data.google_review_url,
      data.sms_key,
      stamp(),
      existing.id,
    );
    log({
      businessId: existing.id,
      kind: "business_updated",
      label: "Business details updated.",
    });
    res.json(businessView(getBusiness(existing.id)));
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
  });
  app.post(
    "/api/businesses/:businessId/logo",
    (req, res, next) => {
      getBusiness(req.params.businessId);
      next();
    },
    upload.single("logo"),
    (req, res) => {
      if (!req.file) bad("Choose a PNG, JPEG or WebP logo.");
      const bytes = req.file.buffer;
      let extension;
      if (
        bytes.length > 24 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.subarray(12, 16).toString() === "IHDR"
      )
        extension = "png";
      else if (
        bytes.length > 10 &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255 &&
        bytes[bytes.length - 2] === 255 &&
        bytes[bytes.length - 1] === 217
      )
        extension = "jpg";
      else if (
        bytes.length > 16 &&
        bytes.subarray(0, 4).toString() === "RIFF" &&
        bytes.subarray(8, 12).toString() === "WEBP"
      )
        extension = "webp";
      else bad("That file is not a PNG, JPEG or WebP image.");
      const filename = `${randomUUID()}.${extension}`;
      writeFileSync(resolve(uploadPath, filename), bytes, { flag: "wx" });
      db.prepare(
        "UPDATE businesses SET logo_url = ?, updated_at = ? WHERE id = ?",
      ).run(`/uploads/${filename}`, stamp(), req.params.businessId);
      log({
        businessId: req.params.businessId,
        kind: "business_updated",
        label: "Business logo updated.",
      });
      res.json(businessView(getBusiness(req.params.businessId)));
    },
  );

  function contactInput(body, existing = {}) {
    const merged = {
      name: "",
      phone: "",
      email: "",
      notes: "",
      tags: ["customer"],
      sms_consent: false,
      opted_out: false,
      ...existing,
      ...body,
    };
    const name = textValue(merged.name, "Customer name", 120, true);
    if (/\r|\n/.test(name)) bad("Customer name must be on one line.");
    const email = textValue(merged.email, "Email address", 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      bad("Enter a valid email address.");
    if (
      !Array.isArray(merged.tags) ||
      merged.tags.length > 2 ||
      merged.tags.some((tag) => !["lead", "customer"].includes(tag))
    )
      bad("Choose lead, customer, or both as tags.");
    return {
      name,
      phone: phoneValue(merged.phone),
      email,
      notes: textValue(merged.notes, "Notes", 5000),
      tags: JSON.stringify([...new Set(merged.tags)]),
      sms_consent: booleanValue(merged.sms_consent, "Text permission"),
      opted_out: booleanValue(merged.opted_out, "Opt-out setting"),
    };
  }

  app.get("/api/businesses/:businessId/contacts", (req, res) => {
    getBusiness(req.params.businessId);
    res.json(
      db
        .prepare(
          "SELECT * FROM contacts WHERE business_id = ? ORDER BY name COLLATE NOCASE, id",
        )
        .all(req.params.businessId)
        .map(contactView),
    );
  });

  app.post("/api/businesses/:businessId/contacts", (req, res) => {
    const business = getBusiness(req.params.businessId);
    const data = contactInput(req.body);
    const id = randomUUID();
    transaction(db, () => {
      if (
        db
          .prepare(
            "SELECT 1 FROM phone_opt_outs WHERE business_id = ? AND phone = ?",
          )
          .get(business.id, data.phone)
      )
        data.opted_out = 1;
      db.prepare(
        `INSERT INTO contacts (id,business_id,name,phone,email,notes,tags,sms_consent,consent_at,opted_out,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        business.id,
        data.name,
        data.phone,
        data.email,
        data.notes,
        data.tags,
        data.sms_consent,
        data.sms_consent ? stamp() : null,
        data.opted_out,
        stamp(),
        stamp(),
      );
      if (data.opted_out)
        optOutPhone(business.id, data.phone, "Customer opted out of texts.");
      log({
        businessId: business.id,
        contactId: id,
        kind: "contact_created",
        label: "Customer added.",
      });
    });
    res.status(201).json(contactView(getContact(business.id, id)));
  });

  app.patch("/api/businesses/:businessId/contacts/:contactId", (req, res) => {
    getBusiness(req.params.businessId);
    const existing = getContact(req.params.businessId, req.params.contactId);
    const data = contactInput(req.body, contactView(existing));
    // Permission belongs to a number. Save a changed number first, then reconfirm.
    if (data.phone !== existing.phone) data.sms_consent = 0;
    if (existing.opted_out && req.body.opted_out === false)
      bad(
        "This customer must reply START to your business number to allow texts again.",
      );
    transaction(db, () => {
      if (
        db
          .prepare(
            "SELECT 1 FROM phone_opt_outs WHERE business_id = ? AND phone = ?",
          )
          .get(existing.business_id, data.phone)
      )
        data.opted_out = 1;
      db.prepare(
        `UPDATE contacts SET name=?,phone=?,email=?,notes=?,tags=?,sms_consent=?,consent_at=?,opted_out=?,updated_at=? WHERE business_id=? AND id=?`,
      ).run(
        data.name,
        data.phone,
        data.email,
        data.notes,
        data.tags,
        data.sms_consent,
        data.sms_consent ? existing.consent_at || stamp() : null,
        data.opted_out,
        stamp(),
        existing.business_id,
        existing.id,
      );
      if (data.opted_out)
        optOutPhone(
          existing.business_id,
          data.phone,
          "Customer opted out of texts.",
        );
      log({
        businessId: existing.business_id,
        contactId: existing.id,
        kind: "contact_updated",
        label: "Customer details updated.",
      });
    });
    res.json(contactView(getContact(existing.business_id, existing.id)));
  });

  app.get("/api/businesses/:businessId/requests", (req, res) => {
    getBusiness(req.params.businessId);
    res.json(
      db
        .prepare(
          `SELECT r.*, c.name AS contact_name, c.phone AS contact_phone, c.opted_out, c.sms_consent
      FROM review_requests r JOIN contacts c ON c.id = r.contact_id AND c.business_id = r.business_id
      WHERE r.business_id = ? ORDER BY r.sent_at DESC, r.rowid DESC`,
        )
        .all(req.params.businessId),
    );
  });

  app.post("/api/businesses/:businessId/requests/preview", (req, res) => {
    const business = getBusiness(req.params.businessId);
    const contact = getContact(business.id, String(req.body.contact_id || ""));
    res.json({ body: buildSms(business, contact), mode: smsMode });
  });

  app.post("/api/businesses/:businessId/requests", async (req, res) => {
    const business = getBusiness(req.params.businessId);
    const contact = getContact(business.id, String(req.body.contact_id || ""));
    const message = transaction(db, () => {
      validateCanSend(business, contact);
      if (
        db
          .prepare(
            "SELECT 1 FROM sms_messages WHERE business_id = ? AND contact_id = ? AND kind='initial' AND delivery_status IN ('sending','uncertain')",
          )
          .get(business.id, contact.id)
      ) {
        throw new AppError(
          409,
          "A previous text is still sending or could not be confirmed. Check the Twilio message log and have the administrator reconcile it before sending another.",
        );
      }
      if (
        db
          .prepare(
            "SELECT 1 FROM review_requests WHERE business_id = ? AND contact_id = ? AND status IN ('sent', 'nudged')",
          )
          .get(business.id, contact.id)
      ) {
        throw new AppError(
          409,
          "This customer already has an open review request. Mark it done before sending another.",
        );
      }
      return reserveMessage(business, contact, "initial");
    });
    let result;
    try {
      result = await deliver(business, message);
    } catch (error) {
      const failure = transaction(db, () =>
        recordFailure(business, message, error),
      );
      throw new AppError(502, failure.message);
    }
    const id = randomUUID();
    transaction(db, () => {
      const sentAt = stamp();
      const dueAt = new Date(Date.parse(sentAt) + THREE_DAYS).toISOString();
      db.prepare(
        `INSERT INTO review_requests (id,business_id,contact_id,status,mode,sent_at,nudge_due_at) VALUES (?,?,?,'sent',?,?,?)`,
      ).run(id, business.id, contact.id, smsMode, sentAt, dueAt);
      db.prepare(
        "UPDATE sms_messages SET request_id=?,delivery_status=?,provider_sid=?,updated_at=? WHERE business_id=? AND id=?",
      ).run(
        id,
        smsMode === "demo" ? "simulated" : "sent",
        result?.sid || null,
        stamp(),
        business.id,
        message.id,
      );
      log({
        businessId: business.id,
        contactId: contact.id,
        requestId: id,
        kind: "sms_sent",
        label:
          smsMode === "demo"
            ? "Review request simulated. No text was sent."
            : "Review request accepted by Twilio.",
        body: message.body,
        mode: smsMode,
      });
      log({
        businessId: business.id,
        contactId: contact.id,
        requestId: id,
        kind: "status_changed",
        label: "Review request marked sent.",
        mode: smsMode,
      });
    });
    res.status(201).json(getRequest(business.id, id));
  });

  app.post(
    "/api/businesses/:businessId/requests/:requestId/done",
    (req, res) => {
      getBusiness(req.params.businessId);
      const request = getRequest(req.params.businessId, req.params.requestId);
      transaction(db, () => {
        const changed = db
          .prepare(
            "UPDATE review_requests SET status='done',done_at=? WHERE business_id=? AND id=? AND status!='done'",
          )
          .run(stamp(), request.business_id, request.id);
        if (changed.changes)
          log({
            businessId: request.business_id,
            contactId: request.contact_id,
            requestId: request.id,
            kind: "status_changed",
            label: "Review request marked done. No more follow-ups.",
            mode: request.mode,
          });
      });
      res.json(getRequest(request.business_id, request.id));
    },
  );

  app.get("/api/businesses/:businessId/activity", (req, res) => {
    getBusiness(req.params.businessId);
    res.json(activities(req.params.businessId));
  });

  app.get("/api/businesses/:businessId/dashboard", (req, res) => {
    const business = getBusiness(req.params.businessId);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS total_requests,
      COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),0) AS completed FROM review_requests WHERE business_id=?`,
      )
      .get(business.id);
    const upcoming = db
      .prepare(
        `SELECT r.*, c.name AS contact_name, c.phone AS contact_phone
      FROM review_requests r JOIN contacts c ON c.id=r.contact_id AND c.business_id=r.business_id
      WHERE r.business_id=? AND r.mode=? AND r.status='sent' AND r.nudge_attempted_at IS NULL
        AND c.opted_out=0 AND c.sms_consent=1
        AND NOT EXISTS(SELECT 1 FROM phone_opt_outs p WHERE p.business_id=c.business_id AND p.phone=c.phone)
        AND EXISTS(SELECT 1 FROM sms_messages m WHERE m.business_id=r.business_id AND m.request_id=r.id AND m.kind='initial' AND m.to_phone=c.phone)
      ORDER BY r.nudge_due_at`,
      )
      .all(business.id, smsMode);
    res.json({
      ...totals,
      awaiting_nudge: upcoming.length,
      recent_activity: activities(business.id, 8),
      upcoming_nudges: upcoming.slice(0, 8),
    });
  });

  async function runNudges({ businessId } = {}) {
    const totals = { sent: 0, failed: 0, skipped: 0 };
    const due = db
      .prepare(
        `SELECT business_id,id FROM review_requests WHERE status='sent' AND mode=?
      AND nudge_attempted_at IS NULL AND nudge_due_at<=? AND (? IS NULL OR business_id=?) ORDER BY nudge_due_at LIMIT 100`,
      )
      .all(smsMode, stamp(), businessId || null, businessId || null);
    for (const candidate of due) {
      const claim = transaction(db, () => {
        const request = getRequest(candidate.business_id, candidate.id);
        if (
          request.status !== "sent" ||
          request.nudge_attempted_at ||
          request.mode !== smsMode ||
          request.nudge_due_at > stamp()
        )
          return null;
        const business = getBusiness(request.business_id);
        const contact = getContact(request.business_id, request.contact_id);
        const originalMessage = db
          .prepare(
            "SELECT to_phone FROM sms_messages WHERE business_id=? AND request_id=? AND kind='initial' LIMIT 1",
          )
          .get(business.id, request.id);
        if (
          !originalMessage ||
          originalMessage.to_phone !== contact.phone ||
          isBlocked(business.id, contact) ||
          !contact.sms_consent
        ) {
          db.prepare(
            "UPDATE review_requests SET nudge_attempted_at=?,nudge_error=? WHERE business_id=? AND id=?",
          ).run(
            stamp(),
            "Follow-up stopped because the customer phone or text permission changed.",
            request.business_id,
            request.id,
          );
          log({
            businessId: business.id,
            contactId: contact.id,
            requestId: request.id,
            kind: "nudge_skipped",
            label:
              "Follow-up stopped. The customer phone or text permission changed.",
            mode: smsMode,
          });
          return null;
        }
        // Missing configuration is safe to fix: no provider call has been made.
        if (
          !business.google_review_url ||
          (smsMode === "twilio" && !credentialsReady(business))
        )
          return null;
        const changed = db
          .prepare(
            "UPDATE review_requests SET nudge_attempted_at=? WHERE business_id=? AND id=? AND status='sent' AND nudge_attempted_at IS NULL",
          )
          .run(stamp(), request.business_id, request.id);
        if (!changed.changes) return null;
        return {
          business,
          request,
          message: reserveMessage(business, contact, "nudge", request.id),
        };
      });
      if (!claim) {
        totals.skipped++;
        continue;
      }
      const { business, request, message } = claim;
      let result;
      try {
        result = await deliver(business, message);
      } catch (error) {
        transaction(db, () => {
          const failure = recordFailure(business, message, error, request.id);
          db.prepare(
            "UPDATE review_requests SET nudge_error=? WHERE business_id=? AND id=?",
          ).run(failure.message, business.id, request.id);
        });
        totals.failed++;
        continue;
      }
      transaction(db, () => {
        db.prepare(
          "UPDATE sms_messages SET delivery_status=?,provider_sid=?,updated_at=? WHERE business_id=? AND id=?",
        ).run(
          smsMode === "demo" ? "simulated" : "sent",
          result?.sid || null,
          stamp(),
          business.id,
          message.id,
        );
        const changed = db
          .prepare(
            "UPDATE review_requests SET status='nudged',nudged_at=? WHERE business_id=? AND id=? AND status='sent'",
          )
          .run(stamp(), business.id, request.id);
        log({
          businessId: business.id,
          contactId: request.contact_id,
          requestId: request.id,
          kind: "sms_sent",
          label:
            smsMode === "demo"
              ? "One follow-up simulated. No text was sent."
              : "One follow-up accepted by Twilio.",
          body: message.body,
          mode: smsMode,
        });
        if (changed.changes)
          log({
            businessId: business.id,
            contactId: request.contact_id,
            requestId: request.id,
            kind: "status_changed",
            label: "Review request marked nudged. No more follow-ups.",
            mode: smsMode,
          });
      });
      totals.sent++;
    }
    return totals;
  }

  app.post("/api/businesses/:businessId/demo/advance", async (req, res) => {
    if (smsMode !== "demo")
      throw new AppError(
        404,
        "The follow-up test is available only in demo mode.",
      );
    const business = getBusiness(req.params.businessId);
    const days = req.body.days ?? 3;
    if (days !== 3)
      bad("This test advances pending follow-ups by exactly 3 days.");
    transaction(db, () => {
      const pending = db
        .prepare(
          "SELECT id,nudge_due_at FROM review_requests WHERE business_id=? AND mode='demo' AND status='sent' AND nudge_attempted_at IS NULL",
        )
        .all(business.id);
      const update = db.prepare(
        "UPDATE review_requests SET nudge_due_at=? WHERE business_id=? AND id=?",
      );
      for (const request of pending)
        update.run(
          new Date(Date.parse(request.nudge_due_at) - THREE_DAYS).toISOString(),
          business.id,
          request.id,
        );
      log({
        businessId: business.id,
        kind: "demo_advanced",
        label: "Demo only: moved pending follow-ups forward by 3 days.",
        mode: "demo",
      });
    });
    res.json(await runNudges({ businessId: business.id }));
  });

  app.use(
    "/uploads",
    express.static(uploadPath, {
      dotfiles: "deny",
      index: false,
      fallthrough: false,
      maxAge: "1d",
    }),
  );
  app.use(express.static(resolve(ROOT, "public"), { index: "index.html" }));
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "That action was not found." }),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError)
      return res
        .status(400)
        .json({
          error:
            error.code === "LIMIT_FILE_SIZE"
              ? "Choose a logo smaller than 2 MB."
              : "Upload one logo image at a time.",
        });
    if (error instanceof AppError)
      return res.status(error.status).json({ error: error.message });
    if (error?.type === "entity.parse.failed")
      return res
        .status(400)
        .json({ error: "The request contains invalid JSON." });
    if (error?.type === "entity.too.large")
      return res.status(413).json({ error: "This request is too large." });
    if (String(error?.code || "").startsWith("SQLITE_CONSTRAINT"))
      return res
        .status(409)
        .json({
          error:
            "This change conflicts with an existing record. Refresh and try again.",
        });
    // Do not log the request, exception, message body, or provider account details.
    res
      .status(500)
      .json({ error: "Something went wrong. Refresh and try again." });
  });

  return { app, db, runNudges, close: () => db.close() };
}
