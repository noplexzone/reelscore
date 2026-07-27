import { test } from "node:test";
import assert from "node:assert/strict";
import { basePoints, watchPoints } from "../src/scoring.js";

test("basePoints: 7.0 average, 120 min runtime", () => {
  // 100 * (7/10)^2 * (120/120) = 100 * 0.49 * 1 = 49
  assert.equal(basePoints({ voteAverage: 7, runtime: 120 }), 49);
});

test("basePoints: runtime clamped to max 2× factor", () => {
  const pts = basePoints({ voteAverage: 8, runtime: 300 });
  assert.equal(pts, Math.round(100 * (8 / 10) ** 2 * 2));
});

test("basePoints: runtime clamped to min 0.5× factor", () => {
  const pts = basePoints({ voteAverage: 6, runtime: 30 });
  assert.equal(pts, Math.round(100 * (6 / 10) ** 2 * 0.5));
});

test("basePoints: null runtime falls back to 100-min default", () => {
  assert.equal(
    basePoints({ voteAverage: 7, runtime: null }),
    basePoints({ voteAverage: 7, runtime: 100 })
  );
});

test("basePoints: zero voteAverage yields 0 points", () => {
  assert.equal(basePoints({ voteAverage: 0, runtime: 120 }), 0);
});

test("watchPoints: first watch returns full base points", () => {
  const { points, isRewatch, reason } = watchPoints({
    voteAverage: 7,
    runtime: 120,
    priorWatches: [],
  });
  assert.equal(points, basePoints({ voteAverage: 7, runtime: 120 }));
  assert.equal(isRewatch, false);
  assert.equal(reason, "first_watch");
});

test("watchPoints: rewatch within 30-day cooldown yields 0 points", () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 19);
  const { points, isRewatch, reason } = watchPoints({
    voteAverage: 7,
    runtime: 120,
    priorWatches: [yesterday],
  });
  assert.equal(points, 0);
  assert.equal(isRewatch, true);
  assert.equal(reason, "rewatch_cooldown");
});

test("watchPoints: rewatch after 30-day cooldown yields 25% of base", () => {
  const daysAgo31 = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 19);
  const { points, isRewatch, reason } = watchPoints({
    voteAverage: 7,
    runtime: 120,
    priorWatches: [daysAgo31],
  });
  const expected = Math.round(basePoints({ voteAverage: 7, runtime: 120 }) * 0.25);
  assert.equal(points, expected);
  assert.equal(isRewatch, true);
  assert.equal(reason, "rewatch");
});
