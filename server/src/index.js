import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { authRouter } from "./auth.js";
import { api } from "./routes/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, tmdb: !!process.env.TMDB_API_KEY })
);
app.use("/api/auth", authRouter);
app.use("/api", api);

// Serve the built web app (single-container deploy).
const webDist = process.env.WEB_DIST || path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) =>
    res.sendFile(path.join(webDist, "index.html"))
  );
}

// Error handler
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Something went wrong." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reelscore listening on :${PORT}`));
