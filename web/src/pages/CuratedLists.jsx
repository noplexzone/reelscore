import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { api } from "../api.js";
import { hasValidProgress, safeProgressPercent } from "../utils/curatedLists.js";

function ListProgress({ list }) {
  const valid = hasValidProgress(list.watched, list.total);
  const status = list.complete ? "Complete" : "In progress";

  return (
    <div className="canon-progress">
      <div className="canon-progress-copy">
        <span className={`canon-state ${list.complete ? "complete" : ""}`}>{status}</span>
        {valid ? <span><strong>{list.watched}/{list.total}</strong> watched</span> : <span>Progress unavailable</span>}
      </div>
      {valid && (
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
      )}
    </div>
  );
}

export default function CuratedLists() {
  const [state, setState] = useState({ status: "loading", lists: [], error: "" });

  useEffect(() => {
    let active = true;
    api("/curated-lists")
      .then((data) => {
        if (active) setState({ status: "ready", lists: Array.isArray(data.lists) ? data.lists : [], error: "" });
      })
      .catch((error) => {
        if (active) setState({ status: "error", lists: [], error: error.message });
      });
    return () => { active = false; };
  }, []);

  return <CuratedListsView state={state} />;
}

export function CuratedListsView({ state }) {
  return (
    <main className="canon-page">
      <header className="canon-heading">
        <p className="eyebrow">Curated by ReelScore</p>
        <h1>Lists</h1>
        <p>Essential films, one rewarding finish line. Watch every title to earn the listed trophy.</p>
      </header>

      {state.status === "loading" && <p className="muted canon-status" role="status">Loading curated lists…</p>}
      {state.status === "error" && (
        <div className="card canon-status" role="alert">
          <strong>Couldn’t load curated lists.</strong>
          <p className="muted">{state.error || "Try again in a moment."}</p>
        </div>
      )}
      {state.status === "ready" && state.lists.length === 0 && (
        <div className="card canon-status">
          <strong>No curated lists are available.</strong>
          <p className="muted">Check back when the next program begins.</p>
        </div>
      )}
      {state.status === "ready" && state.lists.length > 0 && (
        <div className="canon-list">
          {state.lists.map((list) => (
            <Link className="canon-list-row" to={`/lists/${list.slug}`} key={`${list.slug}:${list.version}`}>
              <div className="canon-list-main">
                <span className="canon-version">{list.version}</span>
                <h2>{list.name}</h2>
                <p>{list.award.description}</p>
                <ListProgress list={list} />
              </div>
              <span className="tear top" aria-hidden="true" />
              <span className="tear bottom" aria-hidden="true" />
              <div className="canon-award" aria-label={`${list.award.points} point trophy`}>
                <strong>+{list.award.points}</strong>
                <small>PTS</small>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
