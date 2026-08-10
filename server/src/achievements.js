import { db, currentStreak } from "./db.js";
import { collectionDetails, personDetails, personMovieCredits } from "./tmdb.js";
import { curatedPerson, filterFilmography, personBonus } from "./people.js";
import { awardScoreEvent } from "./repositories/score-ledger.js";

// ---- Achievement catalog (v1) -------------------------------------------
// Tiered achievements generated from metadata. Series completion is dynamic
// (one achievement per TMDB collection). Completions are permanent: if TMDB
// later adds a film to a completed collection, the trophy stays unlocked.

export const VOLUME_TIERS = [
  { n: 1,   points: 25,  name: "Opening Night",   desc: "Log your first film" },
  { n: 10,  points: 50,  name: "Regular",         desc: "Log 10 films" },
  { n: 50,  points: 150, name: "Cinephile",       desc: "Log 50 films" },
  { n: 100, points: 300, name: "Projectionist",   desc: "Log 100 films" },
  { n: 250, points: 750, name: "The Archive",     desc: "Log 250 films" },
];

export const GENRE_TIERS = [
  { n: 10, points: 75 },
  { n: 25, points: 200 },
  { n: 50, points: 400 },
];

export const DECADE_TIERS = [
  { n: 5,  points: 150, name: "Time Traveler",  desc: "Watch films from 5 different decades" },
  { n: 8,  points: 350, name: "Century Pass",   desc: "Watch films from 8 different decades" },
  { n: 11, points: 700, name: "Full Reel of History", desc: "Watch films from 11 different decades" },
];

export const STREAK_TIERS = [
  { n: 3,  points: 50,  name: "Triple Feature",   desc: "Watch films 3 days in a row" },
  { n: 7,  points: 150, name: "Weeklong Premiere", desc: "Watch films 7 days in a row" },
  { n: 30, points: 600, name: "Resident Critic",  desc: "Watch films 30 days in a row" },
];

function unlock(userId, key, name, description, points) {
  return db.transaction(() => {
    const res = db.prepare(`INSERT OR IGNORE INTO achievements (user_id, key, name, description, points)
      VALUES (?, ?, ?, ?, ?)`).run(userId, key, name, description, points);
    if (res.changes === 0) return null;
    const achievementId = Number(res.lastInsertRowid);
    const event = awardScoreEvent({
      eventKey: `achievement/${achievementId}/legacy-runtime`,
      userId,
      achievementId,
      category: "legacy_achievement",
      points,
      ruleVersion: "legacy-runtime-v1",
      metadata: { key, name, stored_points: points, reason: "legacy_permanent_unlock" },
    });
    db.prepare("UPDATE achievements SET score_event_id=? WHERE id=?").run(event.id, achievementId);
    return { key, name, description, points };
  })();
}

