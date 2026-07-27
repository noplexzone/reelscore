import React, { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { api, posterUrl, getUser } from "../api.js";

export default function Profile() {
  const { username } = useParams();
  const [p, setP] = useState(null);
  const [error, setError] = useState("");
  const me = getUser();
  const isSelf = me && me.username.toLowerCase() === username.toLowerCase();

  const load = () =>
    api(`/users/${encodeURIComponent(username)}`)
      .then((data) => { setP(data); setError(""); })
      .catch((e) => setError(e.message));
  // Don't pass `load` directly to useEffect — it returns a promise, which
  // React would try to call as the effect cleanup and crash on unmount.
  useEffect(() => { load(); }, [username]);

  async function togglePublic() {
    await api("/me/settings", {
      method: "POST",
      body: { public_profile: !p.public_profile },
    });
    load();
  }

  if (error) return <div className="card muted">{error}</div>;
  if (!p) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="marquee">
        <div className="label">{p.username}</div>
        <div className="score">{p.score.toLocaleString()}</div>
        <div className="sub">
          <b>{p.watches}</b> films
          {p.streak > 0 && <> · <span className="streak-flame">{p.streak}-day streak</span></>}
        </div>
      </div>

      {isSelf && (
        <div className="card row" style={{ marginBottom: 20 }}>
          <div className="grow">
            <b>Public profile</b>
            <div className="muted">
              {p.public_profile
                ? "Anyone with your username can see your board."
                : "Only friends can see your board."}
            </div>
          </div>
          <button className="btn ghost small" onClick={togglePublic}>
            {p.public_profile ? "Make private" : "Go public"}
          </button>
        </div>
      )}

      <h2 className="section-title">Trophy case</h2>
      {p.trophies.length === 0 ? (
        <div className="card muted">No trophies on display yet.</div>
      ) : (
        <div className="stub-list">
          {p.trophies.map((t, i) => (
            <div className="stub" key={i}>
              <div className="body grow">
                <div className="name">{t.name}</div>
                <div className="desc">{t.description}</div>
              </div>
              <span className="tear top" /><span className="tear bottom" />
              <div className="stub-points"><span>+{t.points}</span><small>PTS</small></div>
            </div>
          ))}
        </div>
      )}

      <h2 className="section-title">Recently watched</h2>
      {p.recent.length === 0 ? (
        <div className="card muted">Nothing logged yet.</div>
      ) : (
        <div className="poster-grid">
          {p.recent.map((w, i) => (
            <Link className="poster-card" to={`/movie/${w.tmdb_id}`} key={i}>
              {posterUrl(w.poster_path) ? (
                <img src={posterUrl(w.poster_path)} alt={w.title} loading="lazy" />
              ) : (
                <div className="poster-fallback">{w.title}</div>
              )}
              <span className="badge">+{w.points}</span>
              <div className="title">{w.title}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
