import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";
import twilio from "twilio";
import { credentialsFor, credentialsReady } from "../src/sms.js";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,49}$/;

function publicOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Only report a numeric provider error code, never an upstream error or response.
function providerFailure(error) {
  const code = String(error?.code ?? "");
  const suffix = /^\d{4,6}$/.test(code) ? ` (Twilio code ${code})` : "";
  return `Could not verify this account${suffix}. Check this business's credentials and network connection, then run this check again.`;
}

export async function checkBusiness(business, {
  clientFactory = twilio,
  baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "",
} = {}) {
  const smsKey = KEY_PATTERN.test(business.sms_key) ? business.sms_key : "BUSINESS";
  const checks = [];
  const add = (ok, message) => checks.push({ ok, message });
  const origin = publicOrigin(baseUrl);
  const expectedWebhook = origin ? `${origin}/webhooks/twilio/${encodeURIComponent(business.id)}` : null;
  if (!origin) add(false, "Set PUBLIC_BASE_URL (or RENDER_EXTERNAL_URL) to the app's HTTPS origin, with no path, query, or password.");
  if (!credentialsReady(business)) {
    add(false, `Set BUSINESS_${smsKey}_ACCOUNT_SID, BUSINESS_${smsKey}_AUTH_TOKEN, and BUSINESS_${smsKey}_PHONE_NUMBER in the private environment. The phone number must include + and the country code.`);
    return { smsKey, ok: false, checks };
  }

  const { accountSid, authToken, from } = credentialsFor(business);
  try {
    const client = clientFactory(accountSid, authToken, {
      autoRetry: false,
      timeout: 15000,
      logLevel: "silent",
    });
    // GET only: never send a text, buy a number, or change account settings.
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: from, limit: 20 });
    const number = numbers.find((item) => item.phoneNumber === from && item.accountSid === accountSid);
    if (!number) {
      add(false, "The configured phone number was not found in this business's Twilio account. Check its PHONE_NUMBER and ACCOUNT_SID settings.");
    } else {
      add(true, "The credentials work and the configured phone number belongs to this account.");
      add(number.capabilities?.sms === true || number.capabilities?.SMS === true,
        number.capabilities?.sms === true || number.capabilities?.SMS === true
          ? "The phone number supports SMS."
          : "This phone number does not report SMS support. Choose an SMS-capable number in Twilio.");
      if (number.smsApplicationSid) {
        add(false, "A TwiML application overrides this number's incoming-message settings. This checker covers direct number webhooks; confirm that application's STOP/START route manually.");
      } else if (expectedWebhook) {
        const webhookMatches = number.smsUrl === expectedWebhook && number.smsMethod === "POST";
        add(webhookMatches, webhookMatches
          ? "The incoming-message webhook uses POST and points to this business."
          : `In Twilio's phone number settings, set 'A message comes in' to Webhook, POST: ${expectedWebhook}`);
      }
    }
  } catch (error) {
    add(false, providerFailure(error));
  }
  return { smsKey, ok: checks.every((check) => check.ok), checks };
}

export function readBusinesses(dbPath, smsKey) {
  // Read-only mode must fail for a missing database instead of creating one.
  if (!existsSync(dbPath)) throw new Error("DATABASE_UNAVAILABLE");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return smsKey
      ? db.prepare("SELECT id, sms_key FROM businesses WHERE sms_key = ?").all(smsKey)
      : db.prepare("SELECT id, sms_key FROM businesses ORDER BY sms_key").all();
  } finally {
    db.close();
  }
}

export async function main({
  args = process.argv.slice(2),
  log = console.log,
  clientFactory = twilio,
} = {}) {
  dotenv.config({ quiet: true });
  if (args.length > 1 || (args.length === 1 && !/^--business=[A-Z][A-Z0-9_]{0,49}$/.test(args[0]))) {
    log("Usage: node scripts/check-twilio.js [--business=SMS_KEY]");
    return 1;
  }
  const smsKey = args[0]?.slice("--business=".length);
  let businesses;
  try {
    businesses = readBusinesses(process.env.DATABASE_PATH || "data/suite.sqlite", smsKey);
  } catch {
    log("Could not read the existing business database. Run the app, add a business, and check DATABASE_PATH. No database was created or changed.");
    return 1;
  }
  if (!businesses.length) {
    log(smsKey ? "No business has that SMS key. Check its Business settings in the app." : "Add a business in the app before checking its Twilio setup.");
    return 1;
  }
  log("Read-only Twilio setup check. No texts will be sent and no settings will be changed.");
  let passed = true;
  for (const business of businesses) {
    const result = await checkBusiness(business, { clientFactory });
    passed &&= result.ok;
    log(`${result.smsKey}: ${result.ok ? "setup checks passed" : "needs attention"}`);
    for (const check of result.checks) log(`  ${check.ok ? "OK" : "FIX"}: ${check.message}`);
  }
  log("This checks direct phone-number webhooks only. Messaging Service routing needs a separate check. Delivery and STOP/START handling still need a real test with an opted-in phone.");
  return passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch {
    console.error("The setup check could not finish. Check the local configuration and try again. No texts were sent.");
    process.exitCode = 1;
  }
}
