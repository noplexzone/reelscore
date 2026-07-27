import { Router } from "express";
import { db, totalScore, watchCount, currentStreak } from "../db.js";
import { requireAuth } from "../auth.js";
import { searchMovies, movieDetails, collectionDetails } from "../tmdb.js";
import { watchPoints, basePoints } from "../scoring.js";
import { evaluate, progress } from "../achievements.js";
import { parsePositiveInt } from "../validation.js";

export const api = Router();
api.use(requireAuth);

// Soft anti-abuse cap: no more than 26h of logged runtime per calendar day.
const DAILY_RUNTIME_CAP_MIN = 26 * 60;

function userSummary(u) {
  return {
    id: u.id,
    username: u.username,
    score: totalScore(u.id),
    watches: watchCount(u.id),
    streak: currentStreak(u.id),
    public_profile: !!u.public_profile,
  };
}

// ---- Me -----------------------------------------------------------------
api.get("/me", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  res.json(userSummary(u));
});

api.post("/me/settings", (req, res) => {
  const pub = req.body?.public_profile ? 1 : 0;
  db.prepare("UPDATE users SET public_profile = ? WHERE id = ?").run(pub, req.user.id);
  res.json({ public_profile: !!pub });
});

// ---- Movies -------------------------------------------------------------
api.get("/search", async (req, res, next) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json({ results: [] });
    const data = await searchMovies(q, req.query.page || 1);
    res.json({
      results: (data.results || []).slice(0, 20).map((m) => ({
        id: m.id,
        title: m.title,
        release_date: m.release_date,
        poster_path: m.poster_path,
        vote_average: m.vote_average,
        overview: m.overview,
      })),
    });
  } catch (e) {
    next(e);
  }
});

api.get("/movie/:id", async (req, res, next) => {
  const tmdbId = parsePositiveInt(req.params.id);
  if (!tmdbId) return res.status(400).json({ error: "Invalid movie ID." });
  try {
    const m = await movieDetails(tmdbId);
    const watched = db
      .prepare(
        "SELECT id, watched_at, points FROM watches WHERE user_id = ? AND tmdb_id = ? ORDER BY watched_at DESC"
      )
      .all(req.user.id, m.id);
    res.json({
      id: m.id,
      title: m.title,
      overview: m.overview,
      release_date: m.release_date,
      runtime: m.runtime,
      vote_average: m.vote_average,
      poster_path: m.poster_path,
      backdrop_path: m.backdrop_path,
      genres: (m.genres || []).map((g) => g.name),
      collection: m.belongs_to_collection
        ? { id: m.belongs_to_collection.id, name: m.belongs_to_collection.name }
        : null,
      potential_points: basePoints({ voteAverage: m.vote_average, runtime: m.runtime }),
      my_watches: watched,
    });
  } catch (e) {
    next(e);
  }
});

api.get("/collection/:id", async (req, res, next) => {
  const colId = parsePositiveInt(req.params.id);
  if (!colId) return res.status(400).json({ error: "Invalid collection ID." });
  try {
    const col = await collectionDetails(colId);
    const watchedIds = new Set(
      db
        .prepare("SELECT DISTINCT tmdb_id FROM watches WHERE user_id = ?")
        .all(req.user.id)
        .map((r) => r.tmdb_id)
    );
    const today = new Date().toISOString().slice(0, 10);
    res.json({
      id: col.id,
      name: col.name,
      parts: (col.parts || [])
        .filter((p) => p.release_date && p.release_date <= today)
        .sort((a, b) => (a.release_date < b.release_date ? -1 : 1))
        .map((p) => ({
          id: p.id,
          title: p.title,
          release_date: p.release_date,
          poster_path: p.poster_path,
          watched: watchedIds.has(p.id),
        })),
    });
  } catch (e) {
    next(e);
  }
});

// ---- Watches ------------------------------------------------------------
api.post("/watches", async (req, res, next) => {
  try {
    const tmdbId = parsePositiveInt(req.body?.tmdb_id);
    if (!tmdbId) return res.status(400).json({ error: "tmdb_id must be a positive integer." });

    const m = await movieDetails(tmdbId);

    // Daily runtime cap
    const loggedToday = db
      .prepare(
        `SELECT COALESCE(SUM(runtime),0) s FROM watches
         WHERE user_id = ? AND date(watched_at) = date('now')`
      )
      .get(req.user.id).s;
    if (loggedToday + (m.runtime || 100) > DAILY_RUNTIME_CAP_MIN) {
      return res.status(429).json({
        error: "Daily limit reached. Even the projectionist sleeps — come back tomorrow.",
      });
    }

    const prior = db
      .prepare(
        "SELECT watched_at FROM watches WHERE user_id = ? AND tmdb_id = ? ORDER BY watched_at DESC"
      )
      .all(req.user.id, tmdbId)
      .map((r) => r.watched_at);

    const { points, isRewatch, reason } = watchPoints({
      voteAverage: m.vote_average,
      runtime: m.runtime,
      priorWatches: prior,
    });

    const info = db
      .prepare(
        `INSERT INTO watches
         (user_id, tmdb_id, title, poster_path, vote_average, runtime, release_date,
          genres, collection_id, collection_name, points, is_rewatch, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
      )
      .run(
        req.user.id,
        m.id,
        m.title,
        m.poster_path,
        m.vote_average,
        m.runtime,
        m.release_date,
        JSON.stringify((m.genres || []).map((g) => g.name)),
        m.belongs_to_collection?.id || null,
        m.belongs_to_collection?.name || null,
        points,
        isRewatch ? 1 : 0
      );

    const newAchievements = await evaluate(req.user.id, {
      collection_id: m.belongs_to_collection?.id || null,
    });

    res.json({
      watch: { id: info.lastInsertRowid, title: m.title, points, isRewatch, reason },
      new_achievements: newAchievements,
      score: totalScore(req.user.id),
    });
  } catch (e) {
    next(e);
  }
});

api.get("/watches", (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, tmdb_id, title, poster_path, points, is_rewatch, watched_at
       FROM watches WHERE user_id = ? ORDER BY watched_at DESC LIMIT 100`
    )
    .all(req.user.id);
  res.json({ watches: rows });
});

api.delete("/watches/:id", (req, res) => {
  const watchId = parsePositiveInt(req.params.id);
  if (!watchId) return res.status(400).json({ error: "Invalid watch ID." });
  const result = db
    .prepare("DELETE FROM watches WHERE id = ? AND user_id = ?")
    .run(watchId, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: "Watch entry not found." });
  res.json({ ok: true });
});

