function frozenFilm(order, tmdbId, title, year, posterPath) {
  return Object.freeze({ order, tmdb_id: tmdbId, title, year, poster_path: posterPath });
}

const STARTER_CANON_FILMS = Object.freeze([
  frozenFilm(1, 19, "Metropolis", 1927, "/kr9wXRN23zLuWJIelahas1mtnYj.jpg"),
  frozenFilm(2, 901, "City Lights", 1931, "/ugmakEL5y294I5bXgiBqApuZpwc.jpg"),
  frozenFilm(3, 630, "The Wizard of Oz", 1939, "/uCC3j4pV9eOZwzDUWp2ilbcTf1f.jpg"),
  frozenFilm(4, 15, "Citizen Kane", 1941, "/sav0jxhqiH0bPr2vZFU0Kjt2nZL.jpg"),
  frozenFilm(5, 289, "Casablanca", 1943, "/lGCEKlJo2CnWydQj7aamY7s1S7Q.jpg"),
  frozenFilm(6, 872, "Singin' in the Rain", 1952, "/w03EiJVHP8Un77boQeE7hg9DVdU.jpg"),
  frozenFilm(7, 346, "Seven Samurai", 1954, "/lOMGc8bnSwQhS4XyE1S99uH8NXf.jpg"),
  frozenFilm(8, 389, "12 Angry Men", 1957, "/zhG3vKWyDRaZYoaww1UVAi29T9h.jpg"),
  frozenFilm(9, 539, "Psycho", 1960, "/yz4QVqPx3h1hD1DfqqQkCq3rmxW.jpg"),
  frozenFilm(10, 62, "2001: A Space Odyssey", 1968, "/ve72VxNqjGM69Uky4WTo2bK6rfq.jpg"),
  frozenFilm(11, 238, "The Godfather", 1972, "/3bhkrj58Vtu7enYsRolD1fZdja1.jpg"),
  frozenFilm(12, 578, "Jaws", 1975, "/lxM6kqilAdpdhqUl2biYp5frUxE.jpg"),
  frozenFilm(13, 44012, "Jeanne Dielman, 23, quai du Commerce, 1080 Bruxelles", 1976, "/fqfSu8Y1YSVFkoCJyiTXI6woYma.jpg"),
  frozenFilm(14, 11, "Star Wars", 1977, "/fai0rspsNeJCS69wHNjOdWxcI7P.jpg"),
  frozenFilm(15, 348, "Alien", 1979, "/vfrQk5IPloGg1v9Rzbh2Eg3VGyM.jpg"),
  frozenFilm(16, 85, "Raiders of the Lost Ark", 1981, "/ceG9VzoRAVGwivFU403Wc3AHRys.jpg"),
  frozenFilm(17, 78, "Blade Runner", 1982, "/63N9uy8nd9j7Eog2axPQ8lbr3Wj.jpg"),
  frozenFilm(18, 925, "Do the Right Thing", 1989, "/63rmSDPahrH7C1gEFYzRuIBAN9W.jpg"),
  frozenFilm(19, 329, "Jurassic Park", 1993, "/63viWuPfYQjRYLSZSZNq7dglJP5.jpg"),
  frozenFilm(20, 680, "Pulp Fiction", 1994, "/vQWk5YBFWF4bZaofAbv0tShwBvQ.jpg"),
  frozenFilm(21, 129, "Spirited Away", 2001, "/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg"),
  frozenFilm(22, 120, "The Lord of the Rings: The Fellowship of the Ring", 2001, "/6oom5QYQ2yQTMJIbnvbkBL9cHo6.jpg"),
  frozenFilm(23, 598, "City of God", 2002, "/k7eYdWvhYQyRQoU2TB2A2Xu2TfD.jpg"),
  frozenFilm(24, 376867, "Moonlight", 2016, "/qLnfEmPrDjJfPyyddLJPkXmshkp.jpg"),
  frozenFilm(25, 496243, "Parasite", 2019, "/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg"),
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
