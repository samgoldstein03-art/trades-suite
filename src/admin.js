import { createHash, timingSafeEqual } from "node:crypto";
import { createAuthRateLimit } from "./rate-limits.js";

const local = (host) => /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(host);

function origin(value, label) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error(`${label} must be an HTTPS origin without a path, query, or credentials.`);
  }
}

const digest = (value) => createHash("sha256").update(value).digest();

// One shared admin gate. Businesses still have no individual logins.
export function createAdminAccess(env = process.env) {
  const adminOrigin = origin(env.ADMIN_ORIGIN || env.RENDER_EXTERNAL_URL, "ADMIN_ORIGIN");
  const webhookOrigin = origin(env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL, "PUBLIC_BASE_URL");
  const hosted = env.NODE_ENV === "production" || !local(env.HOST || "127.0.0.1") ||
    Boolean(adminOrigin && !local(new URL(adminOrigin).hostname));
  const username = env.ADMIN_USERNAME || "admin";
  const password = env.ADMIN_PASSWORD || "";
  if (hosted && !adminOrigin) throw new Error("Set ADMIN_ORIGIN to the app's HTTPS address before serving it publicly.");
  if ((hosted || password) && password.length < 16)
    throw new Error("Set ADMIN_PASSWORD to a unique password of at least 16 characters before serving the app publicly.");
  if (!username.trim() || /[:\r\n]/.test(username)) throw new Error("ADMIN_USERNAME must be a nonempty name without colons or line breaks.");
  const expectedUser = digest(username);
  const expectedPassword = digest(password);
  const authRateLimit = password ? createAuthRateLimit() : null;
  return {
    adminOrigin,
    webhookOrigin,
    middleware(req, res, next) {
      if (!password) return next();
      res.set("Cache-Control", "no-store");
      return authRateLimit(req, res, () => {
        const authorization = req.get("authorization") || "";
        const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)?.[1];
        let user = "", supplied = "";
        if (encoded && encoded.length <= 4096) {
          const value = Buffer.from(encoded, "base64").toString("utf8");
          const separator = value.indexOf(":");
          if (separator >= 0) {
            user = value.slice(0, separator);
            supplied = value.slice(separator + 1);
          }
        }
        const userMatches = timingSafeEqual(digest(user), expectedUser);
        const passwordMatches = timingSafeEqual(digest(supplied), expectedPassword);
        if (userMatches && passwordMatches) return next();
        res.set("WWW-Authenticate", 'Basic realm="Tradesuite admin", charset="UTF-8"');
        return res.status(401).type("text/plain").send("Sign in with your Tradesuite admin name and password.");
      });
    },
  };
}
