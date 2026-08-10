import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ELIGIBILITY_RULE_VERSION, evaluateWatchEligibility } from "../src/eligibility.js";

const event = (id, day, overrides = {}) => ({ id, tmdb_id: 42, watched_at_utc: `${day}T12:00:00.000Z`, deleted_at: null, duplicate_status: null, ...overrides });

test("eligibility policy is pure, versioned, and chronological", () => {
  const input = [event(2, "2026-02-15"), event(1, "2026-01-01")];
  const snapshot = structuredClone(input);
  const result = evaluateWatchEligibility(input);
  assert.deepEqual(input, snapshot);
  assert.equal(ELIGIBILITY_RULE_VERSION, "competitive-v1");
  assert.deepEqual(result.map((row) => row.id), [1, 2]);
  assert.deepEqual(result[0], { id: 1, logical_canonical_watch_id: 1, qualifies_for_volume: 1, qualifies_for_achievement: 1, qualifies_for_streak: 1, qualifies_for_season: 1, eligibility_rule_version: "competitive-v1", eligibility_reason: "canonical_first_watch" });
  assert.equal(result[1].eligibility_reason, "rewatch_outside_cooldown");
  assert.equal(result[1].qualifies_for_volume, 0);
  assert.equal(result[1].qualifies_for_achievement, 0);
  assert.equal(result[1].qualifies_for_streak, 1);
  assert.equal(result[1].qualifies_for_season, 1);
  assert.equal(result[1].logical_canonical_watch_id, 1);
});

test("rewatches inside the 30-day cooldown remain history but do not qualify", () => {
  const result = evaluateWatchEligibility([event(1, "2026-01-01"), event(2, "2026-01-30")]);
  assert.deepEqual(result.slice(1).map(({ qualifies_for_volume, qualifies_for_achievement, qualifies_for_streak, qualifies_for_season, eligibility_reason }) => ({ qualifies_for_volume, qualifies_for_achievement, qualifies_for_streak, qualifies_for_season, eligibility_reason })), [{ qualifies_for_volume: 0, qualifies_for_achievement: 0, qualifies_for_streak: 0, qualifies_for_season: 0, eligibility_reason: "rewatch_cooldown" }]);
});

test("pending duplicate candidates and deleted events never qualify", () => {
  const result = evaluateWatchEligibility([event(1, "2026-01-01"), event(2, "2026-03-01", { duplicate_status: "pending" }), event(3, "2026-04-01", { deleted_at: "2026-04-02T00:00:00Z" })]);
  assert.equal(result[1].eligibility_reason, "duplicate_pending");
  assert.equal(result[2].eligibility_reason, "deleted");
  for (const row of result.slice(1)) {
    assert.equal(row.qualifies_for_volume + row.qualifies_for_achievement + row.qualifies_for_streak + row.qualifies_for_season, 0);
    assert.equal(row.logical_canonical_watch_id, 1);
  }
});

test("canonical identity is scoped by user and movie with deterministic ties", () => {
  const result = evaluateWatchEligibility([event(4, "2026-01-01", { user_id: 2 }), event(2, "2026-01-01", { user_id: 1 }), event(3, "2026-01-01", { user_id: 1, tmdb_id: 99 }), event(1, "2026-01-01", { user_id: 1 })]);
  const byId = new Map(result.map((row) => [row.id, row]));
  assert.equal(byId.get(1).eligibility_reason, "canonical_first_watch");
  assert.equal(byId.get(2).eligibility_reason, "rewatch_cooldown");
  assert.equal(byId.get(3).eligibility_reason, "canonical_first_watch");
  assert.equal(byId.get(4).eligibility_reason, "canonical_first_watch");
});

test("eligibility rejects ambiguous host-local timestamps", () => {
  assert.throws(() => evaluateWatchEligibility([{ id: 1, tmdb_id: 42, watched_at_utc: "01/10/2024 20:00:00" }]), /watched_at_utc/i);
  assert.throws(() => evaluateWatchEligibility([{ id: 1, tmdb_id: 42, watched_at_utc: "2024-01-10T20:00:00" }]), /watched_at_utc/i);
});

test("eligibility chronology is identical under different host timezones", () => {
  const moduleUrl = pathToFileURL(path.resolve("src/eligibility.js")).href;
  const source = `import { evaluateWatchEligibility } from ${JSON.stringify(moduleUrl)}; const rows=evaluateWatchEligibility([{id:2,user_id:1,tmdb_id:42,watched_at_utc:"2024-01-10T23:00:00Z"},{id:1,user_id:1,tmdb_id:42,watched_at_utc:"2024-01-10 20:00:00"}]); console.log(JSON.stringify(rows.map(({id,eligibility_reason})=>({id,eligibility_reason}))));`;
  const outputs = ["UTC", "America/Chicago"].map((TZ) => {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", env: { ...process.env, TZ } });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  });
  assert.equal(outputs[0], outputs[1]);
  assert.deepEqual(JSON.parse(outputs[0]), [
    { id: 1, eligibility_reason: "canonical_first_watch" },
    { id: 2, eligibility_reason: "rewatch_cooldown" },
  ]);
});
