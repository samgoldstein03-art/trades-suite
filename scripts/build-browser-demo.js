import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBrowserQuotes } from "./browser-quotes.js";

// This adapter is only bundled into the standalone sample. The installed app
// continues to use Express, SQLite and the per-business Twilio transport.
export function createBrowserDemo(storage) {
  const key = "tradesuite-browser-demo-v1";
  const day = 86400000;
  const copy = (value) => JSON.parse(JSON.stringify(value));
  let data;
  try { data = JSON.parse(storage.getItem(key)); } catch {}
  if (!data || !Array.isArray(data.businesses) || !Array.isArray(data.contacts) || !Array.isArray(data.requests) || !Array.isArray(data.activity)) data = null;
  const fresh = !data;
  if (fresh) data = { next: 1, businesses: [], contacts: [], requests: [], activity: [] };
  const id = () => String(data.next++);
  const now = () => new Date().toISOString();
  const save = () => { try { storage.setItem(key, JSON.stringify(data)); } catch {} };
  const log = (business, contact, kind, label, body = "", created_at = now()) => {
    data.activity.unshift({ id: id(), business_id: business.id, contact_id: contact?.id || null, contact_name: contact?.name || "", kind, label, body, mode: "demo", created_at });
  };
  const quotes = createBrowserQuotes({ getData: () => data, id, now, log });
  const phone = (value) => {
    const normalized = String(value || "").replace(/[\s()\-]/g, "");
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("Enter a phone number with a country code, such as +14165550123.");
    return normalized;
  };
  const link = (value, required = false) => {
    if (!value && !required) return "";
    try { const url = new URL(value); if (!["https:", "http:"].includes(url.protocol)) throw new Error(); return url.href; }
    catch { throw new Error("Enter a complete web link beginning with https://."); }
  };
  const businessValues = (values, existing = {}) => {
    const name = String(values.name ?? existing.name ?? "").trim();
    if (!name || name.length > 100) throw new Error("Enter a business name of up to 100 characters.");
    const sms_key = String(values.sms_key ?? existing.sms_key ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(sms_key)) throw new Error("Use a short text-message settings name, such as HARBOR.");
    if (data.businesses.some((b) => b.sms_key === sms_key && b.id !== existing.id)) throw new Error("That settings name belongs to another business. Choose another.");
    return { name, sms_key, phone: phone(values.phone ?? existing.phone), booking_url: link(values.booking_url ?? existing.booking_url), google_review_url: link(values.google_review_url ?? existing.google_review_url, true), sms_ready: false };
  };
  const addBusiness = (values) => {
    const b = { ...businessValues(values), id: id(), logo_url: "", created_at: now() };
    data.businesses.push(b); log(b, null, "business_created", "Business added."); return b;
  };
  const contactValues = (values, existing = {}) => {
    const name = String(values.name ?? existing.name ?? "").trim();
    if (!name || name.length > 100) throw new Error("Enter a customer name of up to 100 characters.");
    const number = phone(values.phone ?? existing.phone);
    const changed = existing.phone && number !== existing.phone;
    return { name, phone: number, email: String(values.email ?? existing.email ?? ""), notes: String(values.notes ?? existing.notes ?? ""), tags: (Array.isArray(values.tags) ? values.tags : [values.tags || "customer"]).filter((tag) => ["lead", "customer"].includes(tag)), sms_consent: changed ? false : Boolean(values.sms_consent ?? existing.sms_consent), opted_out: Boolean(existing.opted_out) };
  };
  const addContact = (business, values) => {
    const c = { ...contactValues(values), id: id(), business_id: business.id, created_at: now() };
    data.contacts.push(c); log(business, c, "contact_created", "Customer added."); return c;
  };
  const message = (business, contact, nudge = false) => `${nudge ? `Hi ${contact.name}, just a gentle reminder` : `Hi ${contact.name}, thanks for choosing ${business.name}!`}${nudge ? ` from ${business.name}. If you have a moment, we'd appreciate your review: ` : ` Would you share a quick review of our work? `}${business.google_review_url}\n\n${business.name}\nReply STOP to opt out`;
  const eligible = (business, contactId) => {
    const contact = data.contacts.find((c) => c.id === String(contactId) && c.business_id === business.id);
    if (!contact) throw new Error("That customer could not be found for this business.");
    if (!contact.sms_consent || contact.opted_out) throw new Error("This customer needs to give permission before a review text can be sent.");
    if (data.requests.some((r) => r.business_id === business.id && r.contact_id === contact.id && r.status !== "done")) throw new Error("This customer already has an open review request.");
    return contact;
  };
  const send = (business, contact, sent_at = now()) => {
    const r = { id: id(), business_id: business.id, contact_id: contact.id, contact_name: contact.name, contact_phone: contact.phone, status: "sent", mode: "demo", sent_at, nudge_due_at: new Date(new Date(sent_at).getTime() + 3 * day).toISOString(), nudge_attempted_at: null, nudged_at: null, done_at: null };
    data.requests.unshift(r);
    log(business, contact, "sms_sent", "Review request sent", message(business, contact), sent_at);
    log(business, contact, "status_changed", "Request marked sent", "", sent_at);
    return r;
  };
  const done = (business, request) => {
    if (request.status !== "done") {
      request.status = "done"; request.done_at = now();
      log(business, data.contacts.find((c) => c.id === request.contact_id), "status_changed", "Request marked done");
    }
    return request;
  };
  const runNudges = (businessId = null) => {
    data.worker_last_checked_at = now();
    let count = 0;
    for (const request of data.requests) {
      if (businessId && request.business_id !== businessId) continue;
      if (request.status !== "sent" || request.nudge_attempted_at || new Date(request.nudge_due_at).getTime() > Date.now()) continue;
      const business = data.businesses.find((b) => b.id === request.business_id);
      const contact = data.contacts.find((c) => c.id === request.contact_id && c.business_id === request.business_id);
      if (!business || !contact || !contact.sms_consent || contact.opted_out || contact.phone !== request.contact_phone) continue;
      request.nudge_attempted_at = request.nudged_at = now(); request.status = "nudged";
      log(business, contact, "sms_sent", "Follow-up nudge sent", message(business, contact, true));
      log(business, contact, "status_changed", "Request marked nudged"); count++;
    }
    if (count) save();
    return count;
  };
  if (fresh) {
    const harbor = addBusiness({ name: "Harbor Plumbing", phone: "+14165550101", booking_url: "https://example.com/harbor/book", google_review_url: "https://g.page/r/demo-harbor/review", sms_key: "HARBOR" });
    const contacts = ["Jamie Carter", "Alex Morgan", "Sam Wilson", "Taylor Bennett", "Jordan Lee", "Casey Brooks", "Morgan Park"].map((name, i) => addContact(harbor, { name, phone: `+1416555011${i}`, email: `${name.split(" ")[0].toLowerCase()}@example.com`, notes: ["Kitchen tap replacement. Happy with the new finish.", "Annual water heater check.", "Fixed a slow drain in the upstairs bathroom."][i % 3], tags: [i === 6 ? "lead" : "customer"], sms_consent: true }));
    const first = send(harbor, contacts[0], new Date(Date.now() - 4 * day).toISOString()); done(harbor, first);
    send(harbor, contacts[1], new Date(Date.now() - 4 * day).toISOString()); runNudges(harbor.id);
    send(harbor, contacts[2]); done(harbor, send(harbor, contacts[3])); send(harbor, contacts[4]); send(harbor, contacts[5]);
    addBusiness({ name: "Summit Electric", phone: "+14165550201", booking_url: "https://example.com/summit/book", google_review_url: "https://g.page/r/demo-summit/review", sms_key: "SUMMIT" }); save();
  }
  return async function browserDemoApi(path, options = {}) {
    // Another tab may have accepted a quote. Read its saved response before
    // refreshing the owner's dashboard or sending the next demo reminder.
    try { const saved = JSON.parse(storage.getItem(key)); if (saved?.businesses && saved?.contacts && saved?.requests && saved?.activity) data = saved; } catch {}
    runNudges();
    quotes.run();
    save();
    const method = options.method || "GET";
    const values = typeof options.body === "string" ? JSON.parse(options.body) : options.body || {};
    if (path === "/api/config") return { sms_mode: "demo", browser_demo: true, public_demo: true, nudge_after_hours: 72 };
    if (path === "/api/businesses") {
      if (method === "GET") return copy(data.businesses);
      if (method === "POST") { const result = addBusiness(values); save(); return copy(result); }
    }
    const parsedPath = new URL(path, "https://demo.example.test");
    const parts = parsedPath.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "q") { const result = quotes.publicRoute(parts, method, values); save(); return copy(result); }
    if (parts[0] !== "api" || parts[1] !== "businesses") throw new Error("That page is not available in the browser demo.");
    const b = data.businesses.find((x) => x.id === parts[2]);
    if (!b) throw new Error("That business could not be found.");
    let result;
    const contacts = () => data.contacts.filter((c) => c.business_id === b.id);
    const requests = () => data.requests.filter((r) => r.business_id === b.id);
    const activity = () => data.activity.filter((a) => a.business_id === b.id).sort((a, c) => new Date(c.created_at) - new Date(a.created_at));
    if (parts[3] === "quotes") result = quotes.adminRoute(b, parts, method, values, parsedPath.searchParams);
    else if (parts.length === 3 && method === "PATCH") {
      result = Object.assign(b, businessValues(values, b));
      log(b, null, "business_updated", "Business details updated.");
    }
    else if (parts[3] === "logo" && method === "POST") {
      const file = values.get("logo");
      if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error("Choose a PNG, JPG or WebP image under 2 MB.");
      b.logo_url = await new Promise((accept, reject) => { const reader = new FileReader(); reader.onload = () => accept(reader.result); reader.onerror = () => reject(new Error("Could not read that image.")); reader.readAsDataURL(file); }); result = b;
      log(b, null, "business_updated", "Business logo updated.");
    } else if (parts[3] === "contacts" && method === "GET") result = contacts();
    else if (parts[3] === "contacts" && method === "POST") result = addContact(b, values);
    else if (parts[3] === "contacts" && method === "PATCH") {
      const c = contacts().find((x) => x.id === parts[4]);
      if (!c) throw new Error("That customer could not be found for this business.");
      result = Object.assign(c, contactValues(values, c));
      log(b, c, "contact_updated", "Customer details updated.");
    } else if (parts[3] === "requests" && method === "GET") result = requests();
    else if (parts[3] === "requests" && parts[5] === "done" && method === "POST") {
      const r = requests().find((x) => x.id === parts[4]);
      if (!r) throw new Error("That request could not be found for this business.");
      result = done(b, r);
    } else if (parts[3] === "requests" && parts[5] === "retry-nudge" && method === "POST") {
      throw new Error("There are no failed follow-ups to retry in this browser demo.");
    } else if (parts[3] === "requests" && method === "POST") {
      const c = eligible(b, values.contact_id);
      result = parts[4] === "preview" ? { body: message(b, c), mode: "demo" } : send(b, c);
    } else if (parts[3] === "demo" && parts[4] === "advance" && method === "POST") {
      for (const r of requests()) if (r.status === "sent" && !r.nudge_attempted_at) {
        r.sent_at = new Date(new Date(r.sent_at).getTime() - 3 * day).toISOString();
        r.nudge_due_at = new Date(new Date(r.nudge_due_at).getTime() - 3 * day).toISOString();
      }
      result = { nudged: runNudges(b.id) };
    } else if (parts[3] === "activity" && method === "GET") result = activity();
    else if (parts[3] === "dashboard" && method === "GET") {
      const all = requests(); const waiting = all.filter((r) => r.status === "sent" && !r.nudge_attempted_at);
      result = { total_requests: all.length, awaiting_nudge: waiting.length, completed: all.filter((r) => r.status === "done").length, upcoming_nudges: waiting, recent_activity: activity().slice(0, 8), attention_needed: [], worker_last_checked_at: data.worker_last_checked_at, quotes_awaiting_response: quotes.dashboard(b.id) };
    } else throw new Error("That action is not available in the browser demo.");
    save(); return copy(result);
  };
}