// ---- Achievements -------------------------------------------------------
api.get("/achievements", (req, res) => {
  const unlocked = db
    .prepare(
      "SELECT key, name, description, points, unlocked_at FROM achievements WHERE user_id = ? ORDER BY unlocked_at DESC"
    )
    .all(req.user.id);
  res.json({ unlocked, progress: progress(req.user.id) });
});

// ---- Social -------------------------------------------------------------
api.post("/friends/request", (req, res) => {
  const username = (req.body?.username || "").toString();
  const target = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (!target) return res.status(404).json({ error: "No user with that name." });
  if (target.id === req.user.id)
    return res.status(400).json({ error: "That's you. You're already friends with you." });
  const [a, b] = [Math.min(req.user.id, target.id), Math.max(req.user.id, target.id)];
  const existing = db
    .prepare("SELECT * FROM friends WHERE user_id = ? AND friend_id = ?")
    .get(a, b);
  if (existing)
    return res.status(409).json({
      error: existing.status === "accepted" ? "Already friends." : "Request already pending.",
    });
  db.prepare(
    "INSERT INTO friends (user_id, friend_id, status, requested_by) VALUES (?, ?, 'pending', ?)"
  ).run(a, b, req.user.id);
  res.json({ ok: true });
});

api.post("/friends/respond", (req, res) => {
  const otherId = parsePositiveInt(String(req.body?.user_id ?? ""));
  if (!otherId) return res.status(400).json({ error: "user_id must be a positive integer." });
  const accept = !!req.body?.accept;
  const [a, b] = [Math.min(req.user.id, otherId), Math.max(req.user.id, otherId)];
  const row = db
    .prepare(
      "SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = 'pending'"
    )
    .get(a, b);
  if (!row || row.requested_by === req.user.id)
    return res.status(404).json({ error: "No pending request from that user." });
  if (accept) {
    db.prepare(
      "UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ?"
    ).run(a, b);
  } else {
    db.prepare("DELETE FROM friends WHERE user_id = ? AND friend_id = ?").run(a, b);
  }
  res.json({ ok: true });
});

function friendIds(userId) {
  return db
    .prepare(
      `SELECT CASE WHEN user_id = ? THEN friend_id ELSE user_id END fid
       FROM friends WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'`
    )
    .all(userId, userId, userId)
    .map((r) => r.fid);
}

api.get("/friends", (req, res) => {
  const ids = friendIds(req.user.id);
  const friends = ids.map((id) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return userSummary(u);
  });
  const pending = db
    .prepare(
      `SELECT f.*, u.username FROM friends f
       JOIN users u ON u.id = f.requested_by
       WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'pending' AND f.requested_by != ?`
    )
    .all(req.user.id, req.user.id, req.user.id)
    .map((r) => ({ user_id: r.requested_by, username: r.username }));
  friends.sort((x, y) => y.score - x.score);
  res.json({ friends, pending });
});

api.get("/feed", (req, res) => {
  const ids = friendIds(req.user.id);
  if (ids.length === 0) return res.json({ feed: [] });
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT w.title, w.poster_path, w.points, w.watched_at, w.tmdb_id, u.username
       FROM watches w JOIN users u ON u.id = w.user_id
       WHERE w.user_id IN (${placeholders})
       ORDER BY w.watched_at DESC LIMIT 50`
    )
    .all(...ids);
  res.json({ feed: rows });
});

api.get("/users/:username", (req, res) => {
  const u = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(req.params.username);
  if (!u) return res.status(404).json({ error: "User not found." });
  const isFriend = friendIds(req.user.id).includes(u.id);
  const isSelf = u.id === req.user.id;
  if (!u.public_profile && !isFriend && !isSelf) {
    return res.status(403).json({ error: "This profile is private." });
  }
  const recent = db
    .prepare(
      `SELECT title, poster_path, points, watched_at, tmdb_id FROM watches
       WHERE user_id = ? ORDER BY watched_at DESC LIMIT 12`
    )
    .all(u.id);
  const trophies = db
    .prepare(
      `SELECT name, description, points, unlocked_at FROM achievements
       WHERE user_id = ? ORDER BY points DESC LIMIT 12`
    )
    .all(u.id);
  res.json({ ...userSummary(u), recent, trophies, is_friend: isFriend });
});
