process.env.DATA_DIR = `/tmp/rs-movie-http-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";
process.env.TMDB_API_KEY = "test-key";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

let tmdbServer, appServer, appOrigin;

before(async () => {
  tmdbServer = createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    if (url.pathname !== "/movie/603") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status_message: "Not found" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: 603,
      title: "The Matrix",
      release_date: "1999-03-30",
      runtime: 136,
      vote_average: 8.2,
      poster_path: null,
      backdrop_path: null,
      overview: "A hacker learns the truth about his reality.",
      genres: [{ name: "Science Fiction" }],
      belongs_to_collection: null,
      credits: { cast: [{ id: 6384, name: "Keanu Reeves", order: 0 }], crew: [] },
    }));
  });
  await new Promise((resolve) => tmdbServer.listen(0, "127.0.0.1", resolve));
  process.env.TMDB_BASE_URL = `http://127.0.0.1:${tmdbServer.address().port}`;

  const { startTestServer, parseCookies } = await import("./helpers/server.js");
  appServer = await startTestServer();
  const registered = await fetch(`${appServer.base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "movie_route", password: "a sufficiently long password" }),
  });
  assert.equal(registered.status, 200, await registered.text());
  const cookies = parseCookies(registered);
  appOrigin = { cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; ") };
  const [{ db }, { insertWatch }] = await Promise.all([
    import("../src/db.js"),
    import("../src/repositories/watch-repository.js"),
  ]);
  const owner = db.prepare("SELECT id FROM users WHERE username=?").get("movie_route");
  insertWatch({
    userId: owner.id,
    movie: { id: 603, title: "The Matrix", release_date: "1999-03-30", genres: [] },
    source: "letterboxd",
    watchedAt: "2026-08-01T12:00:00.000Z",
    competitionEligibility: "unverified_import",
    sourceRecordedDate: "2026-08-01",
    sourceDateKind: "marked_watched_day",
    importSource: "letterboxd",
    importEventKey: "movie-http-marked-watched",
  });
});

after(async () => {
  if (appServer) await appServer.close();
  if (tmdbServer) await new Promise((resolve) => tmdbServer.close(resolve));
});

test("authenticated movie detail renders curated people instead of failing at runtime", async () => {
  const response = await fetch(`${appServer.base}/api/movie/603`, { headers: appOrigin });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.title, "The Matrix");
  assert.deepEqual(body.notable_people, [{ id: 6384, name: "Keanu Reeves", role: "actor" }]);
  assert.equal(body.my_watches[0].source_date_kind, "marked_watched_day");
  assert.equal(body.my_watches[0].source_recorded_date, "2026-08-01");
});