// Evaluate all achievement rules after a watch is logged.
// Returns the list of newly unlocked achievements.
export async function evaluate(userId, watch) {
  const unlocked = [];
  const push = (a) => a && unlocked.push(a);

  // Volume
  const count = db
    .prepare("SELECT COUNT(*) c FROM watches WHERE user_id = ?")
    .get(userId).c;
  for (const t of VOLUME_TIERS) {
    if (count >= t.n) push(unlock(userId, `volume:${t.n}`, t.name, t.desc, t.points));
  }

  // Genres (first watch of each film counts once per film per genre)
  const genreCounts = {};
  const seen = new Set();
  const allWatches = db
    .prepare("SELECT DISTINCT tmdb_id, genres FROM watches WHERE user_id = ?")
    .all(userId);
  for (const w of allWatches) {
    if (seen.has(w.tmdb_id)) continue;
    seen.add(w.tmdb_id);
    let gs = [];
    try { gs = JSON.parse(w.genres || "[]"); } catch {}
    for (const g of gs) genreCounts[g] = (genreCounts[g] || 0) + 1;
  }
  for (const [genre, n] of Object.entries(genreCounts)) {
    for (const t of GENRE_TIERS) {
      if (n >= t.n) {
        push(
          unlock(
            userId,
            `genre:${genre}:${t.n}`,
            `${genre} ${t.n === 10 ? "Fan" : t.n === 25 ? "Devotee" : "Scholar"}`,
            `Watch ${t.n} ${genre} films`,
            t.points
          )
        );
      }
    }
  }

  // Decades
  const decades = new Set(
    db
      .prepare(
        `SELECT DISTINCT (CAST(substr(release_date,1,4) AS INTEGER)/10)*10 d
         FROM watches WHERE user_id = ? AND release_date IS NOT NULL AND release_date != ''`
      )
      .all(userId)
      .map((r) => r.d)
      .filter((d) => d >= 1880)
  );
  for (const t of DECADE_TIERS) {
    if (decades.size >= t.n) push(unlock(userId, `decades:${t.n}`, t.name, t.desc, t.points));
  }

  // Streaks
  const streak = currentStreak(userId);
  for (const t of STREAK_TIERS) {
    if (streak >= t.n) push(unlock(userId, `streak:${t.n}`, t.name, t.desc, t.points));
  }

  // Series completion (TMDB collection)
  if (watch.collection_id) {
    try {
      const col = await collectionDetails(watch.collection_id);
      const today = new Date().toISOString().slice(0, 10);
      const releasedParts = (col.parts || []).filter(
        (p) => p.release_date && p.release_date <= today
      );
      if (releasedParts.length >= 2) {
        const watchedIds = new Set(
          db
            .prepare("SELECT DISTINCT tmdb_id FROM watches WHERE user_id = ?")
            .all(userId)
            .map((r) => r.tmdb_id)
        );
        const complete = releasedParts.every((p) => watchedIds.has(p.id));
        if (complete) {
          const bonus = 250 + 50 * releasedParts.length;
          push(
            unlock(
              userId,
              `series:${watch.collection_id}`,
              `Series Complete: ${col.name.replace(/ Collection$/i, "")}`,
              `Watched all ${releasedParts.length} released films`,
              bonus
            )
          );
        }
      }
    } catch {
      // TMDB hiccup — series check will re-run on the next logged watch.
    }
  }

  // Filmography completion for curated actors/directors in this film
  for (const pid of watch.person_ids || []) {
    try {
      const a = await checkPersonCompletion(userId, pid);
      push(a);
    } catch {
      // TMDB hiccup — re-checked the next time one of their films is logged.
    }
  }

  return unlocked;
}

// Unlock `person:{id}` if the user has watched the person's entire
// appropriate filmography. Returns the new achievement or null.
export async function checkPersonCompletion(userId, personId) {
  const curated = curatedPerson(personId);
  if (!curated) return null;
  const already = db
    .prepare("SELECT 1 FROM achievements WHERE user_id = ? AND key = ?")
    .get(userId, `person:${personId}`);
  if (already) return null;

  const films = filterFilmography(curated.role, await personMovieCredits(personId));
  if (films.length < 3) return null;
  const watchedIds = new Set(
    db.prepare("SELECT DISTINCT tmdb_id FROM watches WHERE user_id = ?")
      .all(userId)
      .map((r) => r.tmdb_id)
  );
  if (!films.every((f) => watchedIds.has(f.id))) return null;

  const person = await personDetails(personId);
  const verb = curated.role === "director" ? "directed by" : "starring";
  return unlock(
    userId,
    `person:${personId}`,
    `Filmography Complete: ${person.name}`,
    `Watched all ${films.length} films ${verb} ${person.name}`,
    personBonus(films.length)
  );
}

// Progress toward locked tiers, for the achievements page.
export function progress(userId) {
  const count = db
    .prepare("SELECT COUNT(*) c FROM watches WHERE user_id = ? AND deleted_at IS NULL")
    .get(userId).c;
  const streak = currentStreak(userId);
  const decades = db
    .prepare(
      `SELECT COUNT(DISTINCT (CAST(substr(release_date,1,4) AS INTEGER)/10)*10) d
       FROM watches WHERE user_id = ? AND deleted_at IS NULL AND release_date IS NOT NULL AND release_date != ''`
    )
    .get(userId).d;
  return { volume: count, streak, decades };
}
