import nodemailer from "nodemailer";

const HEADER_CONTROLS = /[\u0000-\u001f\u007f]/;
const EMAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const SMTP_HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

export function validEmailAddress(value) {
  return typeof value === "string" && value.length <= 254 &&
    !HEADER_CONTROLS.test(value) && EMAIL_ADDRESS.test(value);
}

function emailConfiguration(business) {
  if (!/^[A-Z][A-Z0-9_]{0,49}$/.test(business?.sms_key || "")) return null;
  const prefix = `BUSINESS_${business.sms_key}_SMTP_`;
  const host = process.env[`${prefix}HOST`] || "";
  const port = Number(process.env[`${prefix}PORT`] || "587");
  const user = process.env[`${prefix}USER`] || "";
  const password = process.env[`${prefix}PASSWORD`] || "";
  const from = process.env[`${prefix}FROM`] || "";
  if (!SMTP_HOST.test(host) || ![465, 587].includes(port) ||
      !user || !password || HEADER_CONTROLS.test(user) ||
      HEADER_CONTROLS.test(password) || !validEmailAddress(from)) return null;
  return { host, port, user, password, from };
}

export function emailReady(business) {
  return Boolean(emailConfiguration(business));
}

function localFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

function unsubscribeLink(value, allowHttp = false) {
  if (typeof value !== "string" || value.length > 2048 ||
      /[\s<>]/.test(value) || HEADER_CONTROLS.test(value)) {
    throw localFailure("EEMAILINPUT", "Email details are invalid.");
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw localFailure("EEMAILINPUT", "Email details are invalid.");
  }
  const localDemoHttp = allowHttp && parsed.protocol === "http:" &&
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname);
  if ((parsed.protocol !== "https:" && !localDemoHttp) || !parsed.hostname || parsed.username ||
      parsed.password || parsed.hash || /%0[ad]/i.test(value)) {
    throw localFailure("EEMAILINPUT", "Email details are invalid.");
  }
  return parsed.href;
}

function quoteEmailFooter(businessName, unsubscribeUrl, allowHttp = false) {
  if (typeof businessName !== "string" || !businessName.trim() || HEADER_CONTROLS.test(businessName)) {
    throw localFailure("EEMAILINPUT", "Email details are invalid.");
  }
  return `Stop quote emails and texts from ${businessName}: ${unsubscribeLink(unsubscribeUrl, allowHttp)}`;
}

// Keep the stored Activity message identical to the email delivered by SMTP.
export function buildQuoteEmailText({ businessName, customerName, url, unsubscribeUrl, allowHttp = false, kind = "quote" }) {
  if (typeof customerName !== "string" || !customerName.trim() ||
      HEADER_CONTROLS.test(customerName) || typeof url !== "string" || !url ||
      HEADER_CONTROLS.test(url)) {
    throw localFailure("EEMAILINPUT", "Email details are invalid.");
  }
  const message = kind === "quote_nudge"
    ? `Just checking in on your quote from ${businessName}. You can view it and accept or decline here:`
    : `Your quote from ${businessName} is ready. View it and accept or decline here:`;
  return `Hi ${customerName.trim().split(/\s+/)[0]},\n\n${message}\n${url}\n\n${businessName}\n\n${quoteEmailFooter(businessName, unsubscribeUrl, allowHttp)}`;
}

// The optional factory is for tests. SMTP settings are always server-side env.
export async function emailTransport({
  business,
  to,
  subject,
  text,
  unsubscribeUrl,
  createTransport = nodemailer.createTransport,
}) {
  const config = emailConfiguration(business);
  if (!config) throw localFailure("EEMAILCONFIG", "Email settings are incomplete.");
  if (!validEmailAddress(to) || typeof subject !== "string" || !subject ||
      subject.length > 200 || HEADER_CONTROLS.test(subject) ||
      typeof text !== "string" || !text || text.length > 100000 ||
      typeof business.name !== "string" || HEADER_CONTROLS.test(business.name)) {
    throw localFailure("EEMAILINPUT", "Email details are invalid.");
  }
  const unsubscribe = unsubscribeLink(unsubscribeUrl);
  const footer = quoteEmailFooter(business.name, unsubscribe);
  const body = text.endsWith(footer) ? text : `${text}\n\n${footer}`;
  if (body.length > 100000) throw localFailure("EEMAILINPUT", "Email details are invalid.");
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port === 587,
    opportunisticTLS: false,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: config.host },
    auth: { user: config.user, pass: config.password },
    pool: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
    dnsTimeout: 15000,
    logger: false,
    debug: false,
    transactionLog: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    maxRecipients: 1,
  });
  try {
    const result = await transport.sendMail({
      from: { name: business.name, address: config.from },
      to,
      subject,
      text: body,
      headers: {
        "List-Unsubscribe": `<${unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      envelope: { from: config.from, to: [to] },
    });
    const accepted = result?.accepted?.some((address) =>
      typeof address === "string" && address.toLowerCase() === to.toLowerCase());
    if (!accepted) {
      const failure = localFailure("EEMAILREJECTED", "The email provider rejected this recipient.");
      const rejected = result?.rejected?.some((address) =>
        typeof address === "string" && address.toLowerCase() === to.toLowerCase());
      // Nodemailer normally throws SMTP rejection errors. Preserve the same
      // distinction for transports that instead return rejected recipient data.
      const recipientErrors = (Array.isArray(result?.rejectedErrors) ? result.rejectedErrors : []).filter((error) =>
        !error.recipient || String(error.recipient).toLowerCase() === to.toLowerCase());
      failure.bounced = Boolean(rejected) && (recipientErrors.length === 0 ||
        recipientErrors.every(permanentRecipientRejection));
      throw failure;
    }
    return { messageId: result.messageId || null, accepted: [to] };
  } finally {
    transport.close?.();
  }
}

function permanentRecipientRejection(error) {
  const command = typeof error?.command === "string" ? error.command.trim().toUpperCase() : "";
  return command === "RCPT TO" && [550, 551, 552, 553, 554].includes(Number(error?.responseCode));
}

// Do not copy upstream messages or SMTP responses: they can contain secrets.
export function safeEmailFailure(error) {
  const code = error?.code;
  if (code === "EEMAILCONFIG" || code === "EAUTH") {
    return { uncertain: false, bounced: false, message: "Email could not sign in for this business. Check its email settings on the server." };
  }
  if (code === "EEMAILINPUT") {
    return { uncertain: false, bounced: false, message: "Check the customer's email address and this business's email settings." };
  }
  const responseCode = Number(error?.responseCode);
  const uncertain = code !== "EEMAILREJECTED" &&
    !(Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599);
  return {
    uncertain,
    bounced: code === "EEMAILREJECTED"
      ? error.bounced !== false && !(responseCode >= 400 && responseCode < 500)
      : permanentRecipientRejection(error),
    message: uncertain
      ? "The email provider did not confirm this message. Check its sent-message log before trying again; it may have been sent."
      : "The email provider could not send this message. Check the customer's email address and this business's email settings.",
  };
}
