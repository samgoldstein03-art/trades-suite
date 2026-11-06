// Sample-only job records for the standalone preview. The installed product
// uses src/jobs.js and SQLite; this adapter never sends a message.
export function createBrowserJobs({ getData, id, now, log }) {
  const statuses = new Set(["awaiting_scheduling", "scheduled", "waiting_parts", "in_progress", "completed", "follow_up", "cancelled"]);
  const types = new Set(["service", "installation"]);
  const labels = { awaiting_scheduling: "Awaiting scheduling", scheduled: "Booked", waiting_parts: "Waiting for parts", in_progress: "Work underway", completed: "Completed", follow_up: "Follow-up needed", cancelled: "Cancelled" };
  const all = () => getData().jobs ||= [];
  const person = (job) => getData().contacts.find((c) => c.business_id === job.business_id && c.id === job.contact_id);
  const business = (job) => getData().businesses.find((b) => b.id === job.business_id);
  const linkedQuote = (job) => job.quote_id ? (getData().quotes || []).find((q) => q.business_id === job.business_id && q.id === job.quote_id) : null;
  const baseUrl = () => typeof location === "undefined" ? "https://demo.example.test/" : location.href.split("#")[0];
  function text(value, label, max, required = false) {
    if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || value.trim().length > max || (required && !value.trim())) throw new Error(`Enter ${label.toLowerCase()} within the allowed length.`);
    return value.trim();
  }
  function token() {
    if (!globalThis.crypto?.getRandomValues) throw new Error("This browser cannot create a private job link. Use the installed app.");
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function activity(job, kind, label) {
    log(business(job), person(job), kind, `${job.reference} ${label}`);
    getData().activity[0].job_id = job.id;
  }
  function quoteSummary(job, publicOnly = false) {
    const q = linkedQuote(job);
    if (!q) return null;
    return { ...(publicOnly ? {} : { id: q.id, status: q.status }), reference: q.reference, public_url: q.public_url || null, total_cents: q.total_cents, currency: q.currency };
  }
  function view(job) {
    const { public_token, ...visible } = job;
    delete visible.customer_name;
    return { ...visible, contact_name: job.customer_name, quote: quoteSummary(job), link_enabled: Boolean(job.link_enabled), public_url: job.link_enabled ? job.public_url : null };
  }
  function publicView(job) {
    const b = business(job);
    return {
      reference: job.reference, title: job.title, job_type: job.job_type, status: job.status,
      description: job.description, service_address: job.service_address, scheduled_date: job.scheduled_date,
      arrival_start: job.arrival_start, arrival_end: job.arrival_end, time_zone: job.time_zone,
      customer_name: job.customer_name, business: { name: b.name, phone: b.phone, booking_url: b.booking_url, logo_url: b.logo_url || null },
      mode: "demo", public_updates: job.public_updates.map(({ message, status, created_at }) => ({ message, status, created_at })),
      updated_at: job.public_updated_at, quote: quoteSummary(job, true),
    };
  }
  function fields(input, existing = {}) {
    const get = (name, fallback = "") => input[name] === undefined ? existing[name] ?? fallback : input[name];
    const next = {
      title: text(get("title"), "Title", 160, true),
      description: text(get("description"), "Description", 5000),
      service_address: text(get("service_address"), "Service address", 1000, true),
      private_notes: text(get("private_notes"), "Internal notes", 10000),
      job_type: get("job_type", "service"),
      status: get("status", "awaiting_scheduling"),
      scheduled_date: text(get("scheduled_date"), "Appointment date", 10),
      arrival_start: text(get("arrival_start"), "Arrival window start", 5),
      arrival_end: text(get("arrival_end"), "Arrival window end", 5),
      time_zone: text(get("time_zone", "America/Toronto"), "Time zone", 100, true),
    };
    if (!types.has(next.job_type)) throw new Error("Choose service/repair or installation.");
    if (!statuses.has(next.status)) throw new Error("Choose a valid job status.");
    try { if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(next.time_zone)) throw new Error(); new Intl.DateTimeFormat("en", { timeZone: next.time_zone }).format(); } catch { throw new Error("Choose a valid time zone."); }
    if (next.scheduled_date) {
      if (typeof next.scheduled_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(next.scheduled_date) || !Number.isFinite(Date.parse(`${next.scheduled_date}T00:00:00Z`)) || new Date(`${next.scheduled_date}T00:00:00Z`).toISOString().slice(0, 10) !== next.scheduled_date) throw new Error("Enter a valid appointment date.");
      if (![next.arrival_start, next.arrival_end].every((value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) || next.arrival_end <= next.arrival_start) throw new Error("Enter an arrival window ending after it starts.");
      if (next.status === "awaiting_scheduling") throw new Error("Choose Booked or clear the appointment before saving.");
    } else {
      if (next.arrival_start || next.arrival_end) throw new Error("Choose an appointment date for this arrival window.");
      if (next.status === "scheduled") throw new Error("Add a date and arrival window before marking this job booked.");
    }
    return next;
  }
  const publicFields = ["title", "description", "service_address", "job_type", "status", "scheduled_date", "arrival_start", "arrival_end", "time_zone"];
  function update(job, input) {
    if (input.contact_id !== undefined && input.contact_id !== job.contact_id) throw new Error("The customer cannot be changed on an existing job.");
    if (input.quote_id !== undefined && (input.quote_id || null) !== job.quote_id) throw new Error("The linked quote cannot be changed on an existing job.");
    const next = fields(input, job);
    const message = text(input.customer_update === undefined ? "" : input.customer_update, "Customer update", 5000);
    const published = publicFields.some((key) => next[key] !== job[key]) || Boolean(message);
    const changed = published || next.private_notes !== job.private_notes;
    if (!changed) return view(job);
    const previousStatus = job.status;
    const scheduleChanged = ["scheduled_date", "arrival_start", "arrival_end", "time_zone"].some((key) => next[key] !== job[key]);
    Object.assign(job, next, { updated_at: now() });
    if (published) {
      job.public_updated_at = now();
      if (message || previousStatus !== job.status || scheduleChanged) job.public_updates.push({ id: id(), message: message || (previousStatus !== job.status ? `Status changed to ${labels[job.status]}.` : "Appointment updated."), status: job.status, created_at: now() });
    }
    activity(job, previousStatus !== job.status ? "job_status" : "job_updated", previousStatus !== job.status ? `status changed to ${job.status.replaceAll("_", " ")}` : "updated");
    return view(job);
  }
  function adminRoute(b, parts, method, input, query) {
    if (parts.length === 4 && method === "GET") {
      const status = query.get("status"), type = query.get("job_type");
      if (status && !statuses.has(status)) throw new Error("Choose a valid job status.");
      if (type && !types.has(type)) throw new Error("Choose a valid job type.");
      return all().filter((job) => job.business_id === b.id && (!status || job.status === status) && (!type || job.job_type === type)).sort((a, c) => c.created_at.localeCompare(a.created_at) || c.id.localeCompare(a.id)).map(view);
    }
    if (parts.length === 4 && method === "POST") {
      const quote_id = input.quote_id === undefined || input.quote_id === null || input.quote_id === "" ? null : text(input.quote_id, "Quote", 100, true);
      const quote = quote_id ? (getData().quotes || []).find((q) => q.business_id === b.id && q.id === quote_id) : null;
      if (quote_id && !quote) throw new Error("Quote not found in this business.");
      const contact_id = text(input.contact_id ?? quote?.contact_id ?? "", "Customer", 100, true);
      if (!getData().contacts.some((c) => c.business_id === b.id && c.id === contact_id)) throw new Error("Customer not found in this business.");
      if (quote_id) {
        const q = (getData().quotes || []).find((q) => q.business_id === b.id && q.id === quote_id);
        if (!q || q.contact_id !== contact_id || q.status !== "accepted") throw new Error("Choose an accepted quote for this customer and business.");
        if (q.mode !== "demo") throw new Error("Create this job in the same sending mode as its accepted quote.");
        const existing = all().find((job) => job.business_id === b.id && job.quote_id === quote_id);
        if (existing) return view(existing);
      }
      const values = fields(input);
      const message = text(input.customer_update === undefined ? "" : input.customer_update, "Customer update", 5000);
      const job = { ...values, id: id(), business_id: b.id, contact_id, quote_id, customer_name: (getData().quotes || []).find((q) => q.id === quote_id && q.business_id === b.id)?.snapshot?.customer_name || getData().contacts.find((c) => c.id === contact_id && c.business_id === b.id).name, mode: "demo", link_enabled: false, public_token: null, public_url: null, created_at: now(), updated_at: now(), public_updated_at: now(), public_updates: [] };
      job.reference = `J-${job.id.padStart(8, "0")}`;
      job.public_updates.push({ id: id(), message: message || "Job created.", status: job.status, created_at: now() });
      all().push(job); activity(job, "job_created", "created"); return view(job);
    }
    const job = all().find((job) => job.business_id === b.id && job.id === parts[4]);
    if (!job) throw new Error("Job not found in this business.");
    if (parts.length === 5 && method === "GET") return view(job);
    if (parts.length === 5 && method === "PATCH") return update(job, input);
    if (parts.length === 6 && method === "POST" && ["share", "rotate-link", "revoke-link"].includes(parts[5])) {
      if (parts[5] === "revoke-link") {
        if (job.link_enabled) {
          Object.assign(job, { link_enabled: false, public_token: null, public_url: null, updated_at: now() });
          activity(job, "job_link_revoked", "customer link disabled");
        }
      } else if (!job.link_enabled || parts[5] === "rotate-link") {
        job.public_token = token(); job.public_url = `${baseUrl()}#job/${job.public_token}`;
        job.link_enabled = true; job.updated_at = now();
        activity(job, parts[5] === "rotate-link" ? "job_link_rotated" : "job_link_shared", "customer link ready");
      }
      return view(job);
    }
    throw new Error("That job action was not found.");
  }
  function publicRoute(parts, method) {
    const job = parts.length === 3 && parts[2] === "data" && method === "GET" && /^[a-f0-9]{64}$/.test(parts[1] || "")
      ? all().find((job) => job.link_enabled && job.public_token === parts[1]) : null;
    if (!job) throw new Error("This job link is unavailable. Ask the business for a current link.");
    return publicView(job);
  }
  return { adminRoute, publicRoute };
}
