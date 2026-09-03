function frozenFilm(order, tmdbId, title, year) {
  return Object.freeze({ order, tmdb_id: tmdbId, title, year });
}

const STARTER_CANON_FILMS = Object.freeze([
  frozenFilm(1, 19, "Metropolis", 1927),
  frozenFilm(2, 901, "City Lights", 1931),
  frozenFilm(3, 630, "The Wizard of Oz", 1939),
  frozenFilm(4, 15, "Citizen Kane", 1941),
  frozenFilm(5, 289, "Casablanca", 1943),
  frozenFilm(6, 872, "Singin' in the Rain", 1952),
  frozenFilm(7, 346, "Seven Samurai", 1954),
  frozenFilm(8, 389, "12 Angry Men", 1957),
  frozenFilm(9, 539, "Psycho", 1960),
  frozenFilm(10, 62, "2001: A Space Odyssey", 1968),
  frozenFilm(11, 238, "The Godfather", 1972),
  frozenFilm(12, 578, "Jaws", 1975),
  frozenFilm(13, 44012, "Jeanne Dielman, 23, quai du Commerce, 1080 Bruxelles", 1976),
  frozenFilm(14, 11, "Star Wars", 1977),
  frozenFilm(15, 348, "Alien", 1979),
  frozenFilm(16, 85, "Raiders of the Lost Ark", 1981),
  frozenFilm(17, 78, "Blade Runner", 1982),
  frozenFilm(18, 925, "Do the Right Thing", 1989),
  frozenFilm(19, 329, "Jurassic Park", 1993),
  frozenFilm(20, 680, "Pulp Fiction", 1994),
  frozenFilm(21, 129, "Spirited Away", 2001),
  frozenFilm(22, 120, "The Lord of the Rings: The Fellowship of the Ring", 2001),
  frozenFilm(23, 598, "City of God", 2002),
  frozenFilm(24, 376867, "Moonlight", 2016),
  frozenFilm(25, 496243, "Parasite", 2019),
]);

const STARTER_CANON = Object.freeze({
  slug: "starter-canon",
  version: "v1",
  name: "ReelScore Starter Canon",
  films: STARTER_CANON_FILMS,
  award: Object.freeze({
    key: "curated-list:starter-canon:v1",
    points: 875,
    name: "ReelScore Starter Canon",
    description: "Watch all 25 films in the ReelScore Starter Canon",
  }),
});

export const CURATED_LISTS = Object.freeze([STARTER_CANON]);

const LISTS_BY_SLUG = new Map(CURATED_LISTS.map((list) => [list.slug, list]));

export function curatedList(slug) {
  return LISTS_BY_SLUG.get(slug) || null;
}
