import React, { useEffect, useRef, useState } from "react";
import { Redirect, useLocation } from "wouter";
import { api, setSession, isAuthed } from "../api.js";

export default function Login() {
  const [mode, setMode] = useState("login");
  const [config, setConfig] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [plex, setPlex] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);
  const [, navigate] = useLocation();
  useEffect(() => { api("/auth/config", { suppressAuthRedirect: true }).then(setConfig).catch(() => setConfig({ registration_enabled: false })); return () => clearTimeout(pollRef.current); }, []);
  if (isAuthed()) return <Redirect to="/" />;

  async function submit(event) {
    event.preventDefault(); setBusy(true); setError("");
    try { const data = await api(`/auth/${mode}`, { method: "POST", body: { username, password, ...(inviteCode ? { invite_code: inviteCode } : {}) } }); setSession(data.user, data.csrf_token); navigate("/"); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function startProvider(provider) {
    setBusy(true); setError("");
    try {
      const data = await api(`/auth/provider/${provider}/start`, { method: "POST", suppressAuthRedirect: true, body: { action: "login", ...(inviteCode ? { invite_code: inviteCode } : {}) } });
      if (provider === "trakt") {
        window.location.assign(data.auth_url);
        return;
      }
      window.open(data.auth_url, "_blank", "noopener,noreferrer");
      setPlex({ state: data.state, servers: [] });
      pollPlex(data.state);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function pollPlex(state) {
    try {
      const data = await api(`/auth/provider/plex/poll?state=${encodeURIComponent(state)}`, { suppressAuthRedirect: true });
      if (data.pending) pollRef.current = setTimeout(() => pollPlex(state), 2000);
      else setPlex({ state, servers: data.servers });
    } catch (err) { setError(err.message); }
  }
  async function choosePlex(selectionId) {
    setBusy(true); setError("");
    try { const data = await api("/auth/provider/plex/complete", { method: "POST", suppressAuthRedirect: true, body: { state: plex.state, selection_id: selectionId } }); setSession(data.user, data.csrf_token); navigate("/"); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return <div className="auth-wrap">
    <div className="brand">REEL<em>SCORE</em></div><p className="auth-tagline">Every film you watch earns its place on the board.</p>
    <form onSubmit={submit} className="list">
      <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
      {mode === "register" && config?.registration_mode === "invite" && <input placeholder="Invite code" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} autoComplete="off" />}
      {error && <div className="error">{error}</div>}<button className="btn" disabled={busy}>{mode === "login" ? "Sign in" : "Create account"}</button>
    </form>
    {config?.registration_enabled && <button className="btn ghost" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}</button>}
    {config?.app_mode === "hosted" && <>
      <div className="list" style={{ marginTop: 16 }}>
        {config.plex_enabled && <button className="btn" disabled={busy} onClick={() => startProvider("plex")}>Continue with Plex</button>}
        {config.trakt_enabled && <button className="btn ghost" disabled={busy} onClick={() => startProvider("trakt")}>Continue with Trakt</button>}
        {config.registration_mode === "invite" && <input placeholder="Invite code for a new account" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} autoComplete="off" />}
      </div>
      {plex && plex.servers.length === 0 && <p className="muted">Approve Plex in the new tab, then return here. Waiting for an allowed server…</p>}
      {plex?.servers.map((server) => <button key={server.selection_id} className="btn ghost" disabled={busy} onClick={() => choosePlex(server.selection_id)}>Use {server.name}</button>)}
      <p className="muted">Provider identities are linked by their immutable account ID; ReelScore never matches accounts by email or display name.</p>
    </>}
  </div>;
}
