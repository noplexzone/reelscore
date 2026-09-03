import rateLimit from "express-rate-limit";
import { BlockList, isIP } from "node:net";
import { IS_HOSTED, PUBLIC_URL, TRUSTED_PROXY_CIDRS } from "../config.js";

// ---------------------------------------------------------------------------
// Trusted proxy configuration
// ---------------------------------------------------------------------------

export function configureTrustProxy(app) {
  const trusted = new BlockList();
  for (const cidr of TRUSTED_PROXY_CIDRS) {
    const [address, prefix] = cidr.split("/");
    trusted.addSubnet(address, Number(prefix), isIP(address) === 4 ? "ipv4" : "ipv6");
  }
  app.set("trust proxy", (remoteAddress) => {
    const address = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;
    const family = isIP(address);
    return family ? trusted.check(address, family === 4 ? "ipv4" : "ipv6") : false;
  });
}

// ---------------------------------------------------------------------------
// Host/Origin validation (hosted mode only)
// ---------------------------------------------------------------------------

export function validateHostOrigin(req, res, next) {
  if (!IS_HOSTED) return next();

  const publicOrigin = new URL(PUBLIC_URL).origin;
  const publicHost = new URL(PUBLIC_URL).host;
  const host = req.headers["host"] || "";
  const origin = req.headers["origin"] || "";

  if (host !== publicHost) {
    return res.status(400).json({ error: "Invalid Host." });
  }

  const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (mutation && origin !== publicOrigin) {
    return res.status(403).json({ error: "Invalid Origin." });
  }
  if (origin && origin !== publicOrigin) {
    return res.status(403).json({ error: "Invalid Origin." });
  }

  next();
}

// ---------------------------------------------------------------------------
// Security headers (CSP + sensible defaults via inline logic)
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' https://image.tmdb.org data:",
  "connect-src 'self'",
  "font-src 'self' https://fonts.gstatic.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0"); // Modern browsers use CSP instead
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()"
  );
  if (IS_HOSTED) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
  next();
}

// ---------------------------------------------------------------------------
// Admin rate limiter
// ---------------------------------------------------------------------------

export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
