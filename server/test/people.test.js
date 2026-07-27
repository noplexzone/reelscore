import test from "node:test";
import assert from "node:assert/strict";
import { filterFilmography, notablePeopleInMovie, personBonus } from "../src/people.js";

const film = (id, over = {}) => ({
  id,
  title: `Film ${id}`,
  release_date: "2000-01-01",
  poster_path: null,
  vote_count: 1000,
  genre_ids: [18],
  order: 0,
  character: "Lead",
  ...over,
});

test("actor filmography keeps top-billed released features", () => {
  const films = filterFilmography("actor", { cast: [film(1), film(2), film(3)] });
  assert.deepEqual(films.map((f) => f.id), [1, 2, 3]);
});

test("actor filmography excludes documentaries, self appearances, cameos, obscure titles, unreleased", () => {
  const films = filterFilmography("actor", {
    cast: [
      film(1),
      film(2, { genre_ids: [99] }),                    // documentary
      film(3, { character: "Self" }),                  // as themselves
      film(4, { character: "Man (uncredited)" }),      // uncredited
      film(5, { order: 30 }),                          // deep-billed cameo
      film(6, { vote_count: 10 }),                     // obscure
      film(7, { release_date: "2999-01-01" }),         // unreleased
      film(8, { release_date: "" }),                   // no date
    ],
  });
  assert.deepEqual(films.map((f) => f.id), [1]);
});

test("director filmography keeps only Director credits", () => {
  const films = filterFilmography("director", {
    crew: [
      { ...film(1), job: "Director" },
      { ...film(2), job: "Producer" },
      { ...film(3), job: "Director", genre_ids: [99] },
    ],
  });
  assert.deepEqual(films.map((f) => f.id), [1]);
});

test("filmography dedupes and sorts by release date", () => {
  const films = filterFilmography("actor", {
    cast: [
      film(1, { release_date: "2010-01-01" }),
      film(1, { release_date: "2010-01-01" }),
      film(2, { release_date: "1990-01-01" }),
    ],
  });
  assert.deepEqual(films.map((f) => f.id), [2, 1]);
});

test("notablePeopleInMovie finds curated cast and directors only", () => {
  const credits = {
    cast: [
      { id: 31, name: "Tom Hanks", order: 0 },        // curated actor
      { id: 999999, name: "Nobody Famous", order: 1 }, // not curated
      { id: 6193, name: "Leonardo DiCaprio", order: 40 }, // curated but deep-billed
    ],
    crew: [
      { id: 525, name: "Christopher Nolan", job: "Director" }, // curated director
      { id: 488, name: "Steven Spielberg", job: "Producer" },  // curated, wrong job
    ],
  };
  const found = notablePeopleInMovie(credits);
  assert.deepEqual(found.map((p) => p.id).sort((a, b) => a - b), [31, 525]);
});

test("personBonus scales with filmography size", () => {
  assert.equal(personBonus(4), 600);
  assert.equal(personBonus(20), 1000);
});
