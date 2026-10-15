import twilio from "twilio";

export const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

export function credentialsFor(business) {
  const prefix = `BUSINESS_${business.sms_key}_`;
  return {
    accountSid: process.env[`${prefix}ACCOUNT_SID`] || "",
    authToken: process.env[`${prefix}AUTH_TOKEN`] || "",
    from: process.env[`${prefix}PHONE_NUMBER`] || "",
  };
}

export function credentialsReady(business) {
  const credentials = credentialsFor(business);
  return (
    /^AC[0-9a-f]{32}$/i.test(credentials.accountSid) &&
    Boolean(credentials.authToken) &&
    PHONE_PATTERN.test(credentials.from)
  );
}

export function buildSms(business, contact, kind = "initial", details = {}) {
  const greeting = `Hi ${contact.name.split(/\s+/)[0]},`;
  if (kind === "quote" || kind === "quote_nudge") {
    const message = kind === "quote"
      ? `${greeting} your quote${details.reference ? ` ${details.reference}` : ""} from ${business.name} is ready. View it and accept or decline here: ${details.url}`
      : `${greeting} a friendly reminder about your quote from ${business.name}. You can view it and let us know here: ${details.url}`;
    return withSmsFooter(business, message);
  }
  const message =
    kind === "nudge"
      ? `${greeting} just one friendly reminder. If you have a moment, we'd love your feedback: ${business.google_review_url}`
      : `${greeting} thanks for choosing ${business.name}! Would you share your experience on Google? ${business.google_review_url}`;
  return withSmsFooter(business, message);
}

function withSmsFooter(business, message) {
  return `${message}\n\n${business.name}\nReply STOP to opt out`;
}

export async function twilioTransport({
  accountSid,
  authToken,
  from,
  to,
  body,
}) {
  const client = twilio(accountSid, authToken, {
    autoRetry: false,
    timeout: 15000,
    logLevel: "silent",
  });
  return client.messages.create({ from, to, body });
}

// Never include an upstream exception message: it may contain account details.
export function safeFailure(error) {
  const code = Number.isInteger(Number(error?.code))
    ? Number(error.code)
    : null;
  const status = Number(error?.status);
  const uncertain =
    !Number.isInteger(status) || status >= 500 || status === 429;
  if (code === 21610)
    return {
      code,
      uncertain: false,
      message:
        "This customer has opted out of texts. No more messages will be sent.",
    };
  if (status === 401 || status === 403)
    return {
      code,
      uncertain: false,
      message:
        "Twilio could not authorize this business. Check its SMS settings in the .env file.",
    };
  return {
    code,
    uncertain,
    message: uncertain
      ? "Twilio did not confirm this message. Check the Twilio message log before trying again; it may have been sent."
      : "Twilio could not send this message. Check this business phone number and Twilio account settings.",
  };
}
