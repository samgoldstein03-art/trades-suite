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
  // Additive, repeatable Phase 2 migration. Existing customers and activity stay
  // in their original tables; composite keys prevent cross-business links.
  db.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      business_id TEXT NOT NULL REFERENCES businesses(id),
      id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','viewed','accepted','declined','expired')),
      line_items TEXT NOT NULL,
      tax_rate REAL NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      tax_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CAD',
      expiry_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      public_token TEXT NOT NULL UNIQUE,
      snapshot_json TEXT,
      public_url TEXT,
      mode TEXT NOT NULL CHECK(mode IN ('demo','twilio')),
      sent_at TEXT,
      viewed_at TEXT,
      responded_at TEXT,
      follow_ups_cancelled_at TEXT,
      follow_up_phone TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(business_id,id),
      FOREIGN KEY(business_id,contact_id) REFERENCES contacts(business_id,id)
    );
    CREATE INDEX IF NOT EXISTS quotes_status ON quotes(business_id,status,sent_at);
    CREATE TABLE IF NOT EXISTS quote_deliveries (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      quote_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('sms','email')),
      kind TEXT NOT NULL CHECK(kind IN ('initial','nudge_2','nudge_5')),
      status TEXT NOT NULL CHECK(status IN ('sending','sent','simulated','failed','uncertain','skipped')),
      recipient TEXT,
      body TEXT,
      provider_sid TEXT,
      error_code INTEGER,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(business_id,quote_id,channel,kind),
      FOREIGN KEY(business_id,quote_id) REFERENCES quotes(business_id,id)
    );
  `);
  if (!db.prepare("PRAGMA table_info(activity)").all().some((column) => column.name === "quote_id"))
    db.exec("ALTER TABLE activity ADD COLUMN quote_id TEXT");
  if (!db.prepare("PRAGMA table_info(contacts)").all().some((column) => column.name === "quote_email_opted_out"))
    db.exec("ALTER TABLE contacts ADD COLUMN quote_email_opted_out INTEGER NOT NULL DEFAULT 0 CHECK(quote_email_opted_out IN (0,1))");
  if (!db.prepare("PRAGMA table_info(quote_deliveries)").all().some((column) => column.name === "unsubscribe_url"))
    db.exec("ALTER TABLE quote_deliveries ADD COLUMN unsubscribe_url TEXT");
  // Capabilities are scoped to a contact, independent of any quote's lifetime.
  // Store only their hashes; old email links continue to work after expiry.
  db.exec(`CREATE TABLE IF NOT EXISTS contact_unsubscribe_links (
    token_hash TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(business_id,contact_id) REFERENCES contacts(business_id,id)
  ); PRAGMA user_version = 3;`);
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
