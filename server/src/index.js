import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { authRouter, requireAuth } from "./auth.js";
import { providerAuthRouter } from "./provider-auth.js";
import { api } from "./routes/api.js";
import { admin } from "./routes/admin.js";
import { DATA_DIR, db, initializeDatabase } from "./db.js";
import { BOOTSTRAP_ADMIN_TOKEN, IS_HOSTED } from "./config.js";
import {
  configureTrustProxy,
  validateHostOrigin,
  securityHeaders,
  adminLimiter,
} from "./middleware/security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  // config.js is evaluated before this explicit first database access. Invalid
  // hosted configuration therefore cannot create, back up, or migrate a DB.
  if (IS_HOSTED && !BOOTSTRAP_ADMIN_TOKEN && !fs.existsSync(path.join(DATA_DIR, "reelscore.db"))) {
    throw new Error("[reelscore] FATAL: BOOTSTRAP_ADMIN_TOKEN is required for a fresh hosted database.");
  }
  initializeDatabase();
  if (IS_HOSTED && !BOOTSTRAP_ADMIN_TOKEN && db.prepare("SELECT COUNT(*) c FROM users").get().c === 0) {
    throw new Error("[reelscore] FATAL: BOOTSTRAP_ADMIN_TOKEN is required until the first administrator is created.");
  }
  const app = express();

  configureTrustProxy(app);

  app.get("/api/internal/health", (req, res) => {
    const address = req.socket.remoteAddress || "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) return res.sendStatus(404);
    return res.set("Cache-Control", "no-store").json({ ok: true });
  });

  app.use(securityHeaders);
  app.use(validateHostOrigin);
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
    next();
  });

  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, tmdb: !!process.env.TMDB_API_KEY })
  );

  // Auth routes: login, register, logout, /auth/me.
  app.use("/api/auth/provider", providerAuthRouter);
  app.use("/api/auth", authRouter);

  // All other /api routes require an active session.
  app.use("/api", requireAuth);
  app.use("/api", api);
  app.use("/api/admin", adminLimiter, admin);

  // Serve the built web app.
  const webDist =
    process.env.WEB_DIST || path.resolve(__dirname, "../../web/dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, (_req, res) =>
      res.sendFile(path.join(webDist, "index.html"))
    );
  }

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) {
      console.error(err);
      return res.status(status).json({ error: "Something went wrong." });
    }
    res.status(status).json({ error: err.message || "Something went wrong." });
  });

  return app;
}

// Only start the server when this file is the entry point.
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const PORT = process.env.PORT || 3000;
  createApp().listen(PORT, () => console.log(`Reelscore listening on :${PORT}`));
}
