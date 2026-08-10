import React, { useEffect, useRef, useState } from "react";
import { api, posterUrl } from "../api.js";

const ACTIONS = [
  ["merge", "Merge", "Treat these as one viewing and keep the verified provider record as audit history."],
  ["keep_both", "Keep both", "Count both as genuine watches using normal rewatch and cooldown rules."],
  ["keep_separate", "Keep separate", "Keep both diary entries, but exclude the provider candidate from competition."],
  ["ignore_future_matching", "Keep both & ignore future matches", "Count this pair normally and stop asking about this film on this local day."],
];
const formatTime = (value) => value ? new Date(value).toLocaleString() : "Unknown time";
function WatchLine({ label, watch }) {
  return <div className="duplicate-watch"><strong>{label}</strong><span className={`verified ${watch.source}`}>{watch.source}</span><time dateTime={watch.watched_at_utc}>{formatTime(watch.watched_at_utc)}</time></div>;
}
export default function Duplicates() {
  const [items, setItems] = useState(null); const [busy, setBusy] = useState(null); const [error, setError] = useState("");
  const loadGeneration = useRef(0); const mutationBusy = useRef(false);
  async function load() {
    const generation = ++loadGeneration.current;
    const data = await api("/duplicates?status=pending");
    if (generation === loadGeneration.current) setItems(data.duplicates);
  }
  useEffect(() => { load().catch(err => setError(err.message)); return () => { loadGeneration.current += 1; }; }, []);
  async function resolve(item, action) {
    if (mutationBusy.current) return;
    if (action === "merge" && !window.confirm(`Merge the two ${item.candidate_watch.title} entries as one viewing? The provider row will remain in audit history.`)) return;
    mutationBusy.current = true; setBusy(item.id); setError("");
    try { await api(`/duplicates/${item.id}/resolve`, { method: "POST", body: { action } }); await load(); }
    catch (err) { setError(err.message); }
    finally { mutationBusy.current = false; setBusy(null); }
  }
  if (items == null && !error) return <p className="muted">Loading duplicate reviews…</p>;
  return <main className="duplicates-page">
    <h1>Duplicate review</h1>
    <p className="muted">Provider watches that resemble a manual entry stay out of points and trophies until you review them.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {busy != null && <p className="muted" role="status">Saving duplicate review…</p>}
    {items?.length === 0 && <div className="card muted">No duplicate watches need review.</div>}
    <div className="duplicate-list">{items?.map(item => {
      const watch=item.candidate_watch, src=posterUrl(watch.poster_path);
      return <article className="card duplicate-card" key={item.id}>
        <div className="duplicate-summary">{src ? <img src={src} alt="" /> : <div className="poster-fallback">No poster</div>}
          <div className="grow"><h2>{watch.title}</h2><p className="muted">Same film and local day · {item.evidence.absolute_delta_ms == null ? "time difference unavailable" : `${Math.round(item.evidence.absolute_delta_ms / 60000)} minutes apart`}</p>
            <WatchLine label="Manual" watch={item.canonical_watch} /><WatchLine label="Provider" watch={item.candidate_watch} />
          </div></div>
        <div className="duplicate-actions" aria-label={`Review ${watch.title}`}>{ACTIONS.map(([action,label,help]) => <button className={`btn small ${action === "merge" ? "" : "ghost"}`} type="button" key={action} disabled={busy != null} title={help} onClick={() => resolve(item,action)}>{label}</button>)}</div>
      </article>;
    })}</div>
  </main>;
}
