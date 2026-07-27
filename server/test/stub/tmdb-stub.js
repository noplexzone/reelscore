// Minimal TMDB API stub for local/manual testing without a real API key.
// Run:  node server/test/stub/tmdb-stub.js   (port 3555, override with STUB_PORT)
// Point the app at it with TMDB_BASE_URL=http://localhost:3555
import http from "http";

const g = (...names) => names.map((n) => ({ name: n }));

const MOVIES = {
  603: {
    id: 603, title: "The Matrix", release_date: "1999-03-30", runtime: 136,
    vote_average: 8.2, vote_count: 26000, poster_path: null, backdrop_path: null,
    overview: "A hacker learns the truth about his reality.",
    genres: g("Action", "Science Fiction"),
    belongs_to_collection: { id: 2344, name: "The Matrix Collection" },
    credits: { cast: [{ id: 6384, name: "Keanu Reeves", character: "Neo", order: 0 }], crew: [] },
  },
  604: {
    id: 604, title: "The Matrix Reloaded", release_date: "2003-05-15", runtime: 138,
    vote_average: 7.0, vote_count: 12000, poster_path: null, backdrop_path: null,
    overview: "Neo and the rebels fight on.",
    genres: g("Action", "Science Fiction"),
    belongs_to_collection: { id: 2344, name: "The Matrix Collection" },
    credits: { cast: [{ id: 6384, name: "Keanu Reeves", character: "Neo", order: 0 }], crew: [] },
  },
  605: {
    id: 605, title: "The Matrix Revolutions", release_date: "2003-11-05", runtime: 129,
    vote_average: 6.7, vote_count: 11000, poster_path: null, backdrop_path: null,
    overview: "The final battle for Zion.",
    genres: g("Action", "Science Fiction"),
    belongs_to_collection: { id: 2344, name: "The Matrix Collection" },
    credits: { cast: [{ id: 6384, name: "Keanu Reeves", character: "Neo", order: 0 }], crew: [] },
  },
  13: {
    id: 13, title: "Forrest Gump", release_date: "1994-06-23", runtime: 142,
    vote_average: 8.5, vote_count: 27000, poster_path: null, backdrop_path: null,
    overview: "The story of a man who was there.",
    genres: g("Comedy", "Drama", "Romance"),
    belongs_to_collection: null,
    credits: { cast: [{ id: 31, name: "Tom Hanks", character: "Forrest Gump", order: 0 }], crew: [] },
  },
  8358: {
    id: 8358, title: "Cast Away", release_date: "2000-12-22", runtime: 143,
    vote_average: 7.7, vote_count: 11000, poster_path: null, backdrop_path: null,
    overview: "A FedEx exec is stranded on an island.",
    genres: g("Adventure", "Drama"),
    belongs_to_collection: null,
    credits: { cast: [{ id: 31, name: "Tom Hanks", character: "Chuck Noland", order: 0 }], crew: [] },
  },
  857: {
    id: 857, title: "Saving Private Ryan", release_date: "1998-07-24", runtime: 169,
    vote_average: 8.2, vote_count: 15000, poster_path: null, backdrop_path: null,
    overview: "A squad searches for a paratrooper.",
    genres: g("Drama", "War"),
    belongs_to_collection: null,
    credits: {
      cast: [{ id: 31, name: "Tom Hanks", character: "Captain Miller", order: 0 }],
      crew: [{ id: 488, name: "Steven Spielberg", job: "Director" }],
    },
  },
  862: {
    id: 862, title: "Toy Story", release_date: "1995-11-22", runtime: 81,
    vote_average: 8.0, vote_count: 18000, poster_path: null, backdrop_path: null,
    overview: "Toys come to life.",
    genres: g("Animation", "Comedy", "Family"),
    belongs_to_collection: null,
    credits: { cast: [{ id: 31, name: "Tom Hanks", character: "Woody (voice)", order: 0 }], crew: [] },
  },
  27205: {
    id: 27205, title: "Inception", release_date: "2010-07-15", runtime: 148,
    vote_average: 8.4, vote_count: 36000, poster_path: null, backdrop_path: null,
    overview: "A thief steals secrets through dreams.",
    genres: g("Action", "Science Fiction", "Adventure"),
    belongs_to_collection: null,
    credits: {
      cast: [{ id: 6193, name: "Leonardo DiCaprio", character: "Cobb", order: 0 }],
      crew: [{ id: 525, name: "Christopher Nolan", job: "Director" }],
    },
  },
  157336: {
    id: 157336, title: "Interstellar", release_date: "2014-11-05", runtime: 169,
    vote_average: 8.4, vote_count: 34000, poster_path: null, backdrop_path: null,
    overview: "Explorers travel through a wormhole.",
    genres: g("Adventure", "Drama", "Science Fiction"),
    belongs_to_collection: null,
    credits: { cast: [], crew: [{ id: 525, name: "Christopher Nolan", job: "Director" }] },
  },
  155: {
    id: 155, title: "The Dark Knight", release_date: "2008-07-16", runtime: 152,
    vote_average: 8.5, vote_count: 32000, poster_path: null, backdrop_path: null,
    overview: "Batman faces the Joker.",
    genres: g("Drama", "Action", "Crime", "Thriller"),
    belongs_to_collection: { id: 263, name: "The Dark Knight Collection" },
    credits: { cast: [], crew: [{ id: 525, name: "Christopher Nolan", job: "Director" }] },
  },
};

