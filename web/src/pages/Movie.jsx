import React, { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { api, posterUrl } from "../api.js";
import { useToast } from "../App.jsx";
import QuickLog from "../components/QuickLog.jsx";

export default function Movie() {
  const { id } = useParams();
  const [m, setM] = useState(null);
  const [col, setCol] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const load = () => {
    api(`/movie/${id}`)
      .then((data) => {
        setM(data);
        if (data.collection) {
          api(`/collection/${data.collection.id}`).then(setCol).catch(() => {});
        } else {
          setCol(null);
        }
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => { load(); }, [id]);

  async function deleteWatch(watchId) {
    if (!window.confirm("Remove this watch entry? Earned achievements remain unlocked.")) return;
    try {
      await api(`/watches/${watchId}`, { method: "DELETE" });
      setM((prev) => ({ ...prev, my_watches: prev.my_watches.filter((w) => w.id !== watchId) }));
    } catch (e) {
      setError(e.message);
    }
  }

  async function logWatch() {
    setBusy(true); setError("");
    try {
      const res = await api("/watches", { method: "POST", body: { tmdb_id: m.id } });
      const w = res.watch;
      toast({
        label: w.isRewatch ? "Rewatch logged" : "Watch logged",
        name: w.title,
        points: w.points,
        desc:
          w.reason === "rewatch_cooldown"
            ? "Rewatched too soon — no points this time."
            : w.isRewatch
            ? "Rewatches pay 25%."
            : null,
      });
      for (const a of res.new_achievements) {
        toast({ label: "Achievement unlocked", name: a.name, desc: a.description, points: a.points });
      }
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!m) return <p className="muted">{error || "Loading…"}</p>;

  return (
    <>
      <div className="row" style={{ alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
        {posterUrl(m.poster_path) ? (
          <img
            src={posterUrl(m.poster_path)}
            alt={m.title}
            style={{ width: 180, borderRadius: 10, border: "1px solid var(--line)" }}
          />
        ) : null}
        <div className="grow" style={{ minWidth: 260 }}>
          <h1 style={{ fontFamily: "var(--font-display)", letterSpacing: ".5px", margin: "0 0 4px" }}>
            {m.title}
          </h1>
          <p className="muted">
            {(m.release_date || "").slice(0, 4)}
            {m.runtime ? ` · ${m.runtime} min` : ""}
            {m.vote_average ? ` · ★ ${m.vote_average.toFixed(1)}` : ""}
            {m.genres?.length ? ` · ${m.genres.join(", ")}` : ""}
          </p>
          <p>{m.overview}</p>
          {m.notable_people?.length > 0 && (
            <div className="people-chips">
              {m.notable_people.map((np) => (
                <Link className="chip" to={`/person/${np.id}`} key={np.id}>
                  {np.name} <small>{np.role === "director" ? "· director" : ""}</small>
                </Link>
              ))}
            </div>
          )}
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button className="btn" onClick={logWatch} disabled={busy}>
              {m.my_watches.length > 0 ? "Log rewatch" : "Log watch"}
            </button>
            <span className="pts">worth ~{m.potential_points} pts</span>
          </div>
          {m.my_watches.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <p className="muted" style={{ marginBottom: 6 }}>
                Watched {m.my_watches.length}× — history:
              </p>
              {m.my_watches.map((w) => (
                <div key={w.id} className="row" style={{ gap: 8, marginBottom: 4 }}>
                  <span className="muted">
                    {new Date(w.watched_at + "Z").toLocaleDateString()} · +{w.points} pts
                  </span>
                  {w.source && w.source !== "manual" && (
                    <span className={`verified ${w.source}`}>✓ {w.source}</span>
                  )}
                  <button
                    className="btn ghost small"
                    onClick={() => deleteWatch(w.id)}
                    title="Remove this watch entry"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      </div>

      {col && (
        <>
          <h2 className="section-title">
            {col.name.replace(/ Collection$/i, "")} —{" "}
            {col.parts.filter((p) => p.watched).length}/{col.parts.length} watched
          </h2>
          <p className="muted" style={{ marginTop: -8 }}>
            Complete the series for a bonus of {250 + 50 * col.parts.length} pts.
          </p>
          <div className="poster-grid">
            {col.parts.map((p) => (
              <Link className="poster-card" to={`/movie/${p.id}`} key={p.id}>
                {posterUrl(p.poster_path) ? (
                  <img src={posterUrl(p.poster_path)} alt={p.title} loading="lazy" />
                ) : (
                  <div className="poster-fallback">{p.title}</div>
                )}
                {p.watched && <span className="badge watched">✓</span>}
                <QuickLog tmdbId={p.id} title={p.title} onLogged={load} />
                <div className="title">{p.title}</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}
