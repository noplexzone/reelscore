import React, { useEffect, useState } from "react";
import { Redirect, useLocation } from "wouter";
import { api, setSession, isAuthed } from "../api.js";

export default function Login() {
  const [mode, setMode] = useState("login");
  const [config, setConfig] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    api("/auth/config", { suppressAuthRedirect: true }).then(setConfig).catch(() => setConfig({ registration_enabled: false }));
  }, []);
  if (isAuthed()) return <Redirect to="/" />;

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const data = await api(`/auth/${mode}`, { method: "POST", body: { username, password, ...(inviteCode ? { invite_code: inviteCode } : {}) } });
      setSession(data.user, data.csrf_token);
      navigate("/");
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return <div className="auth-wrap">
    <div className="brand">REEL<em>SCORE</em></div>
    <p className="auth-tagline">Every film you watch earns its place on the board.</p>
    <form onSubmit={submit} className="list">
      <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
      {mode === "register" && config?.registration_mode === "invite" && <input placeholder="Invite code" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} autoComplete="off" />}
      {error && <div className="error">{error}</div>}
      <button className="btn" disabled={busy}>{mode === "login" ? "Sign in" : "Create account"}</button>
    </form>
    {config?.registration_enabled && <button className="btn ghost" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
      {mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
    </button>}
    {config?.app_mode === "hosted" && <p className="muted">New accounts require an invitation and provider sign-in.</p>}
  </div>;
}
