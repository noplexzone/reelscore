import React, { useEffect, useState } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { api, setSession, isAuthed } from "../api.js";

export default function Login() {
  const [mode, setMode] = useState("login");
  const [config, setConfig] = useState(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    api("/auth/config", { suppressAuthRedirect: true })
      .then(setConfig)
      .catch(() => setConfig({ registration_enabled: false }));
  }, []);

  if (isAuthed()) return <Redirect to="/" />;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = {
        username,
        password,
        ...(mode === "register" && config?.app_mode === "hosted" ? { email } : {}),
        ...(inviteCode ? { invite_code: inviteCode } : {}),
      };
      const data = await api(`/auth/${mode}`, {
        method: "POST",
        suppressAuthRedirect: true,
        body,
      });
      if (mode === "register" && !data.user) {
        setNotice(data.message || "Check your email to verify your account.");
        setMode("login");
        return;
      }
      setSession(data.user, data.csrf_token);
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const hostedRegistration = mode === "register" && config?.app_mode === "hosted";

  return <div className="auth-wrap">
    <div className="brand">REEL<em>SCORE</em></div>
    <p className="auth-tagline">Every film you watch earns its place on the board.</p>
    <form onSubmit={submit} className="list">
      <input
        placeholder="Username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        autoComplete="username"
        required
      />
      {hostedRegistration && <input
        placeholder="Email"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
        required
      />}
      <input
        placeholder="Password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        minLength={hostedRegistration ? 12 : 8}
        required
      />
      {mode === "register" && config?.registration_mode === "invite" && <input
        placeholder="Invite code"
        value={inviteCode}
        onChange={(event) => setInviteCode(event.target.value)}
        autoComplete="off"
        required
      />}
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      <button className="btn" disabled={busy}>
        {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
      </button>
    </form>
    {mode === "login" && config?.app_mode === "hosted" && <Link className="auth-link" to="/forgot-password">Forgot password?</Link>}
    {config?.registration_enabled && <button
      className="btn ghost"
      onClick={() => {
        setMode(mode === "login" ? "register" : "login");
        setError("");
        setNotice("");
      }}
    >
      {mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
    </button>}
    {config?.app_mode === "hosted" && <p className="muted auth-provider-note">
      Plex and Trakt are connected from account settings after email verification. They are not ReelScore login methods.
    </p>}
  </div>;
}
