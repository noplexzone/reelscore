// Curated big-name actors and directors with filmography-completion trophies.
// IDs are TMDB person ids, verified against themoviedb.org.
// Names/photos are always resolved live from TMDB, never hardcoded.

export const CURATED_PEOPLE = [
  // Actors
  { id: 3, role: "actor" },      // Harrison Ford
  { id: 31, role: "actor" },     // Tom Hanks
  { id: 62, role: "actor" },     // Bruce Willis
  { id: 64, role: "actor" },     // Gary Oldman
  { id: 85, role: "actor" },     // Johnny Depp
  { id: 112, role: "actor" },    // Cate Blanchett
  { id: 192, role: "actor" },    // Morgan Freeman
  { id: 204, role: "actor" },    // Kate Winslet
  { id: 380, role: "actor" },    // Robert De Niro
  { id: 500, role: "actor" },    // Tom Cruise
  { id: 514, role: "actor" },    // Jack Nicholson
  { id: 524, role: "actor" },    // Natalie Portman
  { id: 1158, role: "actor" },   // Al Pacino
  { id: 1204, role: "actor" },   // Julia Roberts
  { id: 1245, role: "actor" },   // Scarlett Johansson
  { id: 1892, role: "actor" },   // Matt Damon
  { id: 2231, role: "actor" },   // Samuel L. Jackson
  { id: 2888, role: "actor" },   // Will Smith
  { id: 3894, role: "actor" },   // Christian Bale
  { id: 4173, role: "actor" },   // Anthony Hopkins
  { id: 5064, role: "actor" },   // Meryl Streep
  { id: 5292, role: "actor" },   // Denzel Washington
  { id: 6193, role: "actor" },   // Leonardo DiCaprio
  { id: 6384, role: "actor" },   // Keanu Reeves
  { id: 10859, role: "actor" },  // Ryan Reynolds
  { id: 18277, role: "actor" },  // Sandra Bullock
  { id: 30614, role: "actor" },  // Ryan Gosling
  { id: 54693, role: "actor" },  // Emma Stone
  { id: 73421, role: "actor" },  // Joaquin Phoenix
  // Directors
  { id: 24, role: "director" },     // Robert Zemeckis
  { id: 108, role: "director" },    // Peter Jackson
  { id: 138, role: "director" },    // Quentin Tarantino
  { id: 190, role: "director" },    // Clint Eastwood
  { id: 240, role: "director" },    // Stanley Kubrick
  { id: 488, role: "director" },    // Steven Spielberg
  { id: 525, role: "director" },    // Christopher Nolan
  { id: 578, role: "director" },    // Ridley Scott
  { id: 608, role: "director" },    // Hayao Miyazaki
  { id: 1032, role: "director" },   // Martin Scorsese
  { id: 1223, role: "director" },   // Joel Coen
  { id: 1224, role: "director" },   // Ethan Coen
  { id: 2636, role: "director" },   // Alfred Hitchcock
  { id: 2710, role: "director" },   // James Cameron
  { id: 5655, role: "director" },   // Wes Anderson
  { id: 7467, role: "director" },   // David Fincher
  { id: 137427, role: "director" }, // Denis Villeneuve
];

const curatedById = new Map(CURATED_PEOPLE.map((p) => [p.id, p]));
export const curatedPerson = (id) => curatedById.get(id) || null;

// The "appropriate filmography": released, non-documentary feature films the
// person is genuinely known for — directors count films they directed; actors
// count top-billed roles (no cameos, no as-themselves appearances) with enough
// TMDB votes to filter out obscure shorts and one-offs.
const MIN_VOTES = 50;
const MAX_BILLING_ORDER = 15;
const SELF_RE = /\bself\b|himself|herself|uncredited|archive footage/i;
const DOC_GENRE_ID = 99;

export function filterFilmography(role, credits) {
  const today = new Date().toISOString().slice(0, 10);
  const source = role === "director" ? credits.crew || [] : credits.cast || [];
  const out = new Map();
  for (const c of source) {
    if (!c.release_date || c.release_date > today) continue;
    if ((c.genre_ids || []).includes(DOC_GENRE_ID)) continue;
    if ((c.vote_count ?? 0) < MIN_VOTES) continue;
    if (role === "director") {
      if (c.job !== "Director") continue;
    } else {
      if ((c.order ?? 99) > MAX_BILLING_ORDER) continue;
      if (SELF_RE.test(c.character || "")) continue;
    }
    if (!out.has(c.id)) {
      out.set(c.id, {
        id: c.id,
        title: c.title,
        release_date: c.release_date,
        poster_path: c.poster_path,
      });
    }
  }
  return [...out.values()].sort((a, b) => (a.release_date < b.release_date ? -1 : 1));
}

export const personBonus = (filmCount) => 500 + 25 * filmCount;

// Curated people attached to a movie (from its TMDB credits): directors, plus
// top-billed cast.
export function notablePeopleInMovie(credits) {
  const found = [];
  for (const c of credits?.cast || []) {
    if ((c.order ?? 99) > MAX_BILLING_ORDER) continue;
    const p = curatedById.get(c.id);
    if (p && p.role === "actor") found.push({ id: c.id, name: c.name, role: "actor" });
  }
  for (const c of credits?.crew || []) {
    const p = curatedById.get(c.id);
    if (p && p.role === "director" && c.job === "Director")
      found.push({ id: c.id, name: c.name, role: "director" });
  }
  return found;
}
