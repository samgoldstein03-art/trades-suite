import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

const PASSWORD = "synthetic-pilot-legal-test-password";
const AUTH = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;

function request(app, path, { method = "GET", authenticated = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
    socket.remoteAddress = "192.0.2.80";
    const req = new IncomingMessage(socket);
    req.complete = true; req.method = method; req.url = path;
    req.headers = { host: "pilot.example.test", ...(authenticated ? { authorization: AUTH } : {}) };
    req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new ServerResponse(req); res.assignSocket(socket);
    const chunks = [];
    const write = res.write.bind(res), end = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Request timed out: ${method} ${path}`)); }, 3000);
    res.on("error", reject);
    res.on("finish", () => {
      clearTimeout(timer);
      const result = { status: res.statusCode, headers: res.getHeaders(), body: Buffer.concat(chunks).toString() };
      setImmediate(() => { resolve(result); socket.destroy(); });
    });
    app(req, res);
    req.push(null);
  });
}

async function fixture(t) {
  const keys = ["NODE_ENV", "HOST", "RENDER_EXTERNAL_URL", "ADMIN_ORIGIN", "PUBLIC_BASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "TRUST_PROXY_HOPS"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: "production", ADMIN_ORIGIN: "https://pilot.example.test", ADMIN_PASSWORD: PASSWORD });
  const directory = await mkdtemp(join(tmpdir(), "trades-pilot-legal-"));
  let suite;
  t.after(async () => {
    suite?.close();
    await rmdir(directory);
    for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  suite = createApp({ dbPath: ":memory:", uploadDir: directory, smsMode: "demo" });
  return (path, options) => request(suite.app, path, options);
}

test("legal drafts and their shared styles are public, explicitly unfinished, and safe to read with HEAD", async (t) => {
  const get = await fixture(t);
  for (const [path, title, type] of [["/terms", "Terms of Service", "terms"], ["/privacy", "Privacy Policy", "privacy"]]) {
    const page = await get(path);
    assert.equal(page.status, 200);
    assert.equal(page.headers["www-authenticate"], undefined);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.ok(page.body.includes(`<title>${title} draft | Tradesuite</title>`));
    assert.ok(page.body.includes(`data-legal-document="${type}"`));
    assert.match(page.body, /Draft\. Owner review required\./);
    assert.match(page.body, /owner-completion checklist, not (?:final Terms of Service|a final Privacy Policy)/);
    assert.match(page.body, /awaiting owner content and approval/);
    assert.match(page.body, /No effective date has been set/);
    assert.match(page.body, /href="\/terms"[^>]*>Terms draft<\/a>/);
    assert.match(page.body, /href="\/privacy"[^>]*>Privacy draft<\/a>/);
    assert.doesNotMatch(page.body, /<form|<input|<button|<script/i, "a review placeholder cannot act as a legal acceptance flow");
    const head = await get(path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.match(head.headers["content-type"], /^text\/html/);
  }
  const css = await get("/legal.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /^text\/css/);
  assert.match(css.body, /\.legal-document/);
  for (const path of ["/q/assets/fonts.css", "/q/assets/design-system.css"]) {
    const style = await get(path);
    assert.equal(style.status, 200, path);
    assert.match(style.headers["content-type"], /^text\/css/);
  }
});

test("public draft documents do not expose admin routes, uploads, mutations, or nearby files", async (t) => {
  const get = await fixture(t);
  for (const path of ["/", "/api/businesses", "/uploads/private.png", "/terms.html", "/privacy.html", "/terms/data", "/legal.css/private"]) {
    const denied = await get(path);
    assert.equal(denied.status, 401, path);
    assert.match(denied.headers["www-authenticate"], /^Basic /);
  }
  for (const path of ["/terms", "/privacy"]) {
    const denied = await get(path, { method: "POST" });
    assert.equal(denied.status, 401, path);
  }
  const businesses = await get("/api/businesses", { authenticated: true });
  assert.equal(businesses.status, 200);
  assert.equal(businesses.body, "[]", "reading draft pages creates no business data");
});
