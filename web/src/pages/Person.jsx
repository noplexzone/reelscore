import React, { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { api, posterUrl } from "../api.js";
import QuickLog from "../components/QuickLog.jsx";

export default function Person() {
  const { id } = useParams();
  const [p, setP] = useState(null);
  const [error, setError] = useState("");

  const load = () =>
    api(`/people/${id}`)
      .then((data) => { setP(data); setError(""); })
      .catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  if (error) return <div className="card muted">{error}</div>;
  if (!p) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="row" style={{ alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
        {posterUrl(p.profile_path, "w185") && (
          <img
            src={posterUrl(p.profile_path, "w185")}
            alt={p.name}
            style={{ width: 140, borderRadius: 10, border: "1px solid var(--line)" }}
          />
        )}
        <div className="grow" style={{ minWidth: 260 }}>
          <h1 style={{ fontFamily: "var(--font-display)", letterSpacing: ".5px", margin: "0 0 4px" }}>
            {p.name}
          </h1>
          <p className="muted">
            {p.role === "director" ? "Director" : "Actor"} · {p.watched}/{p.total} films watched
          </p>
          <div className="progress-bar" style={{ maxWidth: 360 }}>
            <span style={{ width: `${Math.round((100 * p.watched) / p.total)}%` }} />
          </div>
          <p className="muted">
            {p.complete ? (
              <>Filmography complete — trophy earned. <span className="pts">+{p.bonus} pts</span></>
            ) : (
              <>Watch all {p.total} films for <span className="pts">+{p.bonus} pts</span></>
            )}
          </p>
          {p.biography && <p className="muted">{p.biography}</p>}
        </div>
      </div>

      <h2 className="section-title">
        {p.role === "director" ? "Directed filmography" : "Marquee filmography"}
      </h2>
      <div className="poster-grid">
        {p.films.map((f) => (
          <Link className="poster-card" to={`/movie/${f.id}`} key={f.id}>
            {posterUrl(f.poster_path) ? (
              <img src={posterUrl(f.poster_path)} alt={f.title} loading="lazy" />
            ) : (
              <div className="poster-fallback">{f.title}</div>
            )}
            {f.watched && <span className="badge watched">✓</span>}
            {!f.watched && <QuickLog tmdbId={f.id} title={f.title} onLogged={load} />}
            <div className="title">{f.title}</div>
            <div className="muted">{(f.release_date || "").slice(0, 4)}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