const COLLECTIONS = {
  2344: {
    id: 2344, name: "The Matrix Collection",
    parts: [603, 604, 605].map((id) => ({
      id, title: MOVIES[id].title, release_date: MOVIES[id].release_date, poster_path: null,
    })),
  },
  263: {
    id: 263, name: "The Dark Knight Collection",
    parts: [{ id: 272, title: "Batman Begins", release_date: "2005-06-10", poster_path: null },
            { id: 155, title: "The Dark Knight", release_date: "2008-07-16", poster_path: null },
            { id: 49026, title: "The Dark Knight Rises", release_date: "2012-07-17", poster_path: null }],
  },
};

const PEOPLE = {
  31: {
    id: 31, name: "Tom Hanks", profile_path: null,
    known_for_department: "Acting",
    credits: {
      cast: [
        ...[13, 8358, 857, 862].map((id) => ({
          id, title: MOVIES[id].title, release_date: MOVIES[id].release_date,
          poster_path: null, vote_count: MOVIES[id].vote_count, vote_average: MOVIES[id].vote_average,
          genre_ids: [18], order: 0, character: "Lead",
        })),
        // Should be filtered out of "appropriate" filmography:
        { id: 900001, title: "A Talking-Heads Documentary", release_date: "2015-01-01",
          poster_path: null, vote_count: 5000, vote_average: 7.0, genre_ids: [99], order: 3, character: "Self" },
        { id: 900002, title: "Obscure Student Short", release_date: "1989-01-01",
          poster_path: null, vote_count: 12, vote_average: 6.0, genre_ids: [18], order: 1, character: "Man" },
        { id: 900003, title: "Big Ensemble Cameo", release_date: "2011-01-01",
          poster_path: null, vote_count: 4000, vote_average: 6.4, genre_ids: [35], order: 33, character: "Cameo" },
      ],
      crew: [],
    },
  },
  525: {
    id: 525, name: "Christopher Nolan", profile_path: null,
    known_for_department: "Directing",
    credits: {
      cast: [],
      crew: [
        ...[27205, 157336, 155].map((id) => ({
          id, title: MOVIES[id].title, release_date: MOVIES[id].release_date,
          poster_path: null, vote_count: MOVIES[id].vote_count, vote_average: MOVIES[id].vote_average,
          genre_ids: [28], job: "Director",
        })),
        { id: 900004, title: "Produced But Not Directed", release_date: "2013-01-01",
          poster_path: null, vote_count: 9000, vote_average: 7.2, genre_ids: [28], job: "Producer" },
      ],
    },
  },
};

const TRENDING = [603, 27205, 155, 13, 157336, 862, 8358, 857].map((id) => ({
  id, title: MOVIES[id].title, release_date: MOVIES[id].release_date,
  poster_path: null, vote_average: MOVIES[id].vote_average, overview: MOVIES[id].overview,
}));

function json(res, code, data) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  let m;

  if (p === "/search/movie") {
    const q = (url.searchParams.get("query") || "").toLowerCase();
    const results = Object.values(MOVIES).filter((mv) => mv.title.toLowerCase().includes(q));
    return json(res, 200, { results });
  }
  if ((m = p.match(/^\/movie\/(\d+)$/))) {
    const mv = MOVIES[m[1]];
    if (!mv) return json(res, 404, { status_message: "Not found" });
    const out = { ...mv };
    if (!(url.searchParams.get("append_to_response") || "").includes("credits")) delete out.credits;
    return json(res, 200, out);
  }
  if ((m = p.match(/^\/collection\/(\d+)$/))) {
    const c = COLLECTIONS[m[1]];
    return c ? json(res, 200, c) : json(res, 404, { status_message: "Not found" });
  }
  if (p === "/trending/movie/week") return json(res, 200, { results: TRENDING });
  if ((m = p.match(/^\/person\/(\d+)\/movie_credits$/))) {
    const pe = PEOPLE[m[1]];
    return pe ? json(res, 200, { id: pe.id, ...pe.credits }) : json(res, 404, { status_message: "Not found" });
  }
  if ((m = p.match(/^\/person\/(\d+)$/))) {
    const pe = PEOPLE[m[1]];
    if (!pe) return json(res, 404, { status_message: "Not found" });
    const { credits, ...rest } = pe;
    return json(res, 200, rest);
  }
  json(res, 404, { status_message: "Stub: no route for " + p });
});

const PORT = process.env.STUB_PORT || 3555;
server.listen(PORT, () => console.log(`TMDB stub listening on :${PORT}`));
