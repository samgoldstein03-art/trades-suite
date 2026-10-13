import { ipKeyGenerator, rateLimit } from "express-rate-limit";

// Only trust forwarding headers when deployment explicitly has one ingress
// proxy. Local/direct requests keep the socket address as their identity.
export function configureProxyTrust(app, env = process.env) {
  const hops = env.TRUST_PROXY_HOPS || "0";
  if (!/^[01]$/.test(hops)) {
    throw new Error("TRUST_PROXY_HOPS must be 0 (direct access) or 1 (one trusted ingress proxy).");
  }
  app.set("trust proxy", hops === "1" ? 1 : false);
}

const common = {
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Group IPv6 clients by subnet. The fallback also covers requests supplied
  // through in-memory HTTP streams, which have no network peer address.
  keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket?.remoteAddress || "unknown"),
};

export function createApiRateLimit() {
  return rateLimit({
    ...common,
    windowMs: 5 * 60 * 1000,
    limit: 300,
    identifier: "api",
    message: { error: "Too many requests. Please wait a few minutes and try again." },
  });
}

export function createAuthRateLimit() {
  return rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    identifier: "admin-sign-in",
    skipSuccessfulRequests: true,
    // Count failed sign-ins, not authenticated requests that later fail an API
    // validation check. Keep blocked attempts from extending the failed budget.
    requestWasSuccessful: (req, res) => res.statusCode !== 401,
    message: "Too many sign-in attempts. Please wait 15 minutes and try again.",
  });
}
