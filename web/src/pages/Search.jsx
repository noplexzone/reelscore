import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { api, posterUrl } from "../api.js";

export default function Search() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(() => {
      api(`/search?q=${encodeURIComponent(q)}`)
        .then((d) => { setResults(d.results); setError(""); })
        .catch((e) => setError(e.message));
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <h2 className="section-title">Find a film</h2>
      <input
        placeholder="Search movies…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      {error && <p className="error">{error}</p>}
      <div className="poster-grid" style={{ marginTop: 16 }}>
        {results.map((m) => (
          <Link className="poster-card" to={`/movie/${m.id}`} key={m.id}>
            {posterUrl(m.poster_path) ? (
              <img src={posterUrl(m.poster_path)} alt={m.title} loading="lazy" />
            ) : (
              <div className="poster-fallback">{m.title}</div>
            )}
            <div className="title">{m.title}</div>
            <div className="muted">{(m.release_date || "").slice(0, 4)}</div>
          </Link>
        ))}
      </div>
      {q && results.length === 0 && !error && (
        <p className="muted">No matches yet — check the spelling or try another title.</p>
      )}
    </>
  );
}