export function buildBrowserDemo(output) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let html = readFileSync(resolve(root, "public/index.html"), "utf8");
  let css = readFileSync(resolve(root, "public/styles.css"), "utf8").replace('@import url("/fonts.css");', "");
  const fonts = readFileSync(resolve(root, "public/fonts.css"), "utf8").replace(/url\(\/fonts\/([^)]+)\)/g, (_, file) => `url(data:font/ttf;base64,${readFileSync(resolve(root, "public/fonts", file)).toString("base64")})`);
  const quoteRenderer = readFileSync(resolve(root, "public/quote.js"), "utf8").split("async function quotePublicRequest")[0];
  // Keep the customer's standalone stylesheet from changing the admin screens.
  const quoteCss = readFileSync(resolve(root, "public/quote.css"), "utf8").split("\n").map((line) => {
    const match = line.match(/^(\s*)([^@{}][^{]*)\{(.*)$/);
    if (!match) return line;
    const selectors = match[2].split(",").map((selector) => [":root", "body"].includes(selector.trim()) ? ".browser-customer-quote" : `.browser-customer-quote ${selector.trim()}`).join(", ");
    return `${match[1]}${selectors} {${match[3].replace("margin: 0; padding: 42px", "margin: 0 auto; padding: 42px")}`;
  }).join("\n");
  let app = readFileSync(resolve(root, "public/app.js"), "utf8");
  app = app.replace(/async function api\(path, options = \{\}\) \{[\s\S]*?\n\}\nfunction toast/, "async function api(path, options = {}) { return browserDemoApi(path, options); }\nfunction toast");
  if (/await fetch\(/.test(app)) throw new Error("Frontend network API was not replaced.");
  app = app.replaceAll("localStorage.", "browserStorage.");
  app = app.replace("Public demo · Use sample details only. Anyone with this link can see changes. No real texts are sent.", "Browser demo · Sample data only. No real texts are sent. Changes stay in this browser. Automatic follow-ups run while this file is open.");
  const boot = `const browserStorage = (() => { const memory = new Map(); return { getItem(key) { try { return localStorage.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } }, setItem(key, value) { memory.set(key, String(value)); try { localStorage.setItem(key, String(value)); } catch {} } }; })();\nconst browserDemoApi = (${createBrowserDemo.toString()})(browserStorage);\n`;
  html = html.replace('<link rel="stylesheet" href="/styles.css" />', `<style>${fonts}\n${css}\n${quoteCss}</style>`).replace('<script type="module" src="/app.js"></script>', "");
  html = html.replace("<title>Tradesuite — Good work travels</title>", '<title>Tradesuite — Browser demo</title>\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'">');
  html = html.replace("</body>", `<script>${(`const createBrowserQuotes = ${createBrowserQuotes.toString()};\n` + boot + quoteRenderer + app).replace(/<\/script/gi, "<\\/script")}</script>\n</body>`);
  const target = output ? resolve(output) : resolve(root, "Tradesuite Demo.html");
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, html);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Standalone browser demo saved: ${buildBrowserDemo(process.argv[2])}`);
}
