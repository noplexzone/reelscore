// Overridable so tests can point at a local stub (server/test/stub/tmdb-stub.js).
const BASE = process.env.TMDB_BASE_URL || "https://api.themoviedb.org/3";
const KEY = process.env.TMDB_API_KEY || "";

// Simple in-memory cache with TTL to be gentle on TMDB.
const cache = new Map();
const TTL = 1000 * 60 * 60 * 6; // 6h

async function tmdb(pathname, params = {}) {
  if (!KEY) {
    const err = new Error(
      "TMDB_API_KEY is not set. Add it to your environment (see README)."
    );
    err.status = 503;
    throw err;
  }
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const cacheKey = url.toString();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const headers = { accept: "application/json" };
  // Support both v4 read access tokens (long, start with "ey") and v3 keys.
  if (KEY.startsWith("ey")) headers.Authorization = `Bearer ${KEY}`;
  else url.searchParams.set("api_key", KEY);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = new Error(`TMDB error ${res.status}`);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  const data = await res.json();
  cache.set(cacheKey, { at: Date.now(), data });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return data;
}

export const searchMovies = (q, page = 1, { primaryReleaseYear } = {}) =>
  tmdb("/search/movie", { query: q, page, include_adult: "false",
    ...(primaryReleaseYear == null ? {} : { primary_release_year: primaryReleaseYear }) });

// Credits are appended so notable-people and filmography trophies can be
// evaluated without a second fetch (one cache entry per movie either way).
export const movieDetails = (id) => tmdb(`/movie/${id}`, { append_to_response: "credits" });

export const collectionDetails = (id) => tmdb(`/collection/${id}`);

export const trendingMovies = () => tmdb("/trending/movie/week");

export const personDetails = (id) => tmdb(`/person/${id}`);

export const personMovieCredits = (id) => tmdb(`/person/${id}/movie_credits`);
