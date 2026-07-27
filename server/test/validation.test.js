// Tests for the positive-integer route-param validation helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveInt } from "../src/validation.js";

test("parsePositiveInt: valid movie id", () => {
  assert.equal(parsePositiveInt("550"), 550);
});

test("parsePositiveInt: 1 is valid", () => {
  assert.equal(parsePositiveInt("1"), 1);
});

test("parsePositiveInt: zero is rejected", () => {
  assert.equal(parsePositiveInt("0"), null);
});

test("parsePositiveInt: negative integer is rejected", () => {
  assert.equal(parsePositiveInt("-5"), null);
});

test("parsePositiveInt: float is rejected", () => {
  assert.equal(parsePositiveInt("1.5"), null);
});

test("parsePositiveInt: non-numeric string is rejected", () => {
  assert.equal(parsePositiveInt("abc"), null);
});

test("parsePositiveInt: empty string is rejected", () => {
  assert.equal(parsePositiveInt(""), null);
});

test("parsePositiveInt: path traversal attempt is rejected", () => {
  assert.equal(parsePositiveInt("../etc/passwd"), null);
});

test("parsePositiveInt: numeric prefix with letters is rejected", () => {
  assert.equal(parsePositiveInt("123abc"), null);
});

test("parsePositiveInt: numeric value (not string) is accepted", () => {
  assert.equal(parsePositiveInt(42), 42);
});
