import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLetterboxdFormData,
  decisionsComplete,
  serializeDecisions,
  safeSessionStorage,
  watchHistoryLabel,
} from "../src/utils/letterboxdImport.js";

test("preview FormData uses only the exact Letterboxd field names and filenames", async () => {
  const diary = new Blob(["diary"], { type: "text/csv" });
  const watched = new Blob(["watched"], { type: "text/csv" });
  const body = buildLetterboxdFormData({ diary, watched });
  assert.deepEqual([...body.keys()], ["diary", "watched"]);
  assert.equal(body.get("diary").name, "diary.csv");
  assert.equal(body.get("watched").name, "watched.csv");
});

test("preview FormData normalizes browser files without a MIME type to text/csv", () => {
  const diary = new File(["Date,Name"], "export.csv");
  const body = buildLetterboxdFormData({ diary });
  assert.equal(body.get("diary").type, "text/csv");
  assert.equal(body.get("diary").name, "diary.csv");
});

test("preview FormData rejects an empty upload", () => {
  assert.throws(() => buildLetterboxdFormData({}), /choose/i);
});

test("commit decisions require an explicit selection or skip for every choice row", () => {
  const rows = [{ id: 1, resolution_state: "choice_required" }, { id: 2, resolution_state: "auto_selected" }, { id: 3, resolution_state: "choice_required", candidates: [{ id: 603 }] }];
  assert.equal(decisionsComplete(rows, { 1: { action: "skip" } }), false);
  const decisions = { 1: { action: "skip" }, 3: { action: "select", tmdb_id: 603 } };
  assert.equal(decisionsComplete(rows, decisions), true);
  assert.deepEqual(serializeDecisions(rows, decisions), [
    { row_id: 1, action: "skip" },
    { row_id: 3, action: "select", tmdb_id: 603 },
  ]);
});

test("marked-watched imports never masquerade as a dated watch", () => {
  assert.equal(watchHistoryLabel({ source: "letterboxd", source_date_kind: "marked_watched_day", source_recorded_date: "2026-08-01" }), "Marked watched on Letterboxd · 8/1/2026");
  assert.equal(watchHistoryLabel({ source: "letterboxd", source_date_kind: "watched_day", watched_at: "2026-08-01 12:00:00" }), "Watched on Letterboxd · 8/1/2026");
});


test("unavailable session storage never crashes the import workflow", () => {
  const blocked = {
    getItem() { throw new DOMException("blocked", "SecurityError"); },
    setItem() { throw new DOMException("blocked", "SecurityError"); },
    removeItem() { throw new DOMException("blocked", "SecurityError"); },
  };
  assert.equal(safeSessionStorage.get(blocked, "job"), null);
  assert.equal(safeSessionStorage.set(blocked, "job", "abc"), false);
  assert.equal(safeSessionStorage.remove(blocked, "job"), false);
  assert.equal(safeSessionStorage.get(() => { throw new DOMException("blocked", "SecurityError"); }, "job"), null);
});
