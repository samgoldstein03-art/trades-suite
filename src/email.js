import nodemailer from "nodemailer";

const HEADER_CONTROLS = /[\u0000-\u001f\u007f]/;
const EMAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const SMTP_HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function validAddress(value) {
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
      HEADER_CONTROLS.test(password) || !validAddress(from)) return null;
  return { host, port, user, password, from };
}

export function emailReady(business) {
  return Boolean(emailConfiguration(business));
}

function localFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

// The optional factory is for tests. SMTP settings are always server-side env.
export async function emailTransport({
  business,
  to,
  subject,
  text,
  createTransport = nodemailer.createTransport,
}) {
  const config = emailConfiguration(business);
  if (!config) throw localFailure("EEMAILCONFIG", "Email settings are incomplete.");
  if (!validAddress(to) || typeof subject !== "string" || !subject ||
      subject.length > 200 || HEADER_CONTROLS.test(subject) ||
      typeof text !== "string" || !text || text.length > 100000 ||
      typeof business.name !== "string" || HEADER_CONTROLS.test(business.name)) {
    throw localFailure("EEMAILINPUT", "Email details are invalid.");
  }
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
      text,
      envelope: { from: config.from, to: [to] },
    });
    const accepted = result?.accepted?.some((address) =>
      typeof address === "string" && address.toLowerCase() === to.toLowerCase());
    if (!accepted) {
      throw localFailure("EEMAILREJECTED", "The email provider rejected this recipient.");
    }
    return { messageId: result.messageId || null, accepted: [to] };
  } finally {
    transport.close?.();
  }
}

// Do not copy upstream messages or SMTP responses: they can contain secrets.
export function safeEmailFailure(error) {
  const code = error?.code;
  if (code === "EEMAILCONFIG" || code === "EAUTH") {
    return { uncertain: false, message: "Email could not sign in for this business. Check its email settings on the server." };
  }
  if (code === "EEMAILINPUT") {
    return { uncertain: false, message: "Check the customer's email address and this business's email settings." };
  }
  const responseCode = Number(error?.responseCode);
  const uncertain = code !== "EEMAILREJECTED" &&
    !(Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599);
  return {
    uncertain,
    message: uncertain
      ? "The email provider did not confirm this message. Check its sent-message log before trying again; it may have been sent."
      : "The email provider could not send this message. Check the customer's email address and this business's email settings.",
  };
}
