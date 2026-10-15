import assert from "node:assert/strict";
import test from "node:test";
import { emailReady, emailTransport, safeEmailFailure } from "../src/email.js";

const BUSINESS = { id: "business-alpha", name: "Alpha Plumbing", sms_key: "ALPHA" };
const RECIPIENT = "customer@example.test";
const SETTINGS = { HOST: "smtp.example.test", PORT: "587", USER: "alpha-user", PASSWORD: "synthetic-alpha-secret", FROM: "quotes@alpha.example.test" };

function configure(t, business = BUSINESS, overrides = {}) {
  for (const [suffix, value] of Object.entries({ ...SETTINGS, ...overrides })) {
    const key = `BUSINESS_${business.sms_key}_SMTP_${suffix}`;
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function message(overrides = {}) {
  return { business: BUSINESS, to: RECIPIENT, subject: "Your quote from Alpha Plumbing", text: "Your quote is ready: https://quotes.example.test/q/synthetic-link", ...overrides };
}

test("email uses each business's SMTP settings and requires verified TLS", async (t) => {
  const second = { id: "business-beta", name: "Beta Electric", sms_key: "BETA" };
  configure(t);
  configure(t, second, { PORT: "465", USER: "beta-user", PASSWORD: "synthetic-beta-secret", FROM: "quotes@beta.example.test" });
  for (const [business, port, user, from] of [[BUSINESS, 587, "alpha-user", SETTINGS.FROM], [second, 465, "beta-user", "quotes@beta.example.test"]]) {
    let closed = 0;
    let sends = 0;
    assert.equal(emailReady(business), true);
    const result = await emailTransport(message({ business, createTransport(options) {
      assert.equal(options.port, port);
      assert.equal(options.auth.user, user);
      assert.equal(options.secure, port === 465);
      assert.equal(options.requireTLS, port === 587);
      assert.equal(options.opportunisticTLS, false);
      assert.deepEqual(options.tls, { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: SETTINGS.HOST });
      for (const option of ["connectionTimeout", "greetingTimeout", "socketTimeout", "dnsTimeout"]) assert.equal(options[option], 15000);
      for (const option of ["pool", "logger", "debug", "transactionLog"]) assert.equal(options[option], false);
      assert.equal(options.disableFileAccess, true);
      assert.equal(options.disableUrlAccess, true);
      assert.equal(options.maxRecipients, 1);
      return { async sendMail(payload) {
        sends++;
        assert.deepEqual(payload.from, { name: business.name, address: from });
        assert.deepEqual(payload.envelope, { from, to: [RECIPIENT] });
        assert.equal(payload.to, RECIPIENT);
        assert.equal(payload.html, undefined);
        return { accepted: [RECIPIENT], messageId: "synthetic-id", response: "not returned to caller" };
      }, close() { closed++; } };
    } }));
    assert.equal(sends, 1);
    assert.equal(closed, 1);
    assert.deepEqual(result, { messageId: "synthetic-id", accepted: [RECIPIENT] });
  }
});

test("missing settings and invalid sender addresses fail before opening a connection", async (t) => {
  for (const overrides of [{ PASSWORD: "" }, { PORT: "25" }, { HOST: "smtp.example.test/path" }, { FROM: "quotes@example.test\r\nBcc: hidden@example.test" }, { FROM: "one@example.test,two@example.test" }]) {
    await t.test(JSON.stringify(Object.keys(overrides)), async (child) => {
      configure(child, BUSINESS, overrides);
      assert.equal(emailReady(BUSINESS), false);
      await assert.rejects(emailTransport(message({ createTransport() { assert.fail("Do not connect with invalid settings"); } })), { code: "EEMAILCONFIG" });
    });
  }
});

test("email header injection and multiple recipients are rejected before a provider call", async (t) => {
  configure(t);
  for (const overrides of [{ to: "one@example.test,two@example.test" }, { to: "customer@example.test\r\nBcc: hidden@example.test" }, { subject: "Quote\r\nBcc: hidden@example.test" }, { business: { ...BUSINESS, name: "Shop\nBcc: hidden@example.test" } }]) {
    await assert.rejects(emailTransport(message({ ...overrides, createTransport() { assert.fail("Do not connect with invalid headers"); } })), { code: "EEMAILINPUT" });
  }
});

test("a rejected recipient cannot become a successful email send", async (t) => {
  configure(t);
  let closed = false;
  await assert.rejects(emailTransport(message({ createTransport() {
    return { async sendMail() { return { accepted: [], rejected: [RECIPIENT] }; }, close() { closed = true; } };
  } })), { code: "EEMAILREJECTED" });
  assert.equal(closed, true);
});

test("a timeout is not retried and uncertain failure guidance excludes provider details", async (t) => {
  configure(t);
  let attempts = 0;
  let closed = false;
  const error = Object.assign(new Error("synthetic-private-password smtp trace"), { code: "ETIMEDOUT" });
  await assert.rejects(emailTransport(message({ createTransport() {
    return { async sendMail() { attempts++; throw error; }, close() { closed = true; } };
  } })), error);
  assert.equal(attempts, 1);
  assert.equal(closed, true);
  for (const upstream of [error, { code: "EAUTH", response: error.message }, { responseCode: 550, response: error.message }, { code: "EEMAILREJECTED" }]) {
    const safe = safeEmailFailure(upstream);
    assert.equal(JSON.stringify(safe).includes("synthetic-private-password"), false);
    assert.equal(safe.uncertain, upstream === error);
  }
});
