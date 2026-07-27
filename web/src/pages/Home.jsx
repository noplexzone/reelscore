import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { api, posterUrl, getUser } from "../api.js";
import QuickLog from "../components/QuickLog.jsx";

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso + "Z").getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Home() {
  const [data, setData] = useState(null);
  const [feed, setFeed] = useState([]);
  const u = getUser();

  const load = () => api("/home").then(setData).catch(() => {});
  useEffect(() => {
    load();
    api("/feed").then((d) => setFeed(d.feed)).catch(() => {});
  }, []);

  if (!data) return <p className="muted">Loading…</p>;
  const me = data.me;

  return (
    <>
      <div className="stat-strip">
        <Link to={`/u/${u?.username || ""}`} className="stat">
          <div className="num">{me.score.toLocaleString()}</div>
          <div className="lbl">points</div>
        </Link>
        <Link to={`/u/${u?.username || ""}`} className="stat">
          <div className="num">{me.watches}</div>
          <div className="lbl">films</div>
        </Link>
        <div className="stat">
          <div className={"num" + (me.streak > 0 ? " flame" : "")}>{me.streak}</div>
          <div className="lbl">day streak</div>
        </div>
      </div>

      {me.watches === 0 && (
        <div className="card">
          <div className="row">
            <div className="grow">
              <b>Your board is empty.</b>
              <div className="muted">Log your first film to open the scoring.</div>
            </div>
            <Link to="/search" className="btn small">Find a film</Link>
          </div>
        </div>
      )}

      {data.continue_series.length > 0 && (
        <>
          <h2 className="section-title">Continue the series</h2>
          <div className="list">
            {data.continue_series.map((s) => (
              <Link className="card row" to={`/movie/${s.next.id}`} key={s.id}>
                {posterUrl(s.next.poster_path, "w92") && (
                  <img src={posterUrl(s.next.poster_path, "w92")} alt="" style={{ width: 42, borderRadius: 6 }} />
                )}
                <div className="grow">
                  <b>{s.name}</b> <span className="muted">{s.watched}/{s.total} watched</span>
                  <div className="progress-bar">
                    <span style={{ width: `${Math.round((100 * s.watched) / s.total)}%` }} />
                  </div>
                  <div className="muted">Next up: {s.next.title}</div>
                </div>
                <span className="pts">+{s.bonus}</span>
              </Link>
            ))}
          </div>
        </>
      )}

      {data.next_trophies.length > 0 && (
        <>
          <h2 className="section-title">Almost there</h2>
          <div className="list">
            {data.next_trophies.map((t) => (
              <Link className="card row" to="/achievements" key={t.name}>
                <div className="grow">
                  <b>{t.name}</b> <span className="muted">{t.desc}</span>
                  <div className="progress-bar">
                    <span style={{ width: `${Math.round((100 * t.have) / t.need)}%` }} />
                  </div>
                  <div className="muted">{t.have}/{t.need}</div>
                </div>
                <span className="pts">{t.points}</span>
              </Link>
            ))}
          </div>
        </>
      )}

      {data.trending.length > 0 && (
        <>
          <h2 className="section-title">Trending this week</h2>
          <div className="poster-grid">
            {data.trending.map((m) => (
              <Link className="poster-card" to={`/movie/${m.id}`} key={m.id}>
                {posterUrl(m.poster_path) ? (
                  <img src={posterUrl(m.poster_path)} alt={m.title} loading="lazy" />
                ) : (
                  <div className="poster-fallback">{m.title}</div>
                )}
                {m.watched && <span className="badge watched">✓</span>}
                {!m.watched && <QuickLog tmdbId={m.id} title={m.title} onLogged={load} />}
                <div className="title">{m.title}</div>
                <div className="muted">{(m.release_date || "").slice(0, 4)}</div>
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
                <img src={posterUrl(f.poster_path, "w92")} alt="" style={{ width: 42, borderRadius: 6 }} />
              )}
              <div className="grow">
                <b><Link to={`/u/${f.username}`}>{f.username}</Link></b>{" "}
                watched <Link to={`/movie/${f.tmdb_id}`}><b>{f.title}</b></Link>
                {f.source && f.source !== "manual" && (
                  <span className={`verified ${f.source}`} style={{ marginLeft: 6 }}>✓ {f.source}</span>
                )}
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
