import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

// All credentials and telephone numbers below are synthetic. No test uses Twilio's network.
const CREDENTIALS = {
  ALPHA: {
    accountSid: `AC${"1".repeat(32)}`,
    authToken: "synthetic-alpha-token-for-tests",
    phoneNumber: "+14165550101",
  },
  BETA: {
    accountSid: `AC${"2".repeat(32)}`,
    authToken: "synthetic-beta-token-for-tests",
    phoneNumber: "+14165550102",
  },
};
const DAY = 24 * 60 * 60 * 1000;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "trades-suite-test-"));
  const dbPath = path.join(directory, "test.sqlite");
  let currentTime = new Date("2026-10-01T12:00:00.000Z");
  const deliveries = [];
  const originalEnv = new Map();
  const setEnv = (key, value) => {
    if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  for (const [key, credentials] of Object.entries(CREDENTIALS)) {
    setEnv(`BUSINESS_${key}_ACCOUNT_SID`, credentials.accountSid);
    setEnv(`BUSINESS_${key}_AUTH_TOKEN`, credentials.authToken);
    setEnv(`BUSINESS_${key}_PHONE_NUMBER`, credentials.phoneNumber);
  }
  setEnv("PUBLIC_BASE_URL", "https://trades.example.test");
  const now = () => new Date(currentTime);
  const sendSms = async (message) => {
    deliveries.push(message);
    if (options.sendSms) return options.sendSms(message, deliveries.length);
    return { sid: `SM${String(deliveries.length).padStart(32, "0")}` };
  };
  const suite = createApp({
    dbPath,
    uploadDir: path.join(directory, "uploads"),
    smsMode: options.smsMode ?? "twilio",
    now,
    sendSms,
  });
  const server = suite.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await suite.close();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (method, url, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    return { status: response.status, data, raw };
  };
  const business = async (key = "ALPHA", overrides = {}) => {
    const response = await request("POST", "/api/businesses", {
      name: key === "ALPHA" ? "Alpha Heating" : "Beta Plumbing",
      phone: "+14165550200",
      booking_url: `https://${key.toLowerCase()}.example.test/book`,
      google_review_url: `https://g.page/r/${key.toLowerCase()}/review`,
      sms_key: key,
      ...overrides,
    });
    assert.equal(response.status, 201, "business can be created");
    return response.data;
  };
  const contact = async (businessId, overrides = {}) => {
    const response = await request(
      "POST",
      `/api/businesses/${businessId}/contacts`,
      {
        name: "Taylor Customer",
        phone: "+14165550300",
        email: "taylor@example.test",
        notes: "Replaced the furnace filter.",
        tags: ["customer"],
        sms_consent: true,
        ...overrides,
      },
    );
    assert.equal(response.status, 201, "contact can be created");
    return response.data;
  };
  const send = (businessId, contactId) =>
    request("POST", `/api/businesses/${businessId}/requests`, {
      contact_id: contactId,
    });
  return {
    ...suite,
    request,
    business,
    contact,
    send,
    baseUrl,
    deliveries,
    dbPath,
    setEnv,
    now,
    sendSms,
    uploadDir: path.join(directory, "uploads"),
    advance: (milliseconds) => {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
  };
}

test("businesses have separate contacts, requests, activity, profiles, and Twilio credentials", async (t) => {
  const f = await fixture(t);
  const alpha = await f.business("ALPHA");
  const beta = await f.business("BETA");
  const first = await f.contact(alpha.id, {
    name: "Alpha customer",
    notes: "Alpha-only note",
  });
  const second = await f.contact(beta.id, {
    name: "Beta customer",
    notes: "Beta-only note",
  });
  const alphaRequest = await f.send(alpha.id, first.id);
  const betaRequest = await f.send(beta.id, second.id);
  assert.equal(alphaRequest.status, 201);
  assert.equal(betaRequest.status, 201);
  assert.equal(f.deliveries.length, 2);
  for (const [index, [key, business]] of [
    ["ALPHA", alpha],
    ["BETA", beta],
  ].entries()) {
    const message = f.deliveries[index];
    assert.equal(message.accountSid, CREDENTIALS[key].accountSid);
    assert.equal(message.authToken, CREDENTIALS[key].authToken);
    assert.equal(message.from, CREDENTIALS[key].phoneNumber);
    assert.equal(message.businessId, business.id);
    assert.ok(message.body.includes(business.google_review_url));
    assert.ok(message.body.endsWith(`${business.name}\nReply STOP to opt out`));
  }
  const alphaContacts = await f.request(
    "GET",
    `/api/businesses/${alpha.id}/contacts`,
  );
  const betaContacts = await f.request(
    "GET",
    `/api/businesses/${beta.id}/contacts`,
  );
  assert.deepEqual(
    alphaContacts.data.map((item) => item.id),
    [first.id],
  );
  assert.deepEqual(
    betaContacts.data.map((item) => item.id),
    [second.id],
  );
  assert.equal(
    (
      await f.request(
        "PATCH",
        `/api/businesses/${beta.id}/contacts/${first.id}`,
        { notes: "wrong business" },
      )
    ).status,
    404,
  );
  assert.equal((await f.send(beta.id, first.id)).status, 404);
  assert.equal(
    (
      await f.request(
        "POST",
        `/api/businesses/${beta.id}/requests/${alphaRequest.data.id}/done`,
        {},
      )
    ).status,
    404,
  );
  const betaRequests = await f.request(
    "GET",
    `/api/businesses/${beta.id}/requests`,
  );
  assert.deepEqual(
    betaRequests.data.map((item) => item.id),
    [betaRequest.data.id],
  );
  const alphaActivity = await f.request(
    "GET",
    `/api/businesses/${alpha.id}/activity`,
  );
  const betaActivity = await f.request(
    "GET",
    `/api/businesses/${beta.id}/activity`,
  );
  assert.equal(alphaActivity.raw.includes("Beta customer"), false);
  assert.equal(betaActivity.raw.includes("Alpha customer"), false);
  assert.equal(
    (
      await f.request("PATCH", `/api/businesses/${alpha.id}`, {
        name: "Alpha Air & Heat",
      })
    ).status,
    200,
  );
  const businessList = await f.request("GET", "/api/businesses");
  assert.equal(
    businessList.data.find((item) => item.id === beta.id).name,
    "Beta Plumbing",
  );
  const publicData = [
    alpha,
    beta,
    alphaContacts.data,
    betaContacts.data,
    alphaActivity.data,
    betaActivity.data,
    businessList.data,
  ];
  for (const value of Object.values(CREDENTIALS)) {
    assert.equal(
      JSON.stringify(publicData).includes(value.authToken),
      false,
      "API responses do not expose auth tokens",
    );
    assert.equal(
      (await readFile(f.dbPath)).includes(Buffer.from(value.authToken)),
      false,
      "auth tokens are not stored in SQLite",
    );
  }
});

test("a request nudges at 72 hours, only once, then can be marked done", async (t) => {
  const f = await fixture(t);
  const business = await f.business();
  const contact = await f.contact(business.id);
  const sent = await f.send(business.id, contact.id);
  assert.equal(sent.status, 201);
  assert.equal(sent.data.status, "sent");
  f.advance(3 * DAY - 1);
  assert.equal((await f.runNudges()).sent, 0);
  assert.equal(f.deliveries.length, 1);
  f.advance(1);
  assert.equal((await f.runNudges()).sent, 1);
  assert.equal(f.deliveries.length, 2);
  assert.ok(f.deliveries[1].body.includes(business.google_review_url));
  assert.ok(
    f.deliveries[1].body.endsWith(`${business.name}\nReply STOP to opt out`),
  );
  let requests = await f.request(
    "GET",
    `/api/businesses/${business.id}/requests`,
  );
  assert.equal(requests.data[0].status, "nudged");
  f.advance(30 * DAY);
  assert.equal((await f.runNudges()).sent, 0);
  assert.equal(f.deliveries.length, 2);
  assert.equal(
    (
      await f.request(
        "POST",
        `/api/businesses/${business.id}/requests/${sent.data.id}/done`,
        {},
      )
    ).status,
    200,
  );
  requests = await f.request("GET", `/api/businesses/${business.id}/requests`);
  assert.equal(requests.data[0].status, "done");
  const activity = await f.request(
    "GET",
    `/api/businesses/${business.id}/activity`,
  );
  assert.equal(
    activity.data.filter((entry) => entry.kind === "sms_sent").length,
    2,
    "both SMS sends are logged",
  );
  assert.equal(
    activity.data.filter((entry) => entry.kind === "status_changed").length,
    3,
    "all three status changes are logged",
  );
  assert.ok(
    activity.data.every((entry) => entry.created_at || entry.timestamp),
    "every activity has a timestamp",
  );
});

test("done requests do not get a follow-up and repeated done does not duplicate activity", async (t) => {
  const f = await fixture(t);
  const business = await f.business();
  const contact = await f.contact(business.id);
  const sent = await f.send(business.id, contact.id);
  const donePath = `/api/businesses/${business.id}/requests/${sent.data.id}/done`;
  assert.equal((await f.request("POST", donePath, {})).status, 200);
  const before = await f.request(
    "GET",
    `/api/businesses/${business.id}/activity`,
  );
  assert.equal((await f.request("POST", donePath, {})).status, 200);
  const after = await f.request(
    "GET",
    `/api/businesses/${business.id}/activity`,
  );
  assert.equal(after.data.length, before.data.length);
  f.advance(4 * DAY);
  assert.equal((await f.runNudges()).sent, 0);
  assert.equal(f.deliveries.length, 1);
});

test("manual opt-out blocks new messages and an already scheduled follow-up", async (t) => {
  const f = await fixture(t);
  const business = await f.business();
  const contact = await f.contact(business.id);
  assert.equal((await f.send(business.id, contact.id)).status, 201);
  assert.equal(
    (
      await f.request(
        "PATCH",
        `/api/businesses/${business.id}/contacts/${contact.id}`,
        { opted_out: true },
      )
    ).status,
    200,
  );
  const blocked = await f.send(business.id, contact.id);
  assert.ok([400, 409].includes(blocked.status));
  f.advance(4 * DAY);
  assert.equal((await f.runNudges()).sent, 0);
  assert.equal(f.deliveries.length, 1);
});

test("parallel send clicks create one request and one SMS", async (t) => {
  const f = await fixture(t, {
    sendSms: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { sid: `SM${"3".repeat(32)}` };
    },
  });
  const business = await f.business();
  const contact = await f.contact(business.id);
  const results = await Promise.all([
    f.send(business.id, contact.id),
    f.send(business.id, contact.id),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(f.deliveries.length, 1);
  assert.equal(
    (await f.request("GET", `/api/businesses/${business.id}/requests`)).data
      .length,
    1,
  );
});

test("parallel workers using separate SQLite connections claim a due follow-up once", async (t) => {
  const f = await fixture(t, {
    sendSms: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { sid: `SM${"4".repeat(32)}` };
    },
  });
  const business = await f.business();
  const contact = await f.contact(business.id);
  await f.send(business.id, contact.id);
  f.advance(3 * DAY);
  const peer = createApp({
    dbPath: f.dbPath,
    uploadDir: f.uploadDir,
    smsMode: "twilio",
    now: f.now,
    sendSms: f.sendSms,
  });
  try {
    const results = await Promise.all([
      f.runNudges(),
      peer.runNudges(),
      f.runNudges(),
    ]);
    assert.equal(
      results.reduce((total, result) => total + result.sent, 0),
      1,
    );
    assert.equal(f.deliveries.length, 2);
  } finally {
    await peer.close();
  }
});

test("marking done while a follow-up is in flight preserves the done status", async (t) => {
  let finishNudge;
  let notifyNudgeStarted;
  const nudgeStarted = new Promise((resolve) => {
    notifyNudgeStarted = resolve;
  });
  const f = await fixture(t, {
    sendSms: async (message) => {
      if (message.kind === "nudge") {
        notifyNudgeStarted();
        return new Promise((resolve) => {
          finishNudge = resolve;
        });
      }
      return { sid: `SM${"7".repeat(32)}` };
    },
  });
  const business = await f.business();
  const contact = await f.contact(business.id);
  const sent = await f.send(business.id, contact.id);
  f.advance(3 * DAY);
  const worker = f.runNudges();
  await Promise.race([
    nudgeStarted,
    worker.then(() => {
      throw new Error("Worker finished before attempting the nudge");
    }),
  ]);
  try {
    assert.equal(
      (
        await f.request(
          "POST",
          `/api/businesses/${business.id}/requests/${sent.data.id}/done`,
          {},
        )
      ).status,
      200,
    );
  } finally {
    finishNudge({ sid: `SM${"8".repeat(32)}` });
    await worker;
  }
  assert.equal(
    (await f.request("GET", `/api/businesses/${business.id}/requests`)).data[0]
      .status,
    "done",
  );
  const activity = await f.request(
    "GET",
    `/api/businesses/${business.id}/activity`,
  );
  assert.equal(
    activity.data.filter((entry) => entry.kind === "status_changed").length,
    2,
    "sent and done are logged without a regression to nudged",
  );
});

test("a changed phone number needs fresh permission and cannot inherit an old follow-up", async (t) => {
  const f = await fixture(t);
  const business = await f.business();
  const contact = await f.contact(business.id);
  await f.send(business.id, contact.id);
  const contactPath = `/api/businesses/${business.id}/contacts/${contact.id}`;
  const changed = await f.request("PATCH", contactPath, {
    phone: "+14165550999",
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.sms_consent, false);
  assert.equal(
    (await f.request("PATCH", contactPath, { sms_consent: true })).status,
    200,
  );
  f.advance(3 * DAY);
  assert.equal(
    (await f.runNudges()).sent,
    0,
    "a different recipient must not receive a follow-up to the previous phone",
  );
  assert.equal(f.deliveries.length, 1);
});

test("dashboard totals and pending follow-ups reflect only the chosen business", async (t) => {
  const f = await fixture(t);
  const alpha = await f.business("ALPHA");
  const beta = await f.business("BETA");
  const first = await f.contact(alpha.id, { name: "Alpha one" });
  const second = await f.contact(alpha.id, {
    name: "Alpha two",
    phone: "+14165550302",
  });
  const third = await f.contact(beta.id, { name: "Beta only" });
  const firstRequest = await f.send(alpha.id, first.id);
  await f.send(alpha.id, second.id);
  await f.send(beta.id, third.id);
  const dashboard = async (id) =>
    (await f.request("GET", `/api/businesses/${id}/dashboard`)).data;
  let alphaView = await dashboard(alpha.id);
  assert.equal(alphaView.total_requests, 2);
  assert.equal(alphaView.awaiting_nudge, 2);
  assert.equal(alphaView.completed, 0);
  assert.equal(alphaView.upcoming_nudges.length, 2);
  assert.ok(alphaView.recent_activity.length > 0);
  assert.equal(JSON.stringify(alphaView).includes("Beta only"), false);
  await f.request(
    "POST",
    `/api/businesses/${alpha.id}/requests/${firstRequest.data.id}/done`,
    {},
  );
  alphaView = await dashboard(alpha.id);
  assert.equal(alphaView.total_requests, 2);
  assert.equal(alphaView.awaiting_nudge, 1);
  assert.equal(alphaView.completed, 1);
  const betaView = await dashboard(beta.id);
  assert.equal(betaView.total_requests, 1);
  assert.equal(betaView.awaiting_nudge, 1);
  assert.equal(betaView.completed, 0);
  f.advance(3 * DAY);
  await f.runNudges();
  assert.equal((await dashboard(alpha.id)).awaiting_nudge, 0);
  assert.equal((await dashboard(beta.id)).awaiting_nudge, 0);
});

test("logo upload saves a real image per business and rejects disguised text files", async (t) => {
  const f = await fixture(t);
  const alpha = await f.business("ALPHA");
  const beta = await f.business("BETA");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  const form = new FormData();
  form.append("logo", new Blob([png], { type: "image/png" }), "logo.png");
  const uploaded = await fetch(`${f.baseUrl}/api/businesses/${alpha.id}/logo`, {
    method: "POST",
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const saved = await uploaded.json();
  assert.ok(saved.logo_url.startsWith("/uploads/"));
  const image = await fetch(`${f.baseUrl}${saved.logo_url}`);
  assert.equal(image.status, 200);
  assert.ok(image.headers.get("Content-Type").startsWith("image/png"));
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const businesses = (await f.request("GET", "/api/businesses")).data;
  assert.equal(
    businesses.find((item) => item.id === alpha.id).logo_url,
    saved.logo_url,
  );
  assert.equal(businesses.find((item) => item.id === beta.id).logo_url, null);
  const invalid = new FormData();
  invalid.append(
    "logo",
    new Blob(['<svg onload="alert(1)"></svg>'], { type: "image/png" }),
    "disguised.png",
  );
  assert.equal(
    (
      await fetch(`${f.baseUrl}/api/businesses/${alpha.id}/logo`, {
        method: "POST",
        body: invalid,
      })
    ).status,
    400,
  );
});

test("a failed initial SMS does not appear as a sent request or expose provider errors", async (t) => {
  const f = await fixture(t, {
    sendSms: async () => {
      throw new Error(`Twilio rejected ${CREDENTIALS.ALPHA.authToken}`);
    },
  });
  const business = await f.business();
  const contact = await f.contact(business.id);
  const failed = await f.send(business.id, contact.id);
  assert.ok(failed.status >= 400);
  assert.equal(failed.raw.includes(CREDENTIALS.ALPHA.authToken), false);
  assert.equal(
    (await f.request("GET", `/api/businesses/${business.id}/requests`)).data
      .length,
    0,
  );
  const activity = await f.request(
    "GET",
    `/api/businesses/${business.id}/activity`,
  );
  assert.equal(activity.raw.includes(CREDENTIALS.ALPHA.authToken), false);
  assert.equal(
    activity.data.some((entry) => entry.kind === "sms_sent"),
    false,
  );
  assert.equal(
    (await f.send(business.id, contact.id)).status,
    409,
    "uncertain delivery cannot be retried into a duplicate SMS",
  );
  assert.equal(f.deliveries.length, 1);
});

test("a confirmed provider rejection can be corrected and retried without a false sent record", async (t) => {
  const f = await fixture(t, {
    sendSms: async (_message, count) => {
      if (count === 1)
        throw Object.assign(new Error("Invalid destination"), {
          status: 400,
          code: 21211,
        });
      return { sid: `SM${"6".repeat(32)}` };
    },
  });
  const business = await f.business();
  const contact = await f.contact(business.id);
  assert.ok((await f.send(business.id, contact.id)).status >= 400);
  assert.equal(
    (await f.request("GET", `/api/businesses/${business.id}/requests`)).data
      .length,
    0,
  );
  assert.equal((await f.send(business.id, contact.id)).status, 201);
  assert.equal(
    (await f.request("GET", `/api/businesses/${business.id}/requests`)).data
      .length,
    1,
  );
  assert.equal(f.deliveries.length, 2);
});

test("Twilio opt-out errors block every same-phone contact and pending follow-up in that business", async (t) => {
  const f = await fixture(t, {
    sendSms: async (_message, count) => {
      if (count === 2)
        throw Object.assign(new Error("Recipient opted out"), {
          status: 400,
          code: 21610,
        });
      return { sid: `SM${String(count).padStart(32, "0")}` };
    },
  });
  const alpha = await f.business("ALPHA");
  const beta = await f.business("BETA");
  const first = await f.contact(alpha.id, { name: "First contact" });
  const duplicate = await f.contact(alpha.id, { name: "Same phone" });
  await f.contact(beta.id, { name: "Other business" });
  assert.equal((await f.send(alpha.id, first.id)).status, 201);
  assert.equal((await f.send(alpha.id, duplicate.id)).status, 502);
  const contacts = (
    await f.request("GET", `/api/businesses/${alpha.id}/contacts`)
  ).data;
  assert.ok(contacts.every((contact) => contact.opted_out));
  assert.equal(
    (await f.request("GET", `/api/businesses/${beta.id}/contacts`)).data[0]
      .opted_out,
    false,
  );
  assert.equal((await f.send(alpha.id, duplicate.id)).status, 400);
  f.advance(3 * DAY);
  assert.equal((await f.runNudges()).sent, 0);
  assert.equal(f.deliveries.length, 2);
});

test("failed follow-ups stay unsent and are not automatically retried", async (t) => {
  const f = await fixture(t, {
    sendSms: async (_message, count) => {
      if (count > 1) throw new Error("Provider unavailable");
      return { sid: `SM${"5".repeat(32)}` };
    },
  });
  const business = await f.business();
  const contact = await f.contact(business.id);
  await f.send(business.id, contact.id);
  f.advance(3 * DAY);
  const firstRun = await f.runNudges();
  assert.equal(firstRun.sent, 0);
  assert.equal(firstRun.failed, 1);
  assert.equal(
    (await f.request("GET", `/api/businesses/${business.id}/requests`)).data[0]
      .status,
    "sent",
  );
  f.advance(DAY);
  await f.runNudges();
  assert.equal(
    f.deliveries.length,
    2,
    "one initial SMS and one failed follow-up attempt",
  );
});

test("rejected nudges remain visible for their business and an owner can retry once accepted", async (t) => {
  const f = await fixture(t, { sendSms: async (_message, count) => {
    if (count === 2) throw Object.assign(new Error("private provider details"), { status: 400, code: 21211 });
    return { sid: `SM${String(count).padStart(32, "0")}` };
  } });
  const alpha = await f.business();
  const beta = await f.business("BETA");
  const contact = await f.contact(alpha.id);
  const sent = await f.send(alpha.id, contact.id);
  const base = `/api/businesses/${alpha.id}`;
  const dashboard = async () => (await f.request("GET", `${base}/dashboard`)).data;
  assert.equal((await dashboard()).worker_last_checked_at, null);
  f.advance(3 * DAY);
  assert.equal((await f.runNudges()).failed, 1);
  let view = await dashboard();
  assert.equal(view.worker_last_checked_at, f.now().toISOString());
  assert.equal(view.awaiting_nudge, 0);
  assert.equal(view.attention_needed.length, 1);
  assert.equal(view.attention_needed[0].id, sent.data.id);
  assert.equal(view.attention_needed[0].retry_allowed, true);
  assert.doesNotMatch(JSON.stringify(view), /private provider details/);
  assert.deepEqual((await f.request("GET", `/api/businesses/${beta.id}/dashboard`)).data.attention_needed, []);
  assert.equal((await f.request("POST", `/api/businesses/${beta.id}/requests/${sent.data.id}/retry-nudge`, {})).status, 404);
  f.advance(DAY);
  assert.equal((await f.runNudges()).sent, 0, "failed nudge still never retries automatically");
  const retry = await f.request("POST", `${base}/requests/${sent.data.id}/retry-nudge`, {});
  assert.equal(retry.status, 200);
  assert.equal(retry.data.status, "nudged");
  assert.equal(retry.data.nudge_error, null);
  assert.equal(f.deliveries[2].accountSid, CREDENTIALS.ALPHA.accountSid);
  assert.match(f.deliveries[2].body, /Alpha Heating\nReply STOP to opt out$/);
  view = await dashboard();
  assert.deepEqual(view.attention_needed, []);
  assert.equal(view.total_requests, 1);
  assert.equal((await f.request("POST", `${base}/requests/${sent.data.id}/retry-nudge`, {})).status, 409);
  const activity = (await f.request("GET", `${base}/activity`)).data;
  assert.equal(activity.filter((entry) => entry.kind === "nudge_retry").length, 1);
  assert.equal(activity.filter((entry) => entry.kind === "sms_sent").length, 2);
  assert.equal(f.deliveries.length, 3);
});

test("another rejected retry stays visible and an uncertain retry cannot be repeated", async (t) => {
  const f = await fixture(t, { sendSms: async (_message, count) => {
    if (count === 4) throw new Error("Connection closed after submitting");
    if (count > 1) throw Object.assign(new Error("Rejected"), { status: 400, code: 21211 });
    return { sid: `SM${"3".repeat(32)}` };
  } });
  const business = await f.business();
  const contact = await f.contact(business.id);
  const sent = await f.send(business.id, contact.id);
  const base = `/api/businesses/${business.id}`;
  const retry = () => f.request("POST", `${base}/requests/${sent.data.id}/retry-nudge`, {});
  f.advance(3 * DAY);
  await f.runNudges();
  assert.equal((await retry()).status, 502);
  let attention = (await f.request("GET", `${base}/dashboard`)).data.attention_needed;
  assert.equal(attention.length, 1);
  assert.equal(attention[0].retry_allowed, true);
  assert.equal((await retry()).status, 502);
  attention = (await f.request("GET", `${base}/dashboard`)).data.attention_needed;
  assert.equal(attention.length, 1);
  assert.equal(attention[0].retry_allowed, false);
  assert.match(attention[0].retry_blocked_reason, /may already have been sent/);
  assert.equal((await retry()).status, 409);
  assert.equal((await f.runNudges()).sent, 0);
  assert.equal(f.deliveries.length, 4);
});

test("parallel manual retries send once and marking done during retry stays done", async (t) => {
  let finish;
  let started;
  const retryStarted = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { sendSms: async (_message, count) => {
    if (count === 2) throw Object.assign(new Error("Rejected"), { status: 400, code: 21211 });
    if (count === 3) { started(); return new Promise((resolve) => { finish = resolve; }); }
    return { sid: `SM${"3".repeat(32)}` };
  } });
  const business = await f.business();
  const contact = await f.contact(business.id);
  const sent = await f.send(business.id, contact.id);
  const base = `/api/businesses/${business.id}`;
  const path = `${base}/requests/${sent.data.id}`;
  f.advance(3 * DAY);
  await f.runNudges();
  const first = f.request("POST", `${path}/retry-nudge`, {});
  await Promise.race([retryStarted, first.then(() => { throw new Error("Retry returned without sending"); })]);
  try {
    assert.equal((await f.request("POST", `${path}/retry-nudge`, {})).status, 409);
    const attention = (await f.request("GET", `${base}/dashboard`)).data.attention_needed;
    assert.equal(attention.length, 1, "in-flight retry does not hide the original failure");
    assert.equal(attention[0].retry_allowed, false);
    assert.equal((await f.runNudges()).sent, 0);
    assert.equal((await f.request("POST", `${path}/done`, {})).status, 200);
  } finally {
    finish({ sid: `SM${"4".repeat(32)}` });
    const response = await first;
    assert.equal(response.status, 200);
    assert.equal(response.data.status, "done");
  }
  assert.equal(f.deliveries.length, 3);
  assert.deepEqual((await f.request("GET", `${base}/dashboard`)).data.attention_needed, []);
});

test("manual retry rechecks phone, consent, opt-out, credentials and request mode", async (t) => {
  for (const change of ["phone", "consent", "opt-out", "credentials", "mode", "done"]) {
    await t.test(change, async (t) => {
      const f = await fixture(t, { sendSms: async (_message, count) => {
        if (count > 1) throw Object.assign(new Error("Rejected"), { status: 400, code: 21211 });
        return { sid: `SM${"3".repeat(32)}` };
      } });
      const business = await f.business();
      const contact = await f.contact(business.id);
      const sent = await f.send(business.id, contact.id);
      const base = `/api/businesses/${business.id}`;
      f.advance(3 * DAY);
      await f.runNudges();
      if (change === "phone") {
        await f.request("PATCH", `${base}/contacts/${contact.id}`, { phone: "+14165550999" });
        await f.request("PATCH", `${base}/contacts/${contact.id}`, { sms_consent: true });
      } else if (change === "consent") await f.request("PATCH", `${base}/contacts/${contact.id}`, { sms_consent: false });
      else if (change === "opt-out") await f.request("PATCH", `${base}/contacts/${contact.id}`, { opted_out: true });
      else if (change === "credentials") f.setEnv("BUSINESS_ALPHA_AUTH_TOKEN", undefined);
      else if (change === "mode") f.db.prepare("UPDATE review_requests SET mode='demo' WHERE id=?").run(sent.data.id);
      else await f.request("POST", `${base}/requests/${sent.data.id}/done`, {});
      assert.equal((await f.request("POST", `${base}/requests/${sent.data.id}/retry-nudge`, {})).status, 409);
      assert.equal(f.deliveries.length, 2);
    });
  }
});

test("invalid phone numbers, URLs, tags, and missing consent are rejected before sending", async (t) => {
  const f = await fixture(t);
  const business = await f.business();
  const base = `/api/businesses/${business.id}`;
  assert.equal(
    (
      await f.request("PATCH", base, {
        google_review_url: "javascript:alert(1)",
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request("PATCH", base, { booking_url: "file:///etc/passwd" }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request("POST", `${base}/contacts`, {
        name: "Bad phone",
        phone: "123",
        sms_consent: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("POST", `${base}/contacts`, {
        name: "Bad tag",
        phone: "+14165550301",
        tags: ["administrator"],
      })
    ).status,
    400,
  );
  const noConsent = await f.contact(business.id, { sms_consent: false });
  assert.equal((await f.send(business.id, noConsent.id)).status, 400);
  assert.equal(f.deliveries.length, 0);
});

test("missing credentials fail safely without sending or creating a request", async (t) => {
  const f = await fixture(t);
  f.setEnv("BUSINESS_ALPHA_AUTH_TOKEN", undefined);
  const business = await f.business();
  assert.equal(business.sms_ready, false);
  const contact = await f.contact(business.id);
  const result = await f.send(business.id, contact.id);
  assert.ok(result.status >= 400);
  assert.equal(f.deliveries.length, 0);
  assert.equal(
    (await f.request("GET", `/api/businesses/${business.id}/requests`)).data
      .length,
    0,
  );
});

test("demo sends and time advancement never call Twilio", async (t) => {
  const f = await fixture(t, { smsMode: "demo" });
  const business = await f.business();
  const contact = await f.contact(business.id);
  assert.equal((await f.send(business.id, contact.id)).status, 201);
  const nudged = await f.request(
    "POST",
    `/api/businesses/${business.id}/demo/advance`,
    { days: 3 },
  );
  assert.equal(nudged.status, 200);
  const requests = await f.request(
    "GET",
    `/api/businesses/${business.id}/requests`,
  );
  assert.equal(requests.data[0].status, "nudged");
  assert.equal(f.deliveries.length, 0);
});

test("live mode rejects the demo time-advance endpoint", async (t) => {
  const f = await fixture(t);
  const business = await f.business();
  const contact = await f.contact(business.id);
  await f.send(business.id, contact.id);
  const result = await f.request(
    "POST",
    `/api/businesses/${business.id}/demo/advance`,
    { days: 3 },
  );
  assert.ok([400, 403, 404].includes(result.status));
  assert.equal(f.deliveries.length, 1);
  assert.equal(
    (await f.request("GET", `/api/businesses/${business.id}/requests`)).data[0]
      .status,
    "sent",
  );
});

test("switching a demo database to live mode cannot send real follow-ups to demo requests", async (t) => {
  const f = await fixture(t, { smsMode: "demo" });
  const business = await f.business();
  const contact = await f.contact(business.id);
  assert.equal((await f.send(business.id, contact.id)).status, 201);
  f.advance(4 * DAY);
  const live = createApp({
    dbPath: f.dbPath,
    uploadDir: f.uploadDir,
    smsMode: "twilio",
    now: f.now,
    sendSms: f.sendSms,
  });
  try {
    assert.equal((await live.runNudges()).sent, 0);
    assert.equal(f.deliveries.length, 0);
  } finally {
    await live.close();
  }
});

test("signed STOP webhook opts out only the matching business and invalid signatures do nothing", async (t) => {
  const f = await fixture(t);
  const alpha = await f.business("ALPHA");
  const beta = await f.business("BETA");
  const first = await f.contact(alpha.id);
  const second = await f.contact(beta.id);
  await f.send(alpha.id, first.id);
  await f.send(beta.id, second.id);
  const webhookPath = `/webhooks/twilio/${alpha.id}`;
  const parameters = {
    AccountSid: CREDENTIALS.ALPHA.accountSid,
    From: first.phone,
    To: CREDENTIALS.ALPHA.phoneNumber,
    Body: "STOP",
    OptOutType: "STOP",
  };
  const sendWebhook = (signature) =>
    fetch(`${f.baseUrl}${webhookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: new URLSearchParams(parameters).toString(),
    });
  assert.equal((await sendWebhook("invalid-signature")).status, 403);
  assert.equal(
    (await f.request("GET", `/api/businesses/${alpha.id}/contacts`)).data[0]
      .opted_out,
    false,
  );
  const payload =
    `https://trades.example.test${webhookPath}` +
    Object.keys(parameters)
      .sort()
      .map((key) => key + parameters[key])
      .join("");
  const signature = createHmac("sha1", CREDENTIALS.ALPHA.authToken)
    .update(payload)
    .digest("base64");
  assert.equal((await sendWebhook(signature)).status, 200);
  assert.equal(
    (await f.request("GET", `/api/businesses/${alpha.id}/contacts`)).data[0]
      .opted_out,
    true,
  );
  assert.equal(
    (await f.request("GET", `/api/businesses/${beta.id}/contacts`)).data[0]
      .opted_out,
    false,
  );
  f.advance(3 * DAY);
  assert.equal((await f.runNudges()).sent, 1);
  assert.equal(f.deliveries.length, 3);
  assert.equal(f.deliveries[2].businessId, beta.id);
});

test("a signed START reply restores an opted-out phone while a manual edit cannot", async (t) => {
  const f = await fixture(t);
  const business = await f.business();
  const contact = await f.contact(business.id, { opted_out: true });
  assert.equal(
    (
      await f.request(
        "PATCH",
        `/api/businesses/${business.id}/contacts/${contact.id}`,
        { opted_out: false },
      )
    ).status,
    400,
  );
  assert.equal((await f.send(business.id, contact.id)).status, 400);
  const webhookPath = `/webhooks/twilio/${business.id}`;
  const parameters = {
    AccountSid: CREDENTIALS.ALPHA.accountSid,
    From: contact.phone,
    To: CREDENTIALS.ALPHA.phoneNumber,
    Body: "START",
    OptOutType: "START",
  };
  const payload =
    `https://trades.example.test${webhookPath}` +
    Object.keys(parameters)
      .sort()
      .map((key) => key + parameters[key])
      .join("");
  const signature = createHmac("sha1", CREDENTIALS.ALPHA.authToken)
    .update(payload)
    .digest("base64");
  const response = await fetch(`${f.baseUrl}${webhookPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body: new URLSearchParams(parameters).toString(),
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await f.request("GET", `/api/businesses/${business.id}/contacts`)).data[0]
      .opted_out,
    false,
  );
  assert.equal((await f.send(business.id, contact.id)).status, 201);
  assert.equal(f.deliveries.length, 1);
});

test("cross-origin browser mutations are blocked", async (t) => {
  const f = await fixture(t);
  const result = await f.request(
    "POST",
    "/api/businesses",
    { name: "Unwanted shop", phone: "+14165550900" },
    { Origin: "https://unrelated.example.test" },
  );
  assert.equal(result.status, 403);
  assert.equal((await f.request("GET", "/api/businesses")).data.length, 0);
});
