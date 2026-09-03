import React, { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { api, posterUrl } from "../api.js";
import { hasValidProgress, safeProgressPercent } from "../utils/curatedLists.js";

function DetailProgress({ list }) {
  const valid = hasValidProgress(list.watched, list.total);
  if (!valid) return <p className="canon-progress-unavailable">Progress unavailable</p>;
  return (
    <>
      <div className="canon-detail-progress-copy">
        <strong>{list.watched}/{list.total} watched</strong>
        <span className={`canon-state ${list.complete ? "complete" : ""}`}>
          {list.complete ? "Complete" : "In progress"}
        </span>
      </div>
      <div
        className="progress-bar canon-progress-bar"
        role="progressbar"
        aria-label={`${list.name} progress`}
        aria-valuemin={0}
        aria-valuemax={list.total}
        aria-valuenow={Math.min(list.watched, list.total)}
        aria-valuetext={`${list.watched} of ${list.total} films watched`}
      >
        <span style={{ width: `${safeProgressPercent(list.watched, list.total)}%` }} />
      </div>
    </>
  );
}

export default function CuratedList() {
  const { slug } = useParams();
  const [state, setState] = useState({ status: "loading", list: null, error: "" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading", list: null, error: "" });
    api(`/curated-lists/${encodeURIComponent(slug)}`)
      .then((list) => {
        if (active) setState({ status: "ready", list, error: "" });
      })
      .catch((error) => {
        if (active) setState({ status: "error", list: null, error: error.message });
      });
    return () => { active = false; };
  }, [slug]);

  return <CuratedListView state={state} />;
}

export function CuratedListView({ state }) {
  if (state.status === "loading") {
    return <main className="canon-page"><p className="muted canon-status" role="status">Loading curated list…</p></main>;
  }
  if (state.status === "error") {
    return (
      <main className="canon-page">
        <div className="card canon-status" role="alert">
          <strong>Couldn’t load this curated list.</strong>
          <p className="muted">{state.error || "Try again in a moment."}</p>
          <Link className="inline-link" to="/lists">Back to lists</Link>
        </div>
      </main>
    );
  }

  const list = state.list;
  const films = Array.isArray(list.films) ? [...list.films].sort((a, b) => a.order - b.order) : [];

  return (
    <main className="canon-page">
      <Link className="canon-back" to="/lists">← All lists</Link>
      <header className="canon-detail-hero">
        <div className="canon-detail-copy">
          <p className="eyebrow">ReelScore curated · {list.version}</p>
          <h1>{list.name}</h1>
          <p>{list.award.description}</p>
          <DetailProgress list={list} />
        </div>
        <div className="canon-detail-award">
          <span>{list.complete ? "Trophy earned" : "Completion trophy"}</span>
          <strong>+{list.award.points} PTS</strong>
          <small>{list.award.name}</small>
        </div>
      </header>

      <div className="section-heading">
        <h2 className="section-title">The program</h2>
        <span className="muted">In viewing order</span>
      </div>
      {films.length === 0 ? (
        <div className="card canon-status">
          <strong>This curated list has no films yet.</strong>
          <p className="muted">There’s nothing to track in this program.</p>
        </div>
      ) : (
        <ol className="canon-poster-grid">
          {films.map((film) => (
            <li key={film.tmdb_id}>
              <Link className={`canon-film ${film.watched ? "watched" : ""}`} to={`/movie/${film.tmdb_id}`}>
                <div className="canon-poster">
                  {posterUrl(film.poster_path) ? (
                    <img src={posterUrl(film.poster_path)} alt={`${film.title} poster`} loading="lazy" />
                  ) : (
                    <div className="poster-fallback">{film.title}</div>
                  )}
                  <span className="canon-order" aria-hidden="true">{film.order}</span>
                  <span className="canon-watch-state">
                    <span aria-hidden="true">{film.watched ? "✓" : "○"}</span>
                    {film.watched ? "Watched" : "Not watched"}
                  </span>
                </div>
                <span className="canon-film-title">{film.title}</span>
                <span className="muted">{film.year}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
