// Sample-only persistence for the standalone browser demo. No message providers
// are called here; the installed app uses src/quotes.js and SQLite.
export function createBrowserQuotes({ getData, id, now, log }) {
  const day = 86400000;
  const open = (q) => ["sent", "viewed"].includes(q.status);
  const all = () => getData().quotes ||= [];
  const customer = (q) => getData().contacts.find((c) => c.business_id === q.business_id && c.id === q.contact_id);
  const business = (q) => getData().businesses.find((b) => b.id === q.business_id);
  const optedOut = (c) => Boolean(c.opted_out || c.quote_email_opted_out);
  const unsubscribeTokens = () => getData().email_unsubscribe_tokens ||= [];
  const demoBase = () => typeof location === "undefined" ? "https://demo.example.test/" : location.href.split("#")[0];
  function unsubscribeLink(q) {
    let preference = unsubscribeTokens().find((entry) => entry.business_id === q.business_id && entry.contact_id === q.contact_id);
    if (!preference) {
      preference = { business_id: q.business_id, contact_id: q.contact_id, token: `${id()}${id()}${Date.now().toString(16)}` };
      unsubscribeTokens().push(preference);
    }
    return `${demoBase()}#unsubscribe/${preference.token}`;
  }
  function activity(q, kind, label, body = "") {
    log(business(q), customer(q), kind, `${q.reference} ${label}`, body);
    getData().activity[0].quote_id = q.id;
  }
  function status(q, value) { q.status = value; q.updated_at = now(); activity(q, "quote_status", value); }
  function fields(input) {
    if (!Array.isArray(input.line_items) || !input.line_items.length || input.line_items.length > 100) throw new Error("Add between 1 and 100 line items.");
    const line_items = input.line_items.map((item) => {
      if (!item || typeof item.description !== "string" || !item.description.trim() || item.description.length > 500 || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 100000 || !Number.isFinite(item.unit_price) || item.unit_price < 0 || item.unit_price > 1000000) throw new Error("Enter a description, quantity, and price for each item.");
      if (Math.abs(item.quantity * 1000 - Math.round(item.quantity * 1000)) > .000001 || Math.abs(item.unit_price * 100 - Math.round(item.unit_price * 100)) > .000001) throw new Error("Use up to three decimals for quantity and two for price.");
      return { description: item.description.trim(), quantity: item.quantity, unit_price: item.unit_price, line_total_cents: Math.round(Math.round(item.quantity * 1000) * Math.round(item.unit_price * 100) / 1000) };
    });
    const tax_rate = input.tax_rate ?? 0;
    if (!Number.isFinite(tax_rate) || tax_rate < 0 || tax_rate > 100) throw new Error("Enter a tax rate between 0 and 100.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry_date) || !Number.isFinite(Date.parse(input.expiry_date)) || new Date(input.expiry_date).toISOString().slice(0, 10) !== input.expiry_date || input.expiry_date < now().slice(0, 10)) throw new Error("Choose a valid expiry date that has not passed.");
    if (typeof (input.notes ?? "") !== "string" || (input.notes || "").length > 5000) throw new Error("Keep quote notes under 5,000 characters.");
    const currency = input.currency ?? "CAD";
    if (!["CAD", "USD"].includes(currency)) throw new Error("Choose CAD or USD.");
    const subtotal_cents = line_items.reduce((sum, item) => sum + item.line_total_cents, 0);
    const tax_cents = Math.round(subtotal_cents * tax_rate / 100);
    if (subtotal_cents + tax_cents > 10000000000) throw new Error("The quote total is too large.");
    return { contact_id: String(input.contact_id), line_items, tax_rate, subtotal_cents, tax_cents, total_cents: subtotal_cents + tax_cents, currency, expiry_date: input.expiry_date, notes: input.notes || "" };
  }
  function view(q) {
    const { token, snapshot, follow_up_phone, ...visible } = q;
    const nudges = q.deliveries.filter((d) => d.kind !== "initial" && d.status === "simulated").length;
    return { ...visible, contact_name: snapshot?.customer_name || customer(q).name, nudge_count: nudges, nudges_sent: nudges, sendable_channels: ["draft", "sent", "viewed"].includes(q.status) ? ["sms", "email"].filter((channel) => !q.deliveries.some((d) => d.channel === channel && d.kind === "initial")) : [] };
  }
  function publicView(q) {
    return { reference: q.reference, status: q.status, mode: "demo", business: q.snapshot.business, customer_name: q.snapshot.customer_name, contact_name: q.snapshot.customer_name, line_items: q.line_items, tax_rate: q.tax_rate, subtotal_cents: q.subtotal_cents, tax_cents: q.tax_cents, total_cents: q.total_cents, currency: q.currency, expiry_date: q.expiry_date, notes: q.notes, can_respond: open(q) };
  }
  function deliver(q, channel, kind) {
    const unsubscribeUrl = channel === "email" ? unsubscribeLink(q) : null;
    q.deliveries.push({ id: id(), channel, kind, status: "simulated", attempts: 1, created_at: now(), updated_at: now(), ...(unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}) });
    const name = q.snapshot.business.name;
    const body = `Hi ${q.snapshot.customer_name.split(/\s+/)[0]}, ${kind === "initial" ? "your quote is ready" : "just a gentle reminder about your quote"}: ${q.public_url}\n\n${name}${channel === "sms" ? "\nReply STOP to opt out" : `\nUnsubscribe: ${unsubscribeUrl}`}`;
    activity(q, channel === "sms" ? "sms_sent" : "email_sent", `${kind === "initial" ? "link" : "follow-up"} simulated by ${channel === "sms" ? "text" : "email"}`, body);
  }
  function run(businessId) {
    let sent = 0;
    for (const q of all()) {
      if (businessId && q.business_id !== businessId) continue;
      if (["draft", "sent", "viewed"].includes(q.status) && q.expiry_date < now().slice(0, 10)) status(q, "expired");
      if (!open(q) || q.follow_ups_cancelled_at || Date.parse(now()) - Date.parse(q.sent_at) < 2 * day) continue;
      const c = customer(q);
      if (!c.sms_consent || optedOut(c) || c.phone !== q.follow_up_phone) {
        q.follow_ups_cancelled_at = now(); activity(q, "quote_follow_ups_cancelled", "follow-ups stopped", "Text permission or the customer's phone number changed."); continue;
      }
      const kind = Date.parse(now()) - Date.parse(q.sent_at) >= 5 * day ? "nudge_5" : "nudge_2";
      if (kind === "nudge_5" && !q.deliveries.some((d) => d.kind === "nudge_2")) q.deliveries.push({ id: id(), channel: "sms", kind: "nudge_2", status: "skipped", attempts: 0, created_at: now(), updated_at: now() });
      if (!q.deliveries.some((d) => d.kind === kind)) { deliver(q, "sms", kind); sent++; }
    }
    return { sent, failed: 0 };
  }
  function publicRoute(parts, method, values) {
    if (parts[1] === "unsubscribe") {
      const preference = unsubscribeTokens().find((entry) => entry.token === parts[2]);
      const c = preference && getData().contacts.find((entry) => entry.business_id === preference.business_id && entry.id === preference.contact_id);
      const b = preference && getData().businesses.find((entry) => entry.id === preference.business_id);
      if (!c || !b) throw new Error("This unsubscribe link was not found. Browser demo links work only in the browser where they were created.");
      if (method === "POST" && parts.length === 3) {
        if (!c.quote_email_opted_out) {
          c.quote_email_opted_out = true;
          c.updated_at = now();
          log(b, c, "contact_unsubscribed", "Customer unsubscribed from texts and quote emails.");
        }
      } else if (!(method === "GET" && parts[3] === "data" && parts.length === 4)) throw new Error("That unsubscribe action is not available.");
      return { business_name: b.name, unsubscribed: Boolean(c.quote_email_opted_out) };
    }
    const q = all().find((q) => q.token === parts[1] && q.sent_at);
    if (!q) throw new Error("This quote link was not found. Browser demo links work only in the browser where they were created.");
    if (parts[2] === "data" && method === "GET") {
      if (q.status === "sent") { q.viewed_at = now(); status(q, "viewed"); }
    } else if (parts[2] === "respond" && method === "POST") {
      if (!["accepted", "declined"].includes(values.decision)) throw new Error("Choose Accept or Decline.");
      if (q.status !== values.decision) {
        if (!open(q)) throw new Error("This quote is no longer waiting for a response.");
        q.responded_at = now(); status(q, values.decision);
      }
    } else throw new Error("That quote action is not available.");
    return publicView(q);
  }
  function adminRoute(b, parts, method, values, search) {
    const quotes = () => all().filter((q) => q.business_id === b.id);
    if (parts[4] === "demo" && parts[5] === "advance" && method === "POST") {
      if (![2, 3, 5].includes(values.days)) throw new Error("Choose 2, 3, or 5 days.");
      for (const q of quotes()) if (open(q)) q.sent_at = new Date(Date.parse(q.sent_at) - values.days * day).toISOString();
      return run(b.id);
    }
    if (parts.length === 4 && method === "GET") return quotes().filter((q) => !search.get("status") || q.status === search.get("status")).map(view).reverse();
    if (parts.length === 4 && method === "POST") {
      const valuesChecked = fields(values);
      const q = { ...valuesChecked, id: id(), business_id: b.id, token: `${id()}${id()}${Date.now().toString(16)}`, mode: "demo", status: "draft", deliveries: [], created_at: now(), updated_at: now(), sent_at: null, follow_ups_cancelled_at: null };
      if (!customer(q)) throw new Error("Customer not found in this business.");
      q.reference = `Q-${q.id.padStart(8, "0")}`;
      all().push(q); activity(q, "quote_created", "created as a draft"); return view(q);
    }
    const q = quotes().find((q) => q.id === parts[4]);
    if (!q) throw new Error("Quote not found in this business.");
    if (parts.length === 5 && method === "GET") return view(q);
    if (parts.length === 5 && method === "PATCH") {
      if (q.status !== "draft" || q.snapshot) throw new Error("Only an unsent draft can be changed.");
      const checked = fields({ ...q, ...values });
      if (!customer({ ...q, ...checked })) throw new Error("Customer not found in this business.");
      Object.assign(q, checked, { updated_at: now() }); return view(q);
    }
    if (parts[5] === "cancel-follow-ups" && method === "POST") {
      if (!q.follow_ups_cancelled_at) { q.follow_ups_cancelled_at = now(); activity(q, "quote_follow_ups_cancelled", "follow-ups stopped"); }
      return view(q);
    }
    if (parts[5] === "send" && method === "POST") {
      if (!["draft", "sent", "viewed"].includes(q.status)) throw new Error("This quote is no longer available to send.");
      const channels = values.channels || ["sms"];
      if (!Array.isArray(channels) || !channels.length || channels.length > 2 || channels.some((c) => !["sms", "email"].includes(c)) || new Set(channels).size !== channels.length) throw new Error("Choose text, email, or both.");
      if (channels.some((channel) => !view(q).sendable_channels.includes(channel))) throw new Error("This quote was already sent through that channel.");
      const c = customer(q);
      if (optedOut(c)) throw new Error("This customer has opted out of messages from this business.");
      if (channels.includes("sms") && !c.sms_consent) throw new Error("Confirm this customer has agreed to receive texts.");
      if (channels.includes("email") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw new Error("Add a customer email address first.");
      q.snapshot ||= { business: { name: b.name, phone: b.phone, booking_url: b.booking_url, logo_url: null }, customer_name: c.name };
      q.follow_up_phone ||= c.phone;
      q.public_url ||= `${demoBase()}#quote/${q.token}`;
      if (!q.sent_at) { q.sent_at = now(); status(q, "sent"); }
      for (const channel of channels) deliver(q, channel, "initial");
      return view(q);
    }
    throw new Error("That quote action is not available.");
  }
  return { run, publicRoute, adminRoute, dashboard: (businessId) => all().filter((q) => q.business_id === businessId && open(q)).map(view) };
}
