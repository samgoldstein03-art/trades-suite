import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { checkBusiness, readBusinesses } from "../scripts/check-twilio.js";

const ORIGIN = "https://trades.example.test";
const BUSINESS = { id: "business-alpha", sms_key: "ALPHA" };
const CREDENTIALS = {
  accountSid: `AC${"1".repeat(32)}`,
  authToken: "synthetic-never-print-token",
  from: "+14165550101",
};

function configure(t, business = BUSINESS, credentials = CREDENTIALS) {
  for (const [suffix, value] of Object.entries({
    ACCOUNT_SID: credentials.accountSid,
    AUTH_TOKEN: credentials.authToken,
    PHONE_NUMBER: credentials.from,
  })) {
    const key = `BUSINESS_${business.sms_key}_${suffix}`;
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function incomingNumber(business = BUSINESS, credentials = CREDENTIALS) {
  return {
    accountSid: credentials.accountSid,
    phoneNumber: credentials.from,
    capabilities: { sms: true },
    smsUrl: `${ORIGIN}/webhooks/twilio/${business.id}`,
    smsMethod: "POST",
    smsApplicationSid: null,
  };
}

function provider(result, calls = []) {
  return (accountSid, authToken, options) => {
    calls.push({ accountSid, authToken, options });
    // Deliberately expose only the one read method the checker may use.
    return { incomingPhoneNumbers: { list: async (query) => {
      calls.push({ query });
      return result;
    } } };
  };
}

test("each business is checked with its own credentials through a read-only provider call", async (t) => {
  const second = { id: "business-beta", sms_key: "BETA" };
  const secondCredentials = { accountSid: `AC${"2".repeat(32)}`, authToken: "synthetic-beta-token", from: "+14165550102" };
  configure(t);
  configure(t, second, secondCredentials);
  for (const [business, credentials] of [[BUSINESS, CREDENTIALS], [second, secondCredentials]]) {
    const calls = [];
    const result = await checkBusiness(business, { baseUrl: ORIGIN, clientFactory: provider([incomingNumber(business, credentials)], calls) });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { accountSid: credentials.accountSid, authToken: credentials.authToken, options: { autoRetry: false, timeout: 15000, logLevel: "silent" } });
    assert.deepEqual(calls[1], { query: { phoneNumber: credentials.from, limit: 20 } });
    const output = JSON.stringify(result);
    for (const secret of Object.values(credentials)) assert.equal(output.includes(secret), false);
  }
});

test("missing credentials and malformed public origins produce safe guidance without a provider call", async (t) => {
  configure(t, BUSINESS, {});
  const result = await checkBusiness(BUSINESS, {
    baseUrl: "https://user:private-password@example.test/path?secret=true",
    clientFactory: () => assert.fail("No provider call is allowed with missing credentials"),
  });
  assert.equal(result.ok, false);
  const output = JSON.stringify(result);
  assert.match(output, /BUSINESS_ALPHA_AUTH_TOKEN/);
  assert.match(output, /HTTPS origin/);
  assert.doesNotMatch(output, /private-password|secret=true/);
});

test("number must belong to the selected account and match the exact configured phone", async (t) => {
  configure(t);
  for (const wrong of [
    { ...incomingNumber(), accountSid: `AC${"2".repeat(32)}` },
    { ...incomingNumber(), phoneNumber: "+14165550102" },
  ]) {
    const result = await checkBusiness(BUSINESS, { baseUrl: ORIGIN, clientFactory: provider([wrong]) });
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /not found in this business/);
  }
});

test("missing SMS support and wrong webhook method or business are actionable failures", async (t) => {
  configure(t);
  for (const wrong of [
    { ...incomingNumber(), capabilities: { sms: false } },
    { ...incomingNumber(), smsMethod: "GET" },
    { ...incomingNumber(), smsUrl: `${ORIGIN}/webhooks/twilio/another-business` },
    { ...incomingNumber(), smsApplicationSid: "AP-synthetic-override" },
  ]) {
    const result = await checkBusiness(BUSINESS, { baseUrl: ORIGIN, clientFactory: provider([wrong]) });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => !check.ok));
  }
});

test("provider exceptions reveal only an allowed numeric error code", async (t) => {
  configure(t);
  for (const code of [20003, CREDENTIALS.authToken]) {
    const result = await checkBusiness(BUSINESS, { baseUrl: ORIGIN, clientFactory: () => ({ incomingPhoneNumbers: { list: async () => {
      throw Object.assign(new Error(`SECRET ${CREDENTIALS.authToken} ${CREDENTIALS.accountSid}`), { code, response: { authToken: CREDENTIALS.authToken } });
    } } }) });
    assert.equal(result.ok, false);
    const output = JSON.stringify(result);
    assert.doesNotMatch(output, /SECRET|synthetic-never-print-token/);
    assert.equal(output.includes(CREDENTIALS.accountSid), false);
    if (code === 20003) assert.match(output, /Twilio code 20003/);
  }
});

test("read-only database lookup selects businesses without creating or changing a database", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "trades-twilio-check-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const dbPath = join(folder, "suite.sqlite");
  assert.throws(() => readBusinesses(dbPath));
  assert.equal(existsSync(dbPath), false);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE businesses (id TEXT PRIMARY KEY, sms_key TEXT UNIQUE)");
  db.prepare("INSERT INTO businesses VALUES (?, ?)").run(BUSINESS.id, BUSINESS.sms_key);
  db.prepare("INSERT INTO businesses VALUES (?, ?)").run("business-beta", "BETA");
  db.close();
  const before = readFileSync(dbPath);
  assert.equal(readBusinesses(dbPath).length, 2);
  assert.deepEqual(readBusinesses(dbPath, "ALPHA").map((row) => ({ ...row })), [BUSINESS]);
  assert.deepEqual(readBusinesses(dbPath, "MISSING"), []);
  assert.deepEqual(readFileSync(dbPath), before);
});
