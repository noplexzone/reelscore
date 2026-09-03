import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, posterUrl } from "../api.js";
import {
  buildLetterboxdFormData,
  decisionsComplete,
  safeSessionStorage,
  serializeDecisions,
} from "../utils/letterboxdImport.js";

const PAGE_SIZE = 10;
const COMPLETED_JOB_KEY = "reelscore.completedLetterboxdImport";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function countCompletedRows(rows = []) {
  return {
    imported: rows.filter((row) => row.resolution_state === "imported").length,
    already_imported: rows.filter((row) => row.resolution_state === "already_imported").length,
    skipped: rows.filter((row) => row.resolution_state === "skipped").length,
    error: rows.filter((row) => ["invalid", "error"].includes(row.resolution_state)).length,
  };
}

function Summary({ counts, completed = false }) {
  const items = completed
    ? [
        ["Imported", counts.imported || 0],
        ["Already imported", counts.already_imported || 0],
        ["Skipped", counts.skipped || 0],
        ["Errors", counts.error || 0],
      ]
    : [
        ["Rows", counts.total || 0],
        ["Ready", counts.resolved || 0],
        ["Needs a decision", counts.choice_required || 0],
        ["Errors", counts.invalid || 0],
      ];
  return <dl className="letterboxd-summary" aria-label={completed ? "Import result summary" : "Preview summary"}>
    {items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

function RatingAndTags({ row }) {
  const hasRating = Number.isInteger(row.rating);
  const tags = Array.isArray(row.tags) ? row.tags : [];
  if (!hasRating && tags.length === 0) return null;
  return <div className="letterboxd-details">
    {hasRating && <span><strong>Rating:</strong> {row.rating}/100</span>}
    {tags.length > 0 && <span className="letterboxd-tags"><strong>Tags:</strong> {tags.join(", ")}</span>}
  </div>;
}

function Candidate({ row, candidate, checked, onChoose, disabled }) {
  const controlId = `letterboxd-row-${row.id}-candidate-${candidate.id}`;
  return <label className="letterboxd-candidate" htmlFor={controlId}>
    <input
      id={controlId}
      type="radio"
      name={`letterboxd-row-${row.id}`}
      checked={checked}
      onChange={() => onChoose({ action: "select", tmdb_id: candidate.id })}
      disabled={disabled}
    />
    {posterUrl(candidate.poster_path, "w92")
      ? <img src={posterUrl(candidate.poster_path, "w92")} alt="" loading="lazy" />
      : <span className="letterboxd-poster-fallback" aria-hidden="true">No poster</span>}
    <span className="grow">
      <strong>{candidate.title}</strong>
      <small>{String(candidate.release_date || "").slice(0, 4) || "Year unknown"}</small>
    </span>
  </label>;
}

function ReviewRow({ row, decision, onChoose, completed }) {
  const headingId = `letterboxd-row-${row.id}-heading`;
  const invalid = row.resolution_state === "invalid" || row.resolution_state === "error";
  const watchedOnly = row.source_date_kind === "marked_watched_day";
  const resolvedCandidate = (row.candidates || []).find((candidate) => candidate.id === row.selected_tmdb_id);

  return <article
    className={`letterboxd-row${invalid ? " invalid" : ""}`}
    aria-labelledby={headingId}
    aria-invalid={invalid ? "true" : undefined}
  >
    <div className="letterboxd-row-heading">
      <div className="grow">
        <span className="eyebrow">{watchedOnly ? "Marked watched" : "Diary entry"} · row {row.source_row_number}</span>
        <h3 id={headingId}>{row.name || "Invalid row"}{row.year ? ` (${row.year})` : ""}</h3>
        <p className="muted">{row.source_recorded_date || "No valid source date"}</p>
      </div>
      {completed && <span className={`status-pill ${row.resolution_state === "imported" ? "enabled" : ""}`}>
        {row.resolution_state === "already_imported" ? "Already imported" : row.resolution_state.replaceAll("_", " ")}
      </span>}
    </div>
    <RatingAndTags row={row} />
    {invalid && <div className="error letterboxd-row-error" role="alert">{row.error || "This row could not be imported."}</div>}
    {!completed && row.resolution_state === "auto_selected" && resolvedCandidate && <p className="letterboxd-auto-match">
      Matched to <strong>{resolvedCandidate.title}</strong> ({String(resolvedCandidate.release_date || "").slice(0, 4) || "year unknown"})
    </p>}
    {!completed && row.resolution_state === "choice_required" && <fieldset>
      <legend>Choose the matching movie or skip this row</legend>
      <div className="letterboxd-candidates">
        {(row.candidates || []).map((candidate) => <Candidate
          key={candidate.id}
          row={row}
          candidate={candidate}
          checked={decision?.action === "select" && decision.tmdb_id === candidate.id}
          onChoose={onChoose}
        />)}
        <label className="letterboxd-skip">
          <input
            type="radio"
            name={`letterboxd-row-${row.id}`}
            checked={decision?.action === "skip"}
            onChange={() => onChoose({ action: "skip" })}
          />
          <span><strong>Skip this row</strong><small>Nothing will be added for this entry.</small></span>
        </label>
      </div>
    </fieldset>}
  </article>;
}

export default function LetterboxdImport() {
  const [files, setFiles] = useState({ diary: null, watched: null });
  const [preview, setPreview] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [commitToken, setCommitToken] = useState("");
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [resumeLoading, setResumeLoading] = useState(true);
  const [uploadVersion, setUploadVersion] = useState(0);
  const commitInFlight = useRef(false);
  const browserStorage = () => globalThis.sessionStorage;

  useEffect(() => {
    const jobId = safeSessionStorage.get(browserStorage, COMPLETED_JOB_KEY);
    if (!jobId) { setResumeLoading(false); return; }
    api(`/imports/letterboxd/${encodeURIComponent(jobId)}`)
      .then((saved) => {
        if (saved.state === "completed") {
          setPreview(saved);
          setResult({ ...saved, counts: countCompletedRows(saved.rows) });
        } else {
          safeSessionStorage.remove(browserStorage, COMPLETED_JOB_KEY);
        }
      })
      .catch(() => safeSessionStorage.remove(browserStorage, COMPLETED_JOB_KEY))
      .finally(() => setResumeLoading(false));
  }, []);

  const rows = preview?.rows || [];
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visibleRows = useMemo(
    () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [rows, page],
  );
  const complete = decisionsComplete(rows, decisions);

  function chooseFile(kind, file) {
    setFiles((current) => ({ ...current, [kind]: file || null }));
    setError("");
  }

  async function createPreview(event) {
    event.preventDefault();
    setError("");
    const selected = [files.diary, files.watched].filter(Boolean);
    if (selected.some((file) => file.size > MAX_FILE_BYTES)) {
      setError("Each CSV file must be at most 2 MiB.");
      return;
    }
    setBusy("preview");
    try {
      const data = await api("/imports/letterboxd/preview", {
        method: "POST",
        body: buildLetterboxdFormData(files),
      });
      setPreview(data);
      setCommitToken(data.commit_token || "");
      setDecisions({});
      setResult(null);
      setPage(1);
      safeSessionStorage.remove(browserStorage, COMPLETED_JOB_KEY);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function commitImport() {
    if (commitInFlight.current || !preview || !commitToken || !complete) return;
    commitInFlight.current = true;
    setBusy("commit");
    setError("");
    try {
      const data = await api(`/imports/letterboxd/${encodeURIComponent(preview.job_id)}/commit`, {
        method: "POST",
        body: { token: commitToken, decisions: serializeDecisions(rows, decisions) },
      });
      setResult(data);
      setPreview((current) => {
        if (!current) return current;
        const outcomes = new Map((data.rows || []).map((row) => [row.row_id, row]));
        return {
          ...current,
          state: "completed",
          rows: current.rows.map((row) => {
            const outcome = outcomes.get(row.id);
            return outcome ? { ...row, resolution_state: outcome.outcome, error: outcome.error || row.error } : row;
          }),
        };
      });
      setCommitToken("");
      safeSessionStorage.set(browserStorage, COMPLETED_JOB_KEY, preview.job_id);
    } catch (err) {
      setError(err.message);
    } finally {
      commitInFlight.current = false;
      setBusy("");
    }
  }

  function startOver() {
    if (busy) return;
    setFiles({ diary: null, watched: null });
    setPreview(null);
    setDecisions({});
    setCommitToken("");
    setResult(null);
    setPage(1);
    setError("");
    setUploadVersion((value) => value + 1);
    safeSessionStorage.remove(browserStorage, COMPLETED_JOB_KEY);
  }

  const completed = Boolean(result || preview?.state === "completed");
  const completedCounts = result?.counts || countCompletedRows(rows);

  return <section className="card settings-card letterboxd-import" aria-labelledby="letterboxd-import-heading">
    <div className="settings-card-heading">
      <div>
        <p className="eyebrow">Private history</p>
        <h2 id="letterboxd-import-heading">Import from Letterboxd</h2>
        <p className="muted">Upload the official diary.csv, watched.csv, or both. You can review every match before importing.</p>
      </div>
      {completed && <span className="status-pill enabled">Complete</span>}
    </div>

    <p className="letterboxd-warning">
      <strong>Imported Letterboxd history is private and does not affect competitive scores or achievements.</strong>
    </p>

    {resumeLoading && <p className="muted" role="status">Checking your last completed import…</p>}
    {error && <div className="error settings-message" role="alert">{error}</div>}

    {!resumeLoading && !preview && <form className="letterboxd-upload" onSubmit={createPreview} key={uploadVersion}>
      <div className="letterboxd-file-grid">
        <label htmlFor="letterboxd-diary">
          <span><strong>Diary entries</strong><small>Ratings, tags, and actual watch dates</small></span>
          <input id="letterboxd-diary" name="diary" type="file" accept=".csv,text/csv" onChange={(event) => chooseFile("diary", event.target.files?.[0])} />
        </label>
        <label htmlFor="letterboxd-watched">
          <span><strong>Watched films</strong><small>Films marked watched without a watch date</small></span>
          <input id="letterboxd-watched" name="watched" type="file" accept=".csv,text/csv" onChange={(event) => chooseFile("watched", event.target.files?.[0])} />
        </label>
      </div>
      <div className="settings-actions">
        <button className="btn" disabled={busy === "preview" || (!files.diary && !files.watched)}>
          {busy === "preview" ? "Preparing preview…" : "Preview import"}
        </button>
      </div>
    </form>}

    {preview && <div className="letterboxd-review">
      <div className="letterboxd-review-heading">
        <div>
          <h3>{completed ? "Import complete" : "Review import"}</h3>
          <p className="muted">{completed ? "This completed result can be safely restored after a reload." : "Nothing is imported until you confirm below."}</p>
        </div>
        <button type="button" className="btn ghost small" onClick={startOver} disabled={Boolean(busy)}>Start another import</button>
      </div>
      <Summary counts={completed ? completedCounts : preview.counts} completed={completed} />
      {rows.length === 0
        ? <p className="muted letterboxd-empty">No rows are available to review.</p>
        : <div className="letterboxd-rows">{visibleRows.map((row) => <ReviewRow
            key={row.id || row.row_id}
            row={row}
            decision={decisions[row.id]}
            onChoose={(decision) => setDecisions((current) => ({ ...current, [row.id]: decision }))}
            completed={completed}
          />)}</div>}
      {rows.length > PAGE_SIZE && <nav className="letterboxd-pagination" aria-label="Import review pages">
        <button type="button" className="btn ghost small" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1}>Previous</button>
        <span aria-live="polite">Page {page} of {totalPages}</span>
        <button type="button" className="btn ghost small" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page === totalPages}>Next</button>
      </nav>}
      {!completed && <div className="letterboxd-commit">
        {!complete && <p className="muted" role="status">Choose a movie or skip every row that needs a decision.</p>}
        <button type="button" className="btn" onClick={commitImport} disabled={busy === "commit" || !complete || !commitToken}>
          {busy === "commit" ? "Importing…" : "Import private history"}
        </button>
      </div>}
    </div>}
  </section>;
}
