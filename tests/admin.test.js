import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminAccess } from "../src/admin.js";
import { createApp } from "../src/app.js";

const password = "synthetic-admin-password-for-tests";
const hosted = { NODE_ENV: "production", RENDER_EXTERNAL_URL: "https://trades.example.test", ADMIN_PASSWORD: password };
const basic = (user = "admin", pass = password) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

test("hosted startup refuses a missing password, short password, or missing origin", () => {
  assert.throws(() => createAdminAccess({ ...hosted, ADMIN_PASSWORD: "" }), /ADMIN_PASSWORD/);
  assert.throws(() => createAdminAccess({ ...hosted, ADMIN_PASSWORD: "short" }), /ADMIN_PASSWORD/);
  assert.throws(() => createAdminAccess({ ...hosted, RENDER_EXTERNAL_URL: "" }), /ADMIN_ORIGIN/);
  assert.throws(() => createAdminAccess({ HOST: "0.0.0.0" }), /ADMIN_ORIGIN/);
  assert.doesNotThrow(() => createAdminAccess({}));
});

test("hosted origins use Render defaults and reject URLs containing secrets or paths", () => {
  const access = createAdminAccess(hosted);
  assert.equal(access.adminOrigin, hosted.RENDER_EXTERNAL_URL);
  assert.equal(access.webhookOrigin, hosted.RENDER_EXTERNAL_URL);
  assert.equal(createAdminAccess({ ...hosted, ADMIN_ORIGIN: "https://custom.example.test/" }).adminOrigin, "https://custom.example.test");
  for (const value of ["http://plain.example.test", "https://example.test/path", "https://user:secret@example.test", "https://example.test/?secret=x"]) {
    assert.throws(() => createAdminAccess({ ...hosted, ADMIN_ORIGIN: value }), (error) => !error.message.includes(value) && /HTTPS origin/.test(error.message));
  }
});

// Exercise the real Express route chain with in-memory HTTP streams. This
// checks the mounted access gate without opening a network listener.
function request(app, path, authorization, extra = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const req = new IncomingMessage(socket);
    req.method = extra.method || "GET"; req.url = path;
    req.headers = { host: "trades.example.test", ...(authorization ? { authorization } : {}), ...extra.headers };
    req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    res.on("error", reject);
    res.on("finish", () => { resolve({ status: res.statusCode, headers: res.getHeaders(), raw: Buffer.concat(chunks).toString() }); socket.destroy(); });
    app(req, res);
    req.push(null);
  });
}

test("hosted app gates pages, API and uploads while health and signed-webhook route remain reachable", async () => {
  const keys = ["NODE_ENV", "HOST", "RENDER_EXTERNAL_URL", "ADMIN_ORIGIN", "PUBLIC_BASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, hosted);
  const directory = await mkdtemp(join(tmpdir(), "trades-admin-test-"));
  let suite;
  try {
    suite = createApp({ dbPath: ":memory:", uploadDir: directory, smsMode: "demo" });
    for (const route of ["/", "/api/businesses", "/uploads/private.png"]) {
      const denied = await request(suite.app, route);
      assert.equal(denied.status, 401, route);
      assert.match(denied.headers["www-authenticate"], /^Basic /);
      assert.equal(denied.headers["cache-control"], "no-store");
    }
    for (const auth of [basic("wrong"), basic("admin", "wrong"), "Basic malformed", "Bearer abc"]) {
      assert.equal((await request(suite.app, "/api/businesses", auth)).status, 401);
    }
    const allowed = await request(suite.app, "/api/businesses", basic());
    assert.equal(allowed.status, 200);
    assert.ok(allowed.raw.endsWith("[]"));
    assert.equal((await request(suite.app, "/", basic())).status, 200);
    const health = await request(suite.app, "/healthz");
    assert.equal(health.status, 200);
    assert.ok(health.raw.endsWith('{"status":"ok"}'));
    const webhook = await request(suite.app, "/webhooks/twilio/unknown", undefined, { method: "POST" });
    assert.equal(webhook.status, 404); // reached the webhook's business check, not the admin password gate
    assert.equal((await request(suite.app, "/api/businesses", basic(), { headers: { origin: "https://unrelated.example.test" } })).status, 403);
  } finally {
    suite?.close();
    await rmdir(directory);
    for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
