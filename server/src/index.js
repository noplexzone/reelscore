import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { authRouter, requireAuth } from "./auth.js";
import { api } from "./routes/api.js";
import { admin } from "./routes/admin.js";
import {
  configureTrustProxy,
  validateHostOrigin,
  securityHeaders,
  adminLimiter,
} from "./middleware/security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  configureTrustProxy(app);

  app.use(securityHeaders);
  app.use(validateHostOrigin);
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, tmdb: !!process.env.TMDB_API_KEY })
  );

  // Auth routes: login, register, logout, /auth/me.
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
