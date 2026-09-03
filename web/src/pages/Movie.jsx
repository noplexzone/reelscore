import React, { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { api, posterUrl } from "../api.js";
import { useToast } from "../App.jsx";
import QuickLog from "../components/QuickLog.jsx";
import { canonicalUtcInstant } from "../utils/utc.js";


function DiaryEditor({ watch, onSaved }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [dateError, setDateError] = useState("");
  async function edit() { setOpen(true); setMessage(""); setDateError(""); try { const entry=await api(`/watches/${watch.id}/diary`); setDraft({...entry,tags:(entry.tags||[]).join(", ")}); } catch(error){ setMessage(error.message); } }
  async function save(event) {
    event.preventDefault(); setSaving(true); setMessage(""); setDateError("");
    try {
      const watchedAt = canonicalUtcInstant(draft.watched_at_utc);
      if (!watchedAt) { setDateError("Enter an exact valid UTC instant such as 2035-01-10T12:00:00.000Z."); return; }
      const saved=await api(`/watches/${watch.id}/diary`,{method:"PATCH",body:{personal_rating:draft.personal_rating===""?null:Number(draft.personal_rating),review:draft.review||null,private_notes:draft.private_notes||null,favorite:!!draft.favorite,tags:draft.tags.split(",").map(tag=>tag.trim()).filter(Boolean),venue:draft.venue||null,visibility:draft.visibility,watched_at_utc:watchedAt}});
      setDraft({...saved,tags:saved.tags.join(", ")}); setMessage("Saved"); onSaved();
    } catch(error){ setMessage(error.message); } finally { setSaving(false); }
  }
  if (!open) return <button className="btn ghost small" onClick={edit}>Edit diary</button>;
  if (!draft) return <div className="diary-editor" role="status">{message||"Loading diary…"}</div>;
  return <form className="diary-editor" onSubmit={save}>
    <div className="diary-heading"><strong>Diary entry</strong><button type="button" className="btn ghost small" onClick={()=>setOpen(false)}>Close</button></div>
    <label>Watched instant (UTC)<input inputMode="text" pattern="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z" value={draft.watched_at_utc} aria-invalid={dateError?"true":undefined} aria-describedby={dateError?`diary-date-error-${watch.id}`:undefined} onChange={e=>{setDraft({...draft,watched_at_utc:e.target.value});setDateError("");}}/></label>
    {dateError && <span id={`diary-date-error-${watch.id}`} className="error" role="alert">{dateError}</span>}
    <label>Rating (0–100)<input type="number" min="0" max="100" value={draft.personal_rating??""} onChange={e=>setDraft({...draft,personal_rating:e.target.value})}/></label>
    <label>Review<textarea maxLength="5000" value={draft.review||""} onChange={e=>setDraft({...draft,review:e.target.value})}/></label>
    <label>Private notes<textarea maxLength="10000" value={draft.private_notes||""} onChange={e=>setDraft({...draft,private_notes:e.target.value})}/></label>
    <label>Tags <span className="muted">comma-separated</span><input value={draft.tags} onChange={e=>setDraft({...draft,tags:e.target.value})}/></label>
    <label>Venue<input maxLength="200" value={draft.venue||""} onChange={e=>setDraft({...draft,venue:e.target.value})}/></label>
    <label>Visibility<select value={draft.visibility} onChange={e=>setDraft({...draft,visibility:e.target.value})}><option value="private">Private</option><option value="friends">Friends</option><option value="public">Public</option></select></label>
    <label className="diary-check"><input type="checkbox" checked={!!draft.favorite} onChange={e=>setDraft({...draft,favorite:e.target.checked})}/> Favorite</label>
    <div className="diary-actions"><button className="btn" disabled={saving}>{saving?"Saving…":"Save diary"}</button><span className={message==="Saved"?"notice":"error"} role="status">{message}</span></div>
  </form>;
}

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
                <div key={w.id} className="diary-watch-row">
                  <div className="diary-watch-summary">
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
                  <DiaryEditor watch={w} onSaved={load} />
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
