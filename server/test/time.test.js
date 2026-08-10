import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isValidTimeZone, localDay, normalizeUtcInstant } from "../src/time.js";

test("IANA timezone validation accepts real zones and rejects invalid input", () => {
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("America/Chicago"), true);
  assert.equal(isValidTimeZone("Not/A_Zone"), false);
  assert.equal(isValidTimeZone(""), false);
});

test("localDay derives the calendar date on either side of local midnight", () => {
  assert.equal(localDay("2026-01-15T05:59:59Z", "America/Chicago"), "2026-01-14");
  assert.equal(localDay("2026-01-15T06:00:00Z", "America/Chicago"), "2026-01-15");
});

test("localDay uses calendar formatting across DST transitions", () => {
  assert.equal(localDay("2026-03-08T07:59:59Z", "America/Chicago"), "2026-03-08");
  assert.equal(localDay("2026-03-08T08:00:00Z", "America/Chicago"), "2026-03-08");
  assert.equal(localDay("2026-11-01T06:30:00Z", "America/Chicago"), "2026-11-01");
  assert.equal(localDay("2026-11-01T07:30:00Z", "America/Chicago"), "2026-11-01");
});

test("time helpers reject invalid, ambiguous, and impossible instants", () => {
  assert.throws(() => localDay("2026-01-01T00:00:00Z", "Mars/Olympus"), /timezone/i);
  for (const value of ["not-a-date", "01/10/2024 20:00:00", "2024-01-10T20:00:00", "2024-02-30T20:00:00Z"]) {
    assert.throws(() => localDay(value, "UTC"), /instant/i);
    assert.throws(() => normalizeUtcInstant(value), /instant/i);
  }
});

test("legacy timestamps are normalized as UTC without changing their instant", () => {
  assert.equal(normalizeUtcInstant("2024-01-10 20:00:00"), "2024-01-10T20:00:00.000Z");
  assert.equal(normalizeUtcInstant("2024-01-10T15:00:00-05:00"), "2024-01-10T20:00:00.000Z");
});

test("UTC normalization is identical under different host timezones", () => {
  const moduleUrl = pathToFileURL(path.resolve("src/time.js")).href;
  const source = `import { normalizeUtcInstant } from ${JSON.stringify(moduleUrl)}; console.log(normalizeUtcInstant("2024-01-10 20:00:00")); console.log(normalizeUtcInstant("2024-01-10T15:00:00-05:00"));`;
  const outputs = ["UTC", "America/Chicago"].map((TZ) => {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", env: { ...process.env, TZ } });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  });
  assert.equal(outputs[0], outputs[1]);
  assert.equal(outputs[0], "2024-01-10T20:00:00.000Z\n2024-01-10T20:00:00.000Z");
});
