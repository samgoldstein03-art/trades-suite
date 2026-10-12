import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openDatabase(dbPath) {
  if (dbPath !== ":memory:")
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      booking_url TEXT NOT NULL DEFAULT '',
      google_review_url TEXT NOT NULL DEFAULT '',
      sms_key TEXT NOT NULL UNIQUE,
      logo_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '["customer"]',
      sms_consent INTEGER NOT NULL DEFAULT 0,
      consent_at TEXT,
      opted_out INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (business_id, id)
    );
    CREATE INDEX IF NOT EXISTS contacts_business ON contacts(business_id, name);
    CREATE INDEX IF NOT EXISTS contacts_phone ON contacts(business_id, phone);
    CREATE TABLE IF NOT EXISTS phone_opt_outs (
      business_id TEXT NOT NULL REFERENCES businesses(id),
      phone TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (business_id, phone)
    );
    CREATE TABLE IF NOT EXISTS review_requests (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      contact_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent', 'nudged', 'done')),
      mode TEXT NOT NULL CHECK (mode IN ('demo', 'twilio')),
      sent_at TEXT NOT NULL,
      nudge_due_at TEXT NOT NULL,
      nudge_attempted_at TEXT,
      nudge_error TEXT,
      nudged_at TEXT,
      done_at TEXT,
      UNIQUE (business_id, id),
      FOREIGN KEY (business_id, contact_id) REFERENCES contacts(business_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_request_per_contact
      ON review_requests(business_id, contact_id) WHERE status IN ('sent', 'nudged');
    CREATE INDEX IF NOT EXISTS requests_due ON review_requests(mode, status, nudge_due_at);
    CREATE TABLE IF NOT EXISTS sms_messages (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      contact_id TEXT NOT NULL,
      request_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('initial', 'nudge')),
      mode TEXT NOT NULL CHECK (mode IN ('demo', 'twilio')),
      body TEXT NOT NULL,
      to_phone TEXT NOT NULL,
      provider_sid TEXT,
      delivery_status TEXT NOT NULL CHECK (delivery_status IN ('sending', 'sent', 'simulated', 'failed', 'uncertain')),
      error_code INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (business_id, contact_id) REFERENCES contacts(business_id, id),
      FOREIGN KEY (business_id, request_id) REFERENCES review_requests(business_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_initial_per_contact
      ON sms_messages(business_id, contact_id) WHERE kind = 'initial' AND delivery_status = 'sending';
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      contact_id TEXT,
      request_id TEXT,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      body TEXT,
      mode TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (business_id, contact_id) REFERENCES contacts(business_id, id),
      FOREIGN KEY (business_id, request_id) REFERENCES review_requests(business_id, id)
    );
    CREATE INDEX IF NOT EXISTS activity_business ON activity(business_id, created_at DESC);
    PRAGMA user_version = 1;
  `);
  return db;
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
