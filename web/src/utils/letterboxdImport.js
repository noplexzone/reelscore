const CHOICE_REQUIRED = "choice_required";

export const safeSessionStorage = {
  get(source, key) {
    try { return (typeof source === "function" ? source() : source)?.getItem(key) ?? null; } catch { return null; }
  },
  set(source, key, value) {
    try { (typeof source === "function" ? source() : source)?.setItem(key, value); return true; } catch { return false; }
  },
  remove(source, key) {
    try { (typeof source === "function" ? source() : source)?.removeItem(key); return true; } catch { return false; }
  },
};

export function buildLetterboxdFormData({ diary = null, watched = null } = {}) {
  if (!diary && !watched) throw new TypeError("Choose diary.csv, watched.csv, or both.");
  const body = new FormData();
  if (diary) body.append("diary", new Blob([diary], { type: "text/csv" }), "diary.csv");
  if (watched) body.append("watched", new Blob([watched], { type: "text/csv" }), "watched.csv");
  return body;
}

function validDecision(row, decision) {
  if (row.resolution_state !== CHOICE_REQUIRED) return true;
  if (decision?.action === "skip") return true;
  return decision?.action === "select"
    && Number.isInteger(decision.tmdb_id)
    && (row.candidates || []).some((candidate) => candidate.id === decision.tmdb_id);
}

export function decisionsComplete(rows = [], decisions = {}) {
  return rows.every((row) => validDecision(row, decisions[row.id]));
}

export function serializeDecisions(rows = [], decisions = {}) {
  return rows
    .filter((row) => row.resolution_state === CHOICE_REQUIRED)
    .map((row) => {
      const decision = decisions[row.id];
      return decision.action === "skip"
        ? { row_id: row.id, action: "skip" }
        : { row_id: row.id, action: "select", tmdb_id: decision.tmdb_id };
    });
}

function displayDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value || "")) return "Unknown date";
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(date);
}

export function watchHistoryLabel(watch) {
  if (watch?.source === "letterboxd") {
    const day = watch.source_recorded_date
      || watch.watched_day_local
      || String(watch.watched_at || "").slice(0, 10);
    const action = watch.source_date_kind === "marked_watched_day"
      ? "Marked watched on Letterboxd"
      : "Watched on Letterboxd";
    return `${action} · ${displayDay(day)}`;
  }
  const day = watch?.watched_day_local || String(watch?.watched_at || "").slice(0, 10);
  return `Watched · ${displayDay(day)}`;
}
