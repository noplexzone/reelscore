import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../App.jsx";

export default function Connections({ onSynced }) {
  const [conns, setConns] = useState(null);
  const [plex, setPlex] = useState(null);
  const [plexUrl, setPlexUrl] = useState("");
  const [plexToken, setPlexToken] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const pollRef = useRef(null);
  const toast = useToast();
  const load = () => api("/connections").then(setConns).catch(() => {});
  useEffect(() => { load(); return () => clearTimeout(pollRef.current); }, []);

  async function startProvider(provider) {
    setError(""); setBusy(`${provider}-link`);
    try {
      const data = await api(`/auth/provider/${provider}/start`, { method: "POST", body: { action: "link" } });
      if (provider === "trakt") {
        window.location.assign(data.auth_url);
        return;
      }
      window.open(data.auth_url, "_blank", "noopener,noreferrer");
      setPlex({ state: data.state, servers: [] });
      pollPlex(data.state);
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  async function pollPlex(state) {
    try {
      const data = await api(`/auth/provider/plex/poll?state=${encodeURIComponent(state)}`);
      if (data.pending) pollRef.current = setTimeout(() => pollPlex(state), 2000);
      else setPlex({ state, servers: data.servers });
    } catch (err) { setError(err.message); }
  }
  async function choosePlex(selectionId) {
    setBusy("plex-link"); setError("");
    try { await api("/auth/provider/plex/complete", { method: "POST", body: { state: plex.state, selection_id: selectionId } }); setPlex(null); toast({ label: "Plex linked", name: "Verified server" }); load(); }
    catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  async function connectManualPlex(event) {
    event.preventDefault(); setBusy("plex-link"); setError("");
    try { const result = await api("/connections/plex", { method: "POST", body: { server_url: plexUrl, token: plexToken } }); toast({ label: "Plex linked", name: result.server_name }); setPlexUrl(""); setPlexToken(""); load(); }
    catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  async function sync(service) {
    setBusy(`${service}-sync`); setError("");
    try {
      const result = await api(`/connections/${service}/sync`, { method: "POST" });
      toast({ label: `${service === "plex" ? "Plex" : "Trakt"} sync complete`, name: `${result.imported} imported · ${result.verified} verified`, desc: result.skipped ? `${result.skipped} already synced` : null });
      for (const achievement of result.new_achievements) toast({ label: "Achievement unlocked", name: achievement.name, desc: achievement.description, points: achievement.points });
      load(); onSynced?.();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  async function unlink(service) { await api(`/connections/${service}`, { method: "DELETE" }); load(); }
  if (!conns) return null;

  const card = (service, label, detail) => <div className="card" style={{ marginBottom: 10 }}><div className="row"><div className="grow"><b>{label}</b>{" "}{conns[service].linked && <span className={`verified ${service}`}>✓ {detail || "linked"}</span>}<div className="muted">{conns[service].linked ? conns[service].last_synced_at ? `Last synced ${conns[service].last_synced_at} UTC` : "Linked — run your first sync." : `Securely link your ${label} account.`}</div></div>{conns[service].linked ? <><button className="btn small" onClick={() => sync(service)} disabled={busy === `${service}-sync`}>{busy === `${service}-sync` ? "Syncing…" : "Sync now"}</button><button className="btn ghost small" onClick={() => unlink(service)}>Unlink</button></> : <button className="btn small" onClick={() => startProvider(service)} disabled={!!busy}>Link {label}</button>}</div></div>;
  return <><h2 className="section-title">Connections</h2><p className="muted" style={{ marginTop: -6 }}>Provider tokens stay encrypted and are never returned to the browser.</p>{error && <p className="error">{error}</p>}
    {conns.trakt.configured && card("trakt", "Trakt", conns.trakt.username)}
    {card("plex", "Plex", conns.plex.server_name)}
    {plex && plex.servers.length === 0 && <p className="muted">Approve Plex in the new tab. Waiting for discovered allowed servers…</p>}
    {plex?.servers.map((server) => <button key={server.selection_id} className="btn ghost" disabled={!!busy} onClick={() => choosePlex(server.selection_id)}>Use {server.name}</button>)}
    {!conns.plex.linked && conns.app_mode === "self_hosted" && <details><summary>Advanced: manually connect Plex</summary><form onSubmit={connectManualPlex} className="plex-form"><input placeholder="http://your-server:32400" value={plexUrl} onChange={(e) => setPlexUrl(e.target.value)} /><input type="password" placeholder="X-Plex-Token" value={plexToken} onChange={(e) => setPlexToken(e.target.value)} /><button className="btn small" disabled={!!busy}>Connect</button></form></details>}
  </>;
}
