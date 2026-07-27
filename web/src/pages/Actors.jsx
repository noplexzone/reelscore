import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { api, posterUrl } from "../api.js";

export default function Actors() {
  const [people, setPeople] = useState(null);

  useEffect(() => {
    api("/people").then((d) => setPeople(d.people)).catch(() => setPeople([]));
  }, []);

  if (!people) return <p className="muted">Loading the marquee names…</p>;

  const actors = people.filter((p) => p.role === "actor");
  const directors = people.filter((p) => p.role === "director");

  const card = (p) => (
    <Link className="person-card" to={`/person/${p.id}`} key={p.id}>
      {posterUrl(p.profile_path, "w185") ? (
        <img src={posterUrl(p.profile_path, "w185")} alt={p.name} loading="lazy" />
      ) : (
        <div className="poster-fallback">{p.name}</div>
      )}
      {p.complete && <span className="badge">★</span>}
      <div className="title">{p.name}</div>
      <div className="progress-bar">
        <span style={{ width: `${Math.round((100 * p.watched) / p.total)}%` }} />
      </div>
      <div className="muted">{p.watched}/{p.total} films</div>
    </Link>
  );

  return (
    <>
      <h2 className="section-title">Complete a filmography</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        Watch every marquee film on someone's reel to earn their trophy — worth
        500 points plus 25 per film.
      </p>
      <h2 className="section-title">Actors</h2>
      <div className="person-grid">{actors.map(card)}</div>
      <h2 className="section-title">Directors</h2>
      <div className="person-grid">{directors.map(card)}</div>
    </>
  );
}
