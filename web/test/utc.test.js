import test from "node:test";
import assert from "node:assert/strict";
import { canonicalUtcInstant } from "../src/utils/utc.js";

test("canonical UTC validator rejects impossible text without normalizing it", () => {
  for (const value of [
    "2035-02-29T12:00:00.000Z",
    "2035-13-01T00:00:00.000Z",
    "2035-01-01T24:00:00.000Z",
    "2035-01-01",
  ]) assert.equal(canonicalUtcInstant(value), null);

  assert.equal(
    canonicalUtcInstant("2036-02-29T12:00:00.000Z"),
    "2036-02-29T12:00:00.000Z",
  );
});
