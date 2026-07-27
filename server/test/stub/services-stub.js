// Minimal Trakt + Plex API stub for local/manual testing of connections.
// Run:  node server/test/stub/services-stub.js   (port 3556, override with SERVICES_STUB_PORT)
// Point the app at it with TRAKT_BASE_URL=http://localhost:3556 and use
// http://localhost:3556 as the Plex server URL (any token works).
import http from "http";

// Trakt history: Tom Hanks films (13/8358/857/862 → completes his stub
// filmography) plus The Matrix (603) to verify a manual log.
const TRAKT_HISTORY = [
  { watched_at: "2019-01-01T20:00:00.000Z", movie: { title: "Forrest Gump", ids: { tmdb: 13 } } },
  { watched_at: "2020-05-05T21:00:00.000Z", movie: { title: "Cast Away", ids: { tmdb: 8358 } } },
  { watched_at: "2020-07-07T21:00:00.000Z", movie: { title: "Saving Private Ryan", ids: { tmdb: 857 } } },
  { watched_at: "2021-02-02T19:30:00.000Z", movie: { title: "Toy Story", ids: { tmdb: 862 } } },
  { watched_at: new Date().toISOString(), movie: { title: "The Matrix", ids: { tmdb: 603 } } },
];

// Plex library: Matrix Reloaded (604, new → completes the Matrix series) and
// Revolutions (605, verifies the manual log made today).
const PLEX_MOVIES = [
  { title: "The Matrix Reloaded", viewCount: 2, lastViewedAt: 1650000000, Guid: [{ id: "tmdb://604" }] },
  { title: "The Matrix Revolutions", viewCount: 1, lastViewedAt: Math.floor(Date.now() / 1000), Guid: [{ id: "tmdb://605" }] },
  { title: "Unwatched Film", viewCount: 0, Guid: [{ id: "tmdb://550" }] },
  { title: "No TMDB Guid", viewCount: 3, lastViewedAt: 1650000000, Guid: [{ id: "imdb://tt123" }] },
];

function json(res, code, data) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  // ---- Trakt ----
  if (p === "/oauth/device/code")
    return json(res, 200, {
      device_code: "stub-device-code",
      user_code: "STUB1234",
      verification_url: "https://trakt.tv/activate",
      interval: 1,
      expires_in: 600,
    });
  if (p === "/oauth/device/token")
    return json(res, 200, { access_token: "stub-access", refresh_token: "stub-refresh" });
  if (p === "/users/settings") return json(res, 200, { user: { username: "stubwatcher" } });
  if (p === "/sync/history/movies") {
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    return json(res, 200, page === 1 ? TRAKT_HISTORY : []);
  }

  // ---- Plex ----
  if (p === "/identity") return json(res, 200, { MediaContainer: { friendlyName: "Stub Plex" } });
  if (p === "/library/sections")
    return json(res, 200, { MediaContainer: { Directory: [{ key: "1", type: "movie", title: "Movies" }] } });
  if (p === "/library/sections/1/all") {
    const start = parseInt(url.searchParams.get("X-Plex-Container-Start") || "0", 10);
    return json(res, 200, { MediaContainer: { Metadata: start === 0 ? PLEX_MOVIES : [] } });
  }

  json(res, 404, { error: "Stub: no route for " + p });
});

const PORT = process.env.SERVICES_STUB_PORT || 3556;
server.listen(PORT, () => console.log(`Trakt/Plex stub listening on :${PORT}`));
