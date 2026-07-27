import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, posterUrl } from "../api.js";

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso + "Z").getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Home() {
  const [me, setMe] = useState(null);
  const [watches, setWatches] = useState([]);
  const [feed, setFeed] = useState([]);

  useEffect(() => {
    api("/me").then(setMe).catch(() => {});
    api("/watches").then((d) => setWatches(d.watches)).catch(() => {});
    api("/feed").then((d) => setFeed(d.feed)).catch(() => {});
  }, []);

  return (
    <>
      <div className="marquee">
        <div className="label">Lifetime score</div>
        <div className="score">{me ? me.score.toLocaleString() : "—"}</div>
        <div className="sub">
          <b>{me?.watches ?? 0}</b> films logged
          {me?.streak > 0 && (
            <> · <span className="streak-flame">{me.streak}-day streak</span></>
          )}
        </div>
      </div>

      {watches.length === 0 ? (
        <div className="card">
          <div className="row">
            <div className="grow">
              <b>Your board is empty.</b>
              <div className="muted">Log your first film to open the scoring.</div>
            </div>
            <Link to="/search" className="btn small">Find a film</Link>
          </div>
        </div>
      ) : (
        <>
          <h2 className="section-title">Recently logged</h2>
          <div className="poster-grid">
            {watches.slice(0, 12).map((w) => (
              <Link className="poster-card" to={`/movie/${w.tmdb_id}`} key={w.id}>
                {posterUrl(w.poster_path) ? (
                  <img src={posterUrl(w.poster_path)} alt={w.title} loading="lazy" />
                ) : (
                  <div className="poster-fallback">{w.title}</div>
                )}
                <span className={"badge" + (w.points === 0 ? " watched" : "")}>
                  +{w.points}
                </span>
                <div className="title">{w.title}</div>
                <div className="muted">{timeAgo(w.watched_at)}</div>
              </Link>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">Friends are watching</h2>
      {feed.length === 0 ? (
        <div className="card muted">
          Nothing yet — <Link to="/friends" style={{ textDecoration: "underline" }}>add some friends</Link> to
          see their latest watches here.
        </div>
      ) : (
        <div className="list">
          {feed.slice(0, 15).map((f, i) => (
            <div className="card row" key={i}>
              {posterUrl(f.poster_path, "w92") && (
                <img
                  src={posterUrl(f.poster_path, "w92")}
                  alt=""
                  style={{ width: 42, borderRadius: 6 }}
                />
              )}
              <div className="grow">
                <b>
                  <Link to={`/u/${f.username}`}>{f.username}</Link>
                </b>{" "}
                watched <Link to={`/movie/${f.tmdb_id}`}><b>{f.title}</b></Link>
                <div className="muted">{timeAgo(f.watched_at)}</div>
              </div>
              <span className="pts">+{f.points}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
