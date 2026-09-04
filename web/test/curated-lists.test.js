import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { safeProgressPercent } from "../src/utils/curatedLists.js";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const achievementsSource = await readFile(new URL("../src/pages/Achievements.jsx", import.meta.url), "utf8");
const listsSource = await readFile(new URL("../src/pages/CuratedLists.jsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../src/pages/CuratedList.jsx", import.meta.url), "utf8");

test("safe progress percent clamps valid progress and rejects malformed totals", () => {
  assert.equal(safeProgressPercent(0, 25), 0);
  assert.equal(safeProgressPercent(12, 25), 48);
  assert.equal(safeProgressPercent(25, 25), 100);
  assert.equal(safeProgressPercent(30, 25), 100);
  assert.equal(safeProgressPercent(-2, 25), 0);
  assert.equal(safeProgressPercent("12", 25), 0);
  assert.equal(safeProgressPercent(12, 0), 0);
  assert.equal(safeProgressPercent(12, Number.NaN), 0);
});

test("authenticated list routes and Lists navigation are registered", () => {
  assert.match(appSource, /<ActiveLink to="\/lists">Lists<\/ActiveLink>/);
  assert.match(appSource, /<Route path="\/lists\/:slug"><Protected><CuratedList \/><\/Protected><\/Route>/);
  assert.match(appSource, /<Route path="\/lists"><Protected><CuratedLists \/><\/Protected><\/Route>/);
});

test("list summary exposes progress, award, completion, and resilient request states", () => {
  assert.match(listsSource, /api\("\/curated-lists"\)/);
  assert.match(listsSource, /role="progressbar"/);
  assert.match(listsSource, /aria-valuenow/);
  assert.match(listsSource, /\+\{list\.award\.points\}/);
  assert.match(listsSource, /Complete/);
  assert.match(listsSource, /In progress/);
  assert.match(listsSource, /Couldn’t load curated lists/);
  assert.match(listsSource, /No curated lists are available/);
  assert.match(listsSource, /to=\{`\/lists\/\$\{list\.slug\}`\}/);
});

test("detail renders ordered linked posters with accessible watched state", () => {
  assert.match(detailSource, /api\(`\/curated-lists\/\$\{encodeURIComponent\(slug\)\}`\)/);
  assert.match(detailSource, /\.sort\(\(a, b\) => a\.order - b\.order\)/);
  assert.match(detailSource, /to=\{`\/movie\/\$\{film\.tmdb_id\}`\}/);
  assert.match(detailSource, /posterUrl\(film\.poster_path\)/);
  assert.match(detailSource, /Watched/);
  assert.match(detailSource, /Not watched/);
  assert.match(detailSource, /role="progressbar"/);
  assert.match(detailSource, /Couldn’t load this curated list/);
  assert.match(detailSource, /This curated list has no films yet/);
});

test("Starter Canon trophy links to list progress whether earned or locked", () => {
  assert.match(achievementsSource, /curated-list:starter-canon:v1/);
  assert.match(achievementsSource, /const STARTER_CANON_HREF = \"\/lists\/starter-canon\"/);
  assert.match(achievementsSource, /<Link to=\{href\}/);
  assert.match(achievementsSource, /progress\.curated_lists/);
});
