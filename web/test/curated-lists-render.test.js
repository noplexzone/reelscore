import test, { after } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { Router } from "wouter";

const vite = await createServer({ root: new URL("..", import.meta.url).pathname, cacheDir: `/tmp/rs-vite-curated-${process.pid}`, appType: "custom", optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } });
after(() => vite.close());

const { CuratedListsView } = await vite.ssrLoadModule("/src/pages/CuratedLists.jsx");
const { CuratedListView } = await vite.ssrLoadModule("/src/pages/CuratedList.jsx");
const { AchievementsView } = await vite.ssrLoadModule("/src/pages/Achievements.jsx");

const award = { key: "curated-list:starter-canon:v1", points: 875, name: "ReelScore Starter Canon", description: "Watch all 25 films in the ReelScore Starter Canon" };
const summary = { slug: "starter-canon", version: "v1", name: "ReelScore Starter Canon", award, watched: 7, total: 25, complete: false };
const films = [
  { order: 2, tmdb_id: 901, title: "City Lights", year: 1931, poster_path: null, watched: false },
  { order: 1, tmdb_id: 19, title: "Metropolis", year: 1927, poster_path: "/metro.jpg", watched: true },
];

function staticLocation() { return ["/lists", () => {}]; }
function markup(Component, props) {
  return renderToStaticMarkup(React.createElement(Router, { hook: staticLocation }, React.createElement(Component, props)));
}

test("summary view renders loading, error, empty, progress, and completion without false zero progress", () => {
  assert.match(markup(CuratedListsView, { state: { status: "loading", lists: [], error: "" } }), /Loading curated lists/);
  const failed = markup(CuratedListsView, { state: { status: "error", lists: [], error: "Offline" } });
  assert.match(failed, /Couldn.t load curated lists/);
  assert.doesNotMatch(failed, /0\/25/);
  assert.match(markup(CuratedListsView, { state: { status: "ready", lists: [], error: "" } }), /No curated lists are available/);
  const progress = markup(CuratedListsView, { state: { status: "ready", lists: [summary], error: "" } });
  assert.match(progress, /7\/25/);
  assert.match(progress, /\+875/);
  assert.match(progress, /role="progressbar"/);
  assert.match(progress, /aria-label="ReelScore Starter Canon progress"/);
  assert.match(progress, /aria-valuenow="7"/);
  assert.match(progress, /href="\/lists\/starter-canon"/);
  assert.match(markup(CuratedListsView, { state: { status: "ready", lists: [{ ...summary, watched: 25, complete: true }], error: "" } }), /Complete/);
});

test("detail view renders request states, ordered movie links, fallback, and textual watch state", () => {
  assert.match(markup(CuratedListView, { state: { status: "loading", list: null, error: "" } }), /Loading curated list/);
  const failed = markup(CuratedListView, { state: { status: "error", list: null, error: "Unavailable" } });
  assert.match(failed, /Couldn.t load this curated list/);
  assert.doesNotMatch(failed, /0\/25/);
  const detail = markup(CuratedListView, { state: { status: "ready", list: { ...summary, films }, error: "" } });
  assert.ok(detail.indexOf("/movie/19") < detail.indexOf("/movie/901"));
  assert.match(detail, /Metropolis poster/);
  assert.match(detail, /poster-fallback/);
  assert.match(detail, />Watched</);
  assert.match(detail, />Not watched</);
  assert.match(detail, /7\/25 watched/);
  assert.match(detail, /\+875 PTS/);
  assert.match(detail, /aria-valuenow="7"/);
  const empty = markup(CuratedListView, { state: { status: "ready", list: { ...summary, films: [] }, error: "" } });
  assert.match(empty, /This curated list has no films yet/);
});

test("Starter Canon trophy links to its list while locked and earned", () => {
  const base = { unlocked: [], progress: { volume: 0, decades: 0, streak: 0, curated_lists: [{ slug: "starter-canon", version: "v1", count: 7, total: 25, complete: false }] } };
  const locked = markup(AchievementsView, { data: base });
  assert.match(locked, /href="\/lists\/starter-canon"/);
  assert.match(locked, /7\/25 watched/);
  const earned = markup(AchievementsView, { data: { ...base, unlocked: [{ key: award.key, name: award.name, description: award.description, points: 875 }] } });
  assert.match(earned, /href="\/lists\/starter-canon"/);
  assert.match(earned, /\+875/);
});
