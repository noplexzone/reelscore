import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/components/LetterboxdImport.jsx", import.meta.url), "utf8");

test("Letterboxd card exposes accessible invalid rows and explicit candidate and skip controls", () => {
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-invalid/);
  assert.match(source, /type="radio"/);
  assert.match(source, /Skip this row/);
});

test("Letterboxd card includes the exact privacy warning and hides implementation secrets", () => {
  assert.match(source, /Imported Letterboxd history is private and does not affect competitive scores or achievements\./);
  assert.doesNotMatch(source, />\s*Commit token/);
  assert.doesNotMatch(source, /private_notes/);
});

test("Letterboxd card presents completed replay counts and honest watched-only wording", () => {
  assert.match(source, /Import complete/);
  assert.match(source, /Already imported/);
  assert.match(source, /Marked watched/);
});

test("start-over is disabled and defensively guarded while requests are in flight", () => {
  assert.match(source, /if \(busy\) return;/);
  assert.match(source, /Start another import<\/button>/);
  assert.match(source, /disabled=\{Boolean\(busy\)\}/);
  assert.match(source, /if \(!current\) return current;/);
});
