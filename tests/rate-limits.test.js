import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import express from "express";
import { createAdminAccess } from "../src/admin.js";
import { createApp } from "../src/app.js";
import { configureProxyTrust, createApiRateLimit } from "../src/rate-limits.js";

const password = "synthetic-password-for-rate-limit-tests";
const basic = (value = password) => `Basic ${Buffer.from(`admin:${value}`).toString("base64")}`;

// Use actual Express request/response streams without requiring a TCP port.
function request(app, path, { ip = "192.0.2.10", authorization, forwarded } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    socket.remoteAddress = ip;
    const req = new IncomingMessage(socket);
    req.method = "GET";
    req.url = path;
    req.headers = {
      host: "localhost",
      ...(authorization ? { authorization } : {}),
      ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
    };
    req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    res.on("error", reject);
    res.on("finish", () => {
      // Let the limiter's async successful-response decrement settle first.
      setImmediate(() => {
        resolve({ status: res.statusCode, headers: res.getHeaders(), raw: Buffer.concat(chunks).toString() });
        socket.destroy();
      });
    });
    app(req, res);
    req.push(null);
  });
}

function protectedApp(env = {}) {
  const app = express();
  configureProxyTrust(app, env);
  app.use("/api", createApiRateLimit());
  app.use(createAdminAccess({ ADMIN_PASSWORD: password }).middleware);
  app.get(["/", "/api/businesses", "/uploads/example.png"], (req, res) => res.json({ ok: true }));
  return app;
}

test("the actual app limits API requests per client while health stays available", async () => {
  const keys = ["NODE_ENV", "HOST", "RENDER_EXTERNAL_URL", "ADMIN_ORIGIN", "PUBLIC_BASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "TRUST_PROXY_HOPS"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  let suite;
  try {
    suite = createApp({ dbPath: ":memory:", smsMode: "demo" });
    for (let i = 0; i < 300; i++) {
      assert.equal((await request(suite.app, "/api/businesses")).status, 200);
    }
    const blocked = await request(suite.app, "/api/businesses");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    assert.match(blocked.raw, /Too many requests/);
    assert.equal((await request(suite.app, "/api/config", { forwarded: "198.51.100.30" })).status, 429);
    assert.equal((await request(suite.app, "/api/businesses", { ip: "192.0.2.11" })).status, 200);
    assert.equal((await request(suite.app, "/healthz")).status, 200);
  } finally {
    suite?.close();
    for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("failed Basic sign-ins share one strict budget across pages, API and uploads", async () => {
  const app = protectedApp();
  for (let i = 0; i < 30; i++) {
    assert.equal((await request(app, "/api/businesses", { authorization: basic() })).status, 200);
  }
  const routes = ["/", "/api/businesses", "/uploads/example.png"];
  for (let i = 0; i < 10; i++) {
    assert.equal((await request(app, routes[i % routes.length], { authorization: basic("wrong"), forwarded: `198.51.100.${i + 1}` })).status, 401);
  }
  const blocked = await request(app, "/", { authorization: basic("wrong") });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
  assert.equal((await request(app, "/api/businesses", { authorization: basic(), forwarded: "203.0.113.5" })).status, 429);
  assert.equal((await request(app, "/", { ip: "192.0.2.12", authorization: basic() })).status, 200);
});

test("an explicitly trusted ingress uses the nearest client address and ignores spoofed prefixes", async () => {
  const app = protectedApp({ TRUST_PROXY_HOPS: "1" });
  for (let i = 0; i < 10; i++) {
    assert.equal((await request(app, "/", { forwarded: `203.0.113.${i + 1}, 198.51.100.10` })).status, 401);
  }
  assert.equal((await request(app, "/", { forwarded: "203.0.113.250, 198.51.100.10" })).status, 429);
  assert.equal((await request(app, "/", { forwarded: "203.0.113.250, 198.51.100.11", authorization: basic() })).status, 200);
  for (const value of ["true", "2", "all", "-1"]) {
    assert.throws(() => configureProxyTrust(express(), { TRUST_PROXY_HOPS: value }), /TRUST_PROXY_HOPS/);
  }
});

test("rotating IPv6 addresses in one subnet cannot bypass the sign-in limit", async () => {
  const app = protectedApp();
  for (let i = 0; i < 10; i++) {
    assert.equal((await request(app, "/", { ip: `2001:db8:1234:5600::${i + 1}` })).status, 401);
  }
  assert.equal((await request(app, "/", { ip: "2001:db8:1234:56ff::99" })).status, 429);
  assert.equal((await request(app, "/", { ip: "2001:db8:1234:5700::99", authorization: basic() })).status, 200);
});
