import rateLimit from "express-rate-limit";
import { IS_HOSTED, PUBLIC_URL, TRUST_PROXY } from "../config.js";

// ---------------------------------------------------------------------------
// Trusted proxy configuration
// ---------------------------------------------------------------------------

export function configureTrustProxy(app) {
  // Express's trust proxy setting controls how req.ip is resolved.
  // We only set it if explicitly configured — never blindly trust arbitrary headers.
  if (TRUST_PROXY > 0) {
    app.set("trust proxy", TRUST_PROXY);
  } else {
    app.set("trust proxy", false);
  }
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

  if (origin) {
    try {
      if (new URL(origin).origin !== publicOrigin) {
        return res.status(403).json({ error: "Invalid Origin." });
      }
    } catch {
      return res.status(403).json({ error: "Invalid Origin." });
    }
  }

  next();
}

// ---------------------------------------------------------------------------
// Security headers (CSP + sensible defaults via inline logic)
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https://image.tmdb.org data:",
  "connect-src 'self'",
  "font-src 'self'",
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
